/**
 * Memory Search
 *
 * Searches the memory graph using BM25 full-text search,
 * with optional filters for category, scope, salience,
 * and temporal validity.
 *
 * This is the "search tier" used by the recall pipeline
 * and also exposed directly via the qmemory_search tool.
 */

import { query, queryMulti } from "../db/client.js";
import { searchMemoriesBM25, searchMemoriesVector, getMemoriesForScope, getConnectionHints } from "../db/queries.js";
import { generateEmbedding } from "./embeddings.js";
import type { EmbeddingConfig } from "./embeddings.js";
import { consoleLogger } from "../config.js";
import type {
  RecalledMemory,
  RecallOptions,
  QmemoryLogger,
  MemoryCategory,
} from "../config.js";

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setSearchLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Search memories using BM25 full-text search with optional filters.
 *
 * @param options - Search parameters (query, categories, scope, etc.)
 * @returns Matching memories sorted by relevance then salience
 */
export async function searchMemories(
  options: RecallOptions,
  embeddingConfig?: EmbeddingConfig,
): Promise<RecalledMemory[]> {
  const {
    query: searchQuery,
    categories,
    scope = "any",
    min_salience = 0.0,
    valid_at,
    limit = 20,
  } = options;

  let results: RecalledMemory[] = [];

  // --- BM25 search if a query string is provided ---
  if (searchQuery && searchQuery.trim().length > 0) {
    logger.debug(`Search: BM25 query="${searchQuery}" scope=${scope}`);

    const prepared = searchMemoriesBM25(searchQuery, scope, min_salience, limit);
    const rows = await query<RecalledMemory>(prepared.surql, prepared.params);

    results = rows ?? [];
    logger.debug(`Search: BM25 returned ${results.length} results`);

    // Vector search augmentation — find semantically similar even if words differ
    if (embeddingConfig && embeddingConfig.provider !== "none") {
      try {
        const queryEmbedding = await generateEmbedding(searchQuery, embeddingConfig);
        if (queryEmbedding) {
          const vecQ = searchMemoriesVector(queryEmbedding, limit, scope);
          const vecRows = await query<RecalledMemory>(vecQ.surql, vecQ.params);
          if (vecRows && vecRows.length > 0) {
            // Merge: add vector results not already in BM25 results
            const existingIds = new Set(results.map((r) => String(r.id)));
            const newVec = vecRows.filter((r) => !existingIds.has(String(r.id)));
            results.push(...newVec);
            logger.debug(`Search: vector added ${newVec.length} new results`);
          }
        }
      } catch (e) {
        logger.debug(`Search: vector search failed (non-fatal): ${e}`);
      }
    }
  } else {
    // --- No query string: fall back to scope + salience filter ---
    logger.debug(`Search: scope filter scope=${scope} minSalience=${min_salience}`);

    const validAtStr = valid_at
      ? valid_at.toISOString()
      : new Date().toISOString();

    const prepared = getMemoriesForScope(scope, validAtStr, min_salience, limit);
    const rows = await query<RecalledMemory>(prepared.surql, prepared.params);

    results = rows ?? [];
    logger.debug(`Search: scope filter returned ${results.length} results`);
  }

  // --- Apply category filter (post-query, since SurrealQL handles one index at a time) ---
  if (categories && categories.length > 0) {
    const categorySet = new Set<MemoryCategory>(categories);
    results = results.filter((m) => categorySet.has(m.category));
    logger.debug(`Search: after category filter → ${results.length} results`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Connection Hints — enrich search results with graph edges
// ---------------------------------------------------------------------------

/** A connection hint attached to a search result */
export interface ConnectionHint {
  type: string;        // Edge type (from_book, supports, wrote, etc.)
  target_id: string;   // Target node ID
  target_name: string; // Human-readable name or snippet
  target_type: string; // Node type (book, person, memory, etc.)
  reason?: string;     // Why this connection exists
}

/** A search result enriched with connection hints */
export interface EnrichedMemory extends RecalledMemory {
  connections?: {
    total: number;
    hints: ConnectionHint[];
  };
}

/**
 * Enrich top N search results with connection hints from the graph.
 *
 * Design principle: "Visible Connections Drive Agent Behavior"
 * Show enough to trigger curiosity, not enough to overwhelm.
 *
 * @param results - Search results to enrich
 * @param topN - How many top results to enrich (default: 5)
 * @param maxHints - Max hints per result (default: 3)
 */
export async function enrichWithConnections(
  results: RecalledMemory[],
  topN: number = 5,
  maxHints: number = 3,
): Promise<EnrichedMemory[]> {
  if (results.length === 0) return results;

  // Only enrich top N results (graph queries have cost)
  const toEnrich = results.slice(0, topN);
  const memoryIds = toEnrich.map((r) => String(r.id));

  try {
    const hintsQuery = getConnectionHints(memoryIds);
    const rows = await query<{
      id: unknown;
      outgoing: Array<{ type: string; reason?: string; out: unknown; confidence?: number }>;
      incoming: Array<{ type: string; reason?: string; in: unknown; confidence?: number }>;
    }>(hintsQuery.surql, hintsQuery.params);

    if (!rows || rows.length === 0) return results;

    // Build a map of memory ID → raw edges
    const edgeMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    for (const row of rows) {
      edgeMap.set(String(row.id), {
        outgoing: row.outgoing ?? [],
        incoming: row.incoming ?? [],
      });
    }

    // Collect all target IDs we need to resolve names for
    const targetIds = new Set<string>();
    for (const [, edges] of edgeMap) {
      for (const e of edges.outgoing as Array<{ out: unknown }>) {
        if (e.out) targetIds.add(String(e.out));
      }
      for (const e of edges.incoming as Array<{ in: unknown }>) {
        if (e.in) targetIds.add(String(e.in));
      }
    }

    // Resolve target names (batch query for entities + memories)
    const nameMap = new Map<string, { name: string; type: string }>();
    if (targetIds.size > 0) {
      try {
        // Query entities and memories separately
        for (const tid of targetIds) {
          const table = tid.includes(":") ? tid.split(":")[0] : "memory";
          if (table === "entity") {
            const entRows = await query<{ id: unknown; name: string; type: string }>(
              `SELECT id, name, type FROM ${tid}`,
              {},
            );
            if (entRows?.[0]) {
              nameMap.set(tid, { name: entRows[0].name, type: entRows[0].type });
            }
          } else if (table === "memory") {
            const memRows = await query<{ id: unknown; content: string; category: string }>(
              `SELECT id, string::slice(content, 0, 80) AS content, category FROM ${tid}`,
              {},
            );
            if (memRows?.[0]) {
              nameMap.set(tid, { name: memRows[0].content, type: "memory" });
            }
          }
        }
      } catch {
        logger.debug("Search: name resolution failed (non-fatal)");
      }
    }

    // Build enriched results
    const enriched: EnrichedMemory[] = results.map((r, i) => {
      if (i >= topN) return r; // Leave non-top results as-is

      const mid = String(r.id);
      const edges = edgeMap.get(mid);
      if (!edges) return r;

      const allEdges: ConnectionHint[] = [];

      // Process outgoing edges
      for (const e of edges.outgoing as Array<{ type: string; reason?: string; out: unknown }>) {
        const targetId = String(e.out);
        const resolved = nameMap.get(targetId);
        allEdges.push({
          type: e.type || "related",
          target_id: targetId,
          target_name: resolved?.name || targetId,
          target_type: resolved?.type || "unknown",
          reason: e.reason,
        });
      }

      // Process incoming edges
      for (const e of edges.incoming as Array<{ type: string; reason?: string; in: unknown }>) {
        const sourceId = String(e.in);
        const resolved = nameMap.get(sourceId);
        allEdges.push({
          type: e.type || "related",
          target_id: sourceId,
          target_name: resolved?.name || sourceId,
          target_type: resolved?.type || "unknown",
          reason: e.reason,
        });
      }

      if (allEdges.length === 0) return r;

      return {
        ...r,
        connections: {
          total: allEdges.length,
          hints: allEdges.slice(0, maxHints),
        },
      };
    });

    return enriched;
  } catch (e) {
    logger.debug(`Search: connection enrichment failed (non-fatal): ${e}`);
    return results; // Graceful degradation — return flat results
  }
}

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

import { query } from "../db/client.js";
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

  const memoryIds = results.slice(0, topN).map((r) => String(r.id));

  try {
    // 1. Batch-fetch edges for all top results (single query)
    const hintsQuery = getConnectionHints(memoryIds);
    const rows = await query<{
      id: unknown;
      outgoing: Array<{ type: string; reason?: string; out: unknown }>;
      incoming: Array<{ type: string; reason?: string; in: unknown }>;
    }>(hintsQuery.surql, hintsQuery.params);

    if (!rows || rows.length === 0) return results;

    // 2. Collect all target node IDs from edges
    type RawEdge = { type: string; reason?: string; out?: unknown; in?: unknown };
    const edgeMap = new Map<string, RawEdge[]>();
    const targetIds = new Set<string>();

    for (const row of rows) {
      const mid = String(row.id);
      const edges: RawEdge[] = [];
      for (const e of row.outgoing ?? []) {
        if (e.out) { targetIds.add(String(e.out)); edges.push(e); }
      }
      for (const e of row.incoming ?? []) {
        if (e.in) { targetIds.add(String(e.in)); edges.push(e); }
      }
      if (edges.length > 0) edgeMap.set(mid, edges);
    }

    if (edgeMap.size === 0) return results;

    // 3. Batch-resolve names (2 queries instead of N — entities + memories)
    const nameMap = new Map<string, { name: string; type: string }>();
    const allIds = [...targetIds].slice(0, 50); // Cap to prevent pathological cases
    if (allIds.length > 0) {
      try {
        const entIds = allIds.filter((id) => id.startsWith("entity:"));
        const memIds = allIds.filter((id) => !id.startsWith("entity:"));

        const [entRows, memRows] = await Promise.all([
          entIds.length > 0
            ? query<{ id: unknown; name: string; type: string }>(
                "SELECT id, name, type FROM entity WHERE id IN $ids",
                { ids: entIds },
              )
            : Promise.resolve([]),
          memIds.length > 0
            ? query<{ id: unknown; content: string; category: string }>(
                "SELECT id, string::slice(content, 0, 80) AS content, category FROM memory WHERE id IN $ids",
                { ids: memIds },
              )
            : Promise.resolve([]),
        ]);

        for (const e of entRows ?? []) {
          nameMap.set(String(e.id), { name: e.name, type: e.type });
        }
        for (const m of memRows ?? []) {
          nameMap.set(String(m.id), { name: m.content, type: "memory" });
        }
      } catch {
        logger.debug("Search: name resolution failed (non-fatal)");
      }
    }

    // 4. Build enriched results
    return results.map((r, i) => {
      if (i >= topN) return r;

      const edges = edgeMap.get(String(r.id));
      if (!edges) return r;

      const hints: ConnectionHint[] = edges.slice(0, maxHints).map((e) => {
        const tid = String(e.out ?? e.in);
        const resolved = nameMap.get(tid);
        return {
          type: e.type || "related",
          target_id: tid,
          target_name: resolved?.name || tid,
          target_type: resolved?.type || "unknown",
          reason: e.reason,
        };
      });

      return {
        ...r,
        connections: { total: edges.length, hints },
      };
    });
  } catch (e) {
    logger.debug(`Search: connection enrichment failed (non-fatal): ${e}`);
    return results;
  }
}

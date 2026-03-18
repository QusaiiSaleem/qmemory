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
import { searchMemoriesBM25, searchMemoriesVector, getMemoriesForScope } from "../db/queries.js";
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
          const vecQ = searchMemoriesVector(queryEmbedding, limit);
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

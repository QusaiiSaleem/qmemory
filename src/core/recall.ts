/**
 * 4-Tier Recall Pipeline
 *
 * The recall pipeline is the heart of Qmemory's search.
 * It runs four tiers in priority order, merges results,
 * deduplicates by ID, and trims to fit the token budget.
 *
 * Tiers:
 *   1. Graph-linked — traverse 'relates' edges from session entities
 *   2. BM25 search — full-text search on memory content
 *   3. Category filter — filter by memory category
 *   4. Recent fallback — last N memories by created_at
 *
 * Each tier adds results the previous tiers missed.
 * Final output is sorted by salience DESC and token-budgeted.
 */

import { query } from "../db/client.js";
import { getRecentMemories } from "../db/queries.js";
import { searchMemories } from "./search.js";
import { fitToTokenBudget, consoleLogger } from "../config.js";
import type {
  RecalledMemory,
  RecallOptions,
  QmemoryLogger,
} from "../config.js";

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setRecallLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many memories to fetch in the "recent fallback" tier */
const RECENT_FALLBACK_LIMIT = 15;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the 4-tier recall pipeline for a given session.
 *
 * @param sessionKey - The current session key (e.g. "agent:main:telegram:...")
 * @param options    - Recall options (query, categories, scope, budget, etc.)
 * @returns Deduplicated, salience-sorted, token-budgeted memories
 */
export async function recall(
  optionsOrSessionKey: RecallOptions | string,
  maybeOptions?: RecallOptions,
): Promise<RecalledMemory[]> {
  // Support both recall(options) and recall(sessionKey, options)
  const options: RecallOptions = typeof optionsOrSessionKey === "string"
    ? (maybeOptions ?? {})
    : optionsOrSessionKey;
  const sessionKey = typeof optionsOrSessionKey === "string"
    ? optionsOrSessionKey
    : undefined;
  const collected: RecalledMemory[] = [];
  const targetCount = options.limit ?? 20;

  // --- Tier 1: Graph-linked memories ---
  // Traverse 'relates' edges from entities mentioned in the current session
  const graphMemories = sessionKey ? await fetchGraphLinked(sessionKey) : [];
  collected.push(...graphMemories);
  logger.debug(`Recall tier 1 (graph): ${graphMemories.length} memories`);

  // --- Tier 2: BM25 full-text search (skip if Tier 1 has plenty) ---
  if (options.query && collected.length < targetCount * 1.5) {
    const searchResults = await searchMemories(options);
    collected.push(...searchResults);
    logger.debug(`Recall tier 2 (BM25): ${searchResults.length} memories`);
  }

  // --- Tier 3: Category filter (skip if already have enough) ---
  if (options.categories && options.categories.length > 0 && collected.length < targetCount * 1.5) {
    const categoryResults = await searchMemories({
      ...options,
      query: undefined, // No text search — just category filter
    });
    collected.push(...categoryResults);
    logger.debug(`Recall tier 3 (category): ${categoryResults.length} memories`);
  }

  // --- Tier 4: Recent fallback (skip if already have enough) ---
  if (collected.length < targetCount) {
    const recentResults = await fetchRecent();
    collected.push(...recentResults);
    logger.debug(`Recall tier 4 (recent): ${recentResults.length} memories`);
  }

  // --- Merge: deduplicate by ID ---
  const deduped = deduplicateById(collected);
  logger.debug(`Recall merged: ${deduped.length} unique memories`);

  // --- Sort by salience DESC (most important first) ---
  deduped.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));

  // --- Apply token budget if provided ---
  if (options.token_budget && options.token_budget > 0) {
    const fitted = fitToTokenBudget(deduped, options.token_budget);
    logger.info(
      `Recall: ${fitted.length}/${deduped.length} memories fit in ${options.token_budget} token budget`,
    );
    return fitted;
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

/**
 * Tier 1: Find memories linked via graph edges to the current session's entities.
 * Traverses: session → relates → entity → relates → memory
 */
async function fetchGraphLinked(sessionKey: string): Promise<RecalledMemory[]> {
  // Find memories connected to entities that relate to this session
  const surql = `
    SELECT * FROM memory
    WHERE is_active = true
      AND id IN (
        SELECT VALUE ->relates->memory FROM session
        WHERE session_key = $sessionKey
      )[0]
      AND (valid_until IS NONE OR valid_until > time::now())
    ORDER BY salience DESC
    LIMIT 20;
  `;

  const rows = await query<RecalledMemory>(surql, { sessionKey });
  return rows ?? [];
}

/** Tier 4: Get the most recent active memories as a fallback */
async function fetchRecent(): Promise<RecalledMemory[]> {
  const prepared = getRecentMemories(RECENT_FALLBACK_LIMIT);
  const rows = await query<RecalledMemory>(prepared.surql, prepared.params);
  return rows ?? [];
}

// ---------------------------------------------------------------------------
// Dedup helper
// ---------------------------------------------------------------------------

/** Remove duplicate memories by ID, keeping the first occurrence */
function deduplicateById(memories: RecalledMemory[]): RecalledMemory[] {
  const seen = new Set<string>();
  const unique: RecalledMemory[] = [];

  for (const mem of memories) {
    if (!seen.has(mem.id)) {
      seen.add(mem.id);
      unique.push(mem);
    }
  }

  return unique;
}

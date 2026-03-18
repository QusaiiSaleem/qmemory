/**
 * Save Memory with Deduplication
 *
 * When saving a new memory, we first check if it duplicates
 * or supersedes an existing one using the dedup pipeline:
 *
 *   1. BM25 search for similar existing memories (top 5)
 *   2. Run dedup() to get ADD / UPDATE / NOOP decision
 *   3. For ADD:    CREATE a new memory node
 *   4. For UPDATE: soft-delete old → CREATE new with prev_version link
 *   5. For NOOP:   skip (already known)
 *
 * Soft-delete = set is_active to false (never hard-delete).
 */

import { query, generateId } from "../db/client.js";
import { searchMemoriesBM25 } from "../db/queries.js";
import { dedup } from "./dedup.js";
import { consoleLogger } from "../config.js";
import type {
  Memory,
  MemoryCategory,
  DedupAction,
  QmemoryLogger,
} from "../config.js";
import type { SubagentRunner } from "./dedup.js";

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setSaveLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SaveParams {
  content: string;
  category: MemoryCategory;
  salience?: number;
  scope?: string;
  source_type?: Memory["source_type"];
}

export interface SaveResult {
  action: DedupAction;
  memory_id: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Save a memory with deduplication.
 *
 * @param params          - The memory content, category, and optional metadata
 * @param subagentRunner  - Optional LLM function for smart dedup
 * @returns The action taken (ADD/UPDATE/NOOP) and the memory ID
 */
export async function saveMemory(
  params: SaveParams,
  subagentRunner?: SubagentRunner,
): Promise<SaveResult> {
  const {
    content,
    category,
    salience = 0.5,
    scope = "global",
    source_type = "conversation",
  } = params;

  // --- Step 1: Search for similar existing memories ---
  const searchQ = searchMemoriesBM25(content, "any", 0.0, 5);
  const existing = await query<Memory>(searchQ.surql, searchQ.params);
  const candidates = existing ?? [];

  logger.debug(`Save: found ${candidates.length} candidates for dedup`);

  // --- Step 2: Run dedup to decide what to do ---
  const decision = await dedup(content, candidates, subagentRunner);
  logger.info(`Save: dedup decision = ${decision.action} (confidence: ${decision.confidence})`);

  // --- Step 3: Execute the decision ---

  if (decision.action === "NOOP") {
    // Already known — return the existing memory ID
    const existingId = decision.target_id ?? candidates[0]?.id ?? "";
    logger.debug(`Save: NOOP — memory already exists as ${existingId}`);
    return { action: "NOOP", memory_id: existingId };
  }

  if (decision.action === "UPDATE" && decision.target_id) {
    // Soft-delete the old memory
    await query(
      `UPDATE type::record($oldId) SET is_active = false, updated_at = time::now();`,
      { oldId: decision.target_id },
    );
    logger.debug(`Save: soft-deleted old memory ${decision.target_id}`);

    // Create the new memory with prev_version pointing to old
    const newId = generateId("memory:");
    await query(
      `CREATE type::record($newId) CONTENT {
        content: $content,
        category: $category,
        salience: $salience,
        scope: $scope,
        is_active: true,
        confidence: $confidence,
        source_type: $sourceType,
        prev_version: type::record($prevVersion),
        created_at: time::now(),
        updated_at: time::now()
      };`,
      {
        newId,
        content,
        category,
        salience,
        scope,
        confidence: decision.confidence,
        sourceType: source_type,
        prevVersion: decision.target_id,
      },
    );

    // Also create a prev_version edge for graph traversal
    await query(
      `RELATE $newId->prev_version->$oldId;`,
      { newId, oldId: decision.target_id },
    );

    logger.info(`Save: UPDATE — created ${newId} replacing ${decision.target_id}`);
    return { action: "UPDATE", memory_id: newId };
  }

  // --- ADD: create a brand new memory ---
  const newId = generateId("memory:");
  await query(
    `CREATE type::record($newId) CONTENT {
      content: $content,
      category: $category,
      salience: $salience,
      scope: $scope,
      is_active: true,
      confidence: 0.8,
      source_type: $sourceType,
      created_at: time::now(),
      updated_at: time::now()
    };`,
    {
      newId,
      content,
      category,
      salience,
      scope,
      sourceType: source_type,
    },
  );

  logger.info(`Save: ADD — created new memory ${newId}`);
  return { action: "ADD", memory_id: newId };
}

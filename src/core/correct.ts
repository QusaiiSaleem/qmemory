/**
 * Memory Correction & Deletion
 *
 * Two operations:
 *   "correct" — Soft-delete the old memory, create a new one
 *               with the corrected content and a prev_version link.
 *               Preserves the old category and salience unless overridden.
 *
 *   "delete"  — Soft-delete the memory (set is_active = false).
 *               The memory stays in SurrealDB for audit trail.
 *
 * We NEVER hard-delete. All changes are versioned.
 */

import { query, generateId } from "../db/client.js";
import { consoleLogger } from "../config.js";
import type { Memory, QmemoryLogger } from "../config.js";

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setCorrectLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrectParams {
  memory_id: string;
  action: "correct" | "delete" | "update" | "unlink";
  new_content?: string;
  /** For "update": change metadata without creating a new version */
  salience?: number;
  scope?: string;
  valid_until?: string;  // ISO datetime — mark fact as expired
  /** For "unlink": remove a specific relationship edge */
  edge_id?: string;
}

export interface CorrectResult {
  ok: boolean;
  new_memory_id?: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Correct or delete a memory.
 *
 * @param params - The memory ID, action ("correct" or "delete"), and optional new content
 * @returns Whether the operation succeeded, plus new memory ID for corrections
 */
export async function correctMemory(
  params: CorrectParams,
): Promise<CorrectResult> {
  const { memory_id, action, new_content } = params;

  // --- Fetch the existing memory so we can copy its metadata ---
  const rows = await query<Memory>(
    `SELECT * FROM type::thing($memoryId) WHERE is_active = true LIMIT 1;`,
    { memoryId: memory_id },
  );

  const existing = rows?.[0];
  if (!existing) {
    logger.warn(`Correct: memory ${memory_id} not found or already inactive`);
    return { ok: false };
  }

  // --- Delete: just soft-delete ---
  if (action === "delete") {
    await query(
      `UPDATE type::thing($memoryId) SET is_active = false, updated_at = time::now();`,
      { memoryId: memory_id },
    );
    logger.info(`Correct: soft-deleted memory ${memory_id}`);
    return { ok: true };
  }

  // --- Update: change metadata WITHOUT creating a new version ---
  if (action === "update") {
    const updates: string[] = [];
    const updateParams: Record<string, unknown> = { memoryId: memory_id };

    if (params.salience !== undefined) {
      updates.push("salience = $salience");
      updateParams.salience = params.salience;
    }
    if (params.scope !== undefined) {
      updates.push("scope = $scope");
      updateParams.scope = params.scope;
    }
    if (params.valid_until !== undefined) {
      updates.push("valid_until = $validUntil");
      updateParams.validUntil = params.valid_until;
    }
    if (params.new_content !== undefined) {
      updates.push("content = $newContent");
      updateParams.newContent = params.new_content;
    }

    if (updates.length === 0) {
      logger.warn("Correct: action is 'update' but no fields to change");
      return { ok: false };
    }

    updates.push("updated_at = time::now()");
    await query(
      `UPDATE type::thing($memoryId) SET ${updates.join(", ")};`,
      updateParams,
    );
    logger.info(`Correct: updated ${memory_id} fields: ${updates.join(", ")}`);
    return { ok: true };
  }

  // --- Unlink: remove a relationship edge ---
  if (action === "unlink") {
    if (!params.edge_id) {
      logger.warn("Correct: action is 'unlink' but no edge_id provided");
      return { ok: false };
    }
    await query(
      `DELETE type::thing($edgeId);`,
      { edgeId: params.edge_id },
    );
    logger.info(`Correct: deleted edge ${params.edge_id}`);
    return { ok: true };
  }

  // --- Correct: soft-delete old + create new with prev_version ---
  if (!new_content || new_content.trim().length === 0) {
    logger.warn("Correct: action is 'correct' but no new_content provided");
    return { ok: false };
  }

  // Soft-delete the old memory
  await query(
    `UPDATE type::thing($memoryId) SET is_active = false, updated_at = time::now();`,
    { memoryId: memory_id },
  );

  // Create the corrected version, keeping old category and salience
  const newId = generateId("memory:");
  await query(
    `CREATE type::thing($newId) CONTENT {
      content: $newContent,
      category: $category,
      salience: $salience,
      scope: $scope,
      is_active: true,
      confidence: 0.9,
      source_type: "conversation",
      prev_version: type::thing($prevVersion),
      created_at: time::now(),
      updated_at: time::now()
    };`,
    {
      newId,
      newContent: new_content,
      category: existing.category,
      salience: existing.salience,
      scope: existing.scope,
      prevVersion: memory_id,
    },
  );

  // Create the prev_version edge
  await query(
    `RELATE type::thing($newId)->prev_version->type::thing($oldId);`,
    { newId, oldId: memory_id },
  );

  logger.info(`Correct: created ${newId} as correction of ${memory_id}`);
  return { ok: true, new_memory_id: newId };
}

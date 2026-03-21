/**
 * Qmemory Session Scratchpad — Working Memory
 *
 * A per-session record that tracks current task state:
 * progress, findings, open questions, and tool summary.
 *
 * Lives in the `scratchpad` table with a UNIQUE index on session.
 */

import { query } from "../db/client.js";
import type { Scratchpad, QmemoryLogger } from "../config.js";

/** Extract ID from string or RecordId: "session:s1234" → "s1234" */
function sessionIdPart(fullId: unknown): string {
  const str = String(fullId);
  const idx = str.indexOf(":");
  return idx >= 0 ? str.slice(idx + 1) : str;
}

let logger: QmemoryLogger | null = null;

export function setScratchpadLogger(l: QmemoryLogger): void {
  logger = l;
}

/**
 * Get the scratchpad for a session, or null if none exists.
 */
export async function getScratchpad(sessionId: string): Promise<Scratchpad | null> {
  try {
    const results = await query<Scratchpad>(
      'SELECT * FROM scratchpad WHERE session = type::record("session", $sessionId) LIMIT 1',
      { sessionId: sessionIdPart(sessionId) },
    );
    return results?.[0] ?? null;
  } catch (error) {
    logger?.debug(`getScratchpad failed: ${error}`);
    return null;
  }
}

/**
 * Update (upsert) the scratchpad for a session.
 * Only non-empty string fields are written — empty strings are skipped.
 */
export async function updateScratchpad(
  sessionId: string,
  updates: Partial<Pick<Scratchpad, "task_progress" | "key_findings" | "open_questions" | "tool_summary">>,
): Promise<void> {
  try {
    // Atomic upsert — no race condition between SELECT and CREATE.
    // UPSERT by session, merge only non-empty fields.
    const setClauses: string[] = ['session = type::record("session", $sessionId)', "updated_at = time::now()"];
    const params: Record<string, unknown> = { sessionId: sessionIdPart(sessionId) };

    if (updates.task_progress !== undefined && updates.task_progress.length > 0) {
      setClauses.push("task_progress = $taskProgress");
      params.taskProgress = updates.task_progress;
    }
    if (updates.key_findings !== undefined && updates.key_findings.length > 0) {
      setClauses.push("key_findings = $keyFindings");
      params.keyFindings = updates.key_findings;
    }
    if (updates.open_questions !== undefined && updates.open_questions.length > 0) {
      setClauses.push("open_questions = $openQuestions");
      params.openQuestions = updates.open_questions;
    }
    if (updates.tool_summary !== undefined && updates.tool_summary.length > 0) {
      setClauses.push("tool_summary = $toolSummary");
      params.toolSummary = updates.tool_summary;
    }

    // SurrealDB best practice: UPSERT with unique index is much faster than
    // SELECT-then-CREATE/UPDATE. The idx_scratchpad_session UNIQUE index makes
    // this a single indexed operation instead of 2-3 queries.
    await query(
      `UPSERT scratchpad SET ${setClauses.join(", ")} WHERE session = type::record("session", $sessionId)`,
      params,
    );
  } catch (error) {
    logger?.debug(`updateScratchpad failed: ${error}`);
  }
}

/**
 * Clear (delete) the scratchpad for a session.
 */
export async function clearScratchpad(sessionId: string): Promise<void> {
  try {
    await query(
      'DELETE scratchpad WHERE session = type::record("session", $sessionId)',
      { sessionId: sessionIdPart(sessionId) },
    );
  } catch (error) {
    logger?.debug(`clearScratchpad failed: ${error}`);
  }
}

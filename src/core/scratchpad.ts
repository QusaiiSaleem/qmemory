/**
 * Qmemory Session Scratchpad — Working Memory
 *
 * A per-session record that tracks current task state:
 * progress, findings, open questions, and tool summary.
 *
 * Lives in the `scratchpad` table with a UNIQUE index on session.
 */

import { query, generateId } from "../db/client.js";
import type { Scratchpad, QmemoryLogger } from "../config.js";

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
      "SELECT * FROM scratchpad WHERE session = $session LIMIT 1",
      { session: sessionId },
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
    // Check if a scratchpad already exists
    const existing = await getScratchpad(sessionId);

    if (existing) {
      // Build SET clauses only for non-empty fields
      const setClauses: string[] = ["updated_at = time::now()"];
      const params: Record<string, unknown> = { id: existing.id };

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

      if (setClauses.length > 1) { // More than just updated_at
        await query(
          `UPDATE $id SET ${setClauses.join(", ")}`,
          params,
        );
      }
    } else {
      // Create new scratchpad
      const idPart = generateId("sp");
      await query(
        `CREATE type::record("scratchpad", $idPart) CONTENT {
          session: $session,
          task_progress: $taskProgress,
          key_findings: $keyFindings,
          open_questions: $openQuestions,
          tool_summary: $toolSummary,
          updated_at: time::now()
        }`,
        {
          idPart,
          session: sessionId,
          taskProgress: updates.task_progress ?? "",
          keyFindings: updates.key_findings ?? "",
          openQuestions: updates.open_questions ?? "",
          toolSummary: updates.tool_summary ?? "",
        },
      );
    }
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
      "DELETE scratchpad WHERE session = $session",
      { session: sessionId },
    );
  } catch (error) {
    logger?.debug(`clearScratchpad failed: ${error}`);
  }
}

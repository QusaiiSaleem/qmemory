/**
 * Qmemory Hook Handlers
 *
 * All OpenClaw lifecycle hooks registered via api.on().
 * Separated from index.ts to keep the entry point clean.
 *
 * Hooks:
 *   after_tool_call    — log every tool call to the ledger
 *   tool_result_persist — compress large tool results before storage
 */

import { query, generateId } from "../db/client.js";
import { estimateTokens } from "../config.js";
import type { QmemoryLogger } from "../config.js";

// ---------------------------------------------------------------------------
// Shared state — engine updates this, hooks read it
// ---------------------------------------------------------------------------

export interface SharedEngineState {
  currentSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Summarization helpers (rule-based, no LLM needed)
// ---------------------------------------------------------------------------

/**
 * Compress tool input params to a short summary (max 100 chars).
 * Extracts key values from JSON, strips noise.
 */
function summarizeInput(params: Record<string, unknown>): string {
  try {
    // Extract meaningful values, skip metadata
    const parts: string[] = [];
    for (const [key, val] of Object.entries(params)) {
      if (val === null || val === undefined) continue;
      const str = typeof val === "string" ? val : JSON.stringify(val);
      // Skip very long values, just note the key
      if (str.length > 60) {
        parts.push(`${key}:[${str.length} chars]`);
      } else {
        parts.push(`${key}:${str}`);
      }
    }
    const joined = parts.join(", ");
    return joined.length > 100 ? joined.slice(0, 97) + "..." : joined;
  } catch {
    return "[params]";
  }
}

/**
 * Compress tool result to a short summary (max 200 chars).
 * Extracts key info, drops JSON noise.
 */
function summarizeOutput(result: unknown): string {
  try {
    if (result === null || result === undefined) return "[no output]";

    // Handle error results
    if (typeof result === "object" && result !== null && "error" in (result as Record<string, unknown>)) {
      const errMsg = String((result as Record<string, unknown>).error);
      return errMsg.length > 200 ? errMsg.slice(0, 197) + "..." : errMsg;
    }

    // Handle content array (standard tool result format)
    if (typeof result === "object" && result !== null && "content" in (result as Record<string, unknown>)) {
      const content = (result as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const text = content
          .filter((c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
          .map((c: unknown) => String((c as Record<string, unknown>).text ?? ""))
          .join(" ");
        if (text.length > 200) return text.slice(0, 197) + "...";
        return text || "[empty]";
      }
    }

    // Fallback: stringify and trim
    const str = typeof result === "string" ? result : JSON.stringify(result);
    return str.length > 200 ? str.slice(0, 197) + "..." : str;
  } catch {
    return "[output]";
  }
}

// ---------------------------------------------------------------------------
// after_tool_call handler — logs tool calls to the ledger
// ---------------------------------------------------------------------------

export function createAfterToolCallHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      toolName: string;
      params: Record<string, unknown>;
      result?: unknown;
      error?: string;
      durationMs?: number;
    },
    _ctx: {
      agentId?: string;
      sessionKey?: string;
      sessionId?: string;
      toolName: string;
    },
  ): Promise<void> => {
    // Skip if no active session
    if (!sharedState.currentSessionId) return;

    try {
      const inputSummary = summarizeInput(event.params);
      const outputSummary = event.error
        ? `ERROR: ${event.error.slice(0, 180)}`
        : summarizeOutput(event.result);
      const tokenCount = estimateTokens(outputSummary);

      const idPart = generateId("tc");
      await query(
        `CREATE type::record("tool_call", $idPart) CONTENT {
          session: $session,
          tool_name: $toolName,
          input_summary: $inputSummary,
          output_summary: $outputSummary,
          duration_ms: $durationMs,
          token_count: $tokenCount,
          created_at: time::now()
        }`,
        {
          idPart,
          session: sharedState.currentSessionId,
          toolName: event.toolName,
          inputSummary,
          outputSummary,
          durationMs: event.durationMs ?? null,
          tokenCount,
        },
      );

      logger.debug(`Tool ledger: ${event.toolName} (${event.durationMs ?? "?"}ms)`);
    } catch (error) {
      // Fire-and-forget — never block the agent loop
      logger.debug(`Tool ledger write failed: ${error}`);
    }
  };
}

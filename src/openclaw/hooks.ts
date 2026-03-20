/**
 * Qmemory Hook Handlers
 *
 * All OpenClaw lifecycle hooks registered via api.on().
 * Separated from index.ts to keep the entry point clean.
 *
 * Hooks:
 *   after_tool_call    — log every tool call to the ledger
 *   tool_result_persist — compress large tool results before storage
 *
 * NOTE on after_tool_call: OpenClaw fires this hook and tracks tool calls
 * internally, but does NOT expose a queryable API for plugins to read
 * past tool calls. Our hook saves a compressed summary to SurrealDB's
 * tool_call table so that assemble() can inject a ledger into context.
 * This is the only way to give the agent visibility into its own tool
 * history across turns. Not duplication — complementary persistence.
 */

import { query, generateId } from "../db/client.js";
import { estimateTokens } from "../config.js";
import { trackEvent } from "../core/metrics.js";
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
      // Build params — omit duration_ms if undefined (SurrealDB 3.0 rejects NULL for option<int>)
      const params: Record<string, unknown> = {
        idPart,
        session: sharedState.currentSessionId,
        toolName: event.toolName,
        inputSummary,
        outputSummary,
        tokenCount,
      };
      const durationField = event.durationMs !== undefined ? "duration_ms: $durationMs," : "";
      if (event.durationMs !== undefined) params.durationMs = event.durationMs;

      await query(
        `CREATE type::record("tool_call", $idPart) CONTENT {
          session: $session,
          tool_name: $toolName,
          input_summary: $inputSummary,
          output_summary: $outputSummary,
          ${durationField}
          token_count: $tokenCount,
          created_at: time::now()
        }`,
        params,
      );

      logger.info(`Tool ledger: ${event.toolName} (${event.durationMs ?? "?"}ms)`);

      // Track tool_call metric (fire-and-forget)
      trackEvent(sharedState.currentSessionId!, "tool_call", event.toolName).catch(() => {});
    } catch (error) {
      // Fire-and-forget — never block the agent loop
      logger.debug(`Tool ledger write failed: ${error}`);
    }
  };
}

// ---------------------------------------------------------------------------
// tool_result_persist handler — compress large tool results before storage
// NOTE: This hook is SYNCHRONOUS (OpenClaw ignores returned Promises)
// ---------------------------------------------------------------------------

/** Tool names whose results should never be compressed */
const NEVER_COMPRESS = new Set([
  "qmemory_search",
  "qmemory_save",
  "qmemory_correct",
  "qmemory_link",
  "qmemory_import",
  "qmemory_person",
]);

/** Token threshold — only compress results larger than this */
const COMPRESS_THRESHOLD_TOKENS = 500;

/**
 * Compress a JSON string: extract top-level keys, truncate arrays.
 */
function compressJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return text;

    if (Array.isArray(parsed)) {
      // Truncate arrays: first 3 items + count
      const preview = parsed.slice(0, 3);
      const suffix = parsed.length > 3 ? `\n... and ${parsed.length - 3} more items` : "";
      return JSON.stringify(preview, null, 1) + suffix;
    }

    // Object: keep top-level keys, truncate nested values
    const compressed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "string" && val.length > 200) {
        compressed[key] = val.slice(0, 200) + "...";
      } else if (Array.isArray(val) && val.length > 3) {
        compressed[key] = [...val.slice(0, 3), `... ${val.length - 3} more`];
      } else {
        compressed[key] = val;
      }
    }
    return JSON.stringify(compressed, null, 1);
  } catch {
    // Not valid JSON — fall through to text compression
    return text;
  }
}

/**
 * Compress text: first 200 chars + last 100 chars with ellipsis.
 */
function compressText(text: string): string {
  if (text.length <= 400) return text;
  return text.slice(0, 200) + "\n...\n" + text.slice(-100);
}

export function createToolResultPersistHandler(logger: QmemoryLogger) {
  return (
    event: {
      toolName?: string;
      toolCallId?: string;
      message: Record<string, unknown>;
      isSynthetic?: boolean;
    },
    _ctx: {
      agentId?: string;
      sessionKey?: string;
      toolName?: string;
      toolCallId?: string;
    },
  ): { message?: Record<string, unknown> } | void => {
    try {
      const toolName = event.toolName ?? _ctx.toolName ?? "";

      // Never compress our own tools
      if (NEVER_COMPRESS.has(toolName)) return;

      // Extract text content from the message
      const message = event.message;
      const content = message?.content;
      if (!Array.isArray(content)) return;

      // Estimate total tokens across all text blocks
      let totalText = "";
      for (const block of content) {
        if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
          totalText += String((block as Record<string, unknown>).text ?? "");
        }
      }

      const originalTokens = estimateTokens(totalText);
      if (originalTokens <= COMPRESS_THRESHOLD_TOKENS) return;

      // Check if it looks like an error — keep errors intact (usually short)
      if (totalText.includes("Error:") || totalText.includes("error:")) {
        if (originalTokens < 1000) return; // Short errors stay as-is
      }

      // Compress the text content
      const newContent = content.map((block: unknown) => {
        if (typeof block !== "object" || block === null) return block;
        const b = block as Record<string, unknown>;
        if (b.type !== "text") return block;

        const text = String(b.text ?? "");
        if (estimateTokens(text) <= COMPRESS_THRESHOLD_TOKENS) return block;

        // Try JSON compression first, then text compression
        let compressed: string;
        const trimmed = text.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          compressed = compressJson(trimmed);
        } else {
          compressed = compressText(text);
        }

        compressed = `[compressed from ${originalTokens} tokens]\n${compressed}`;
        return { ...b, text: compressed };
      });

      const compressedTokens = estimateTokens(
        newContent
          .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
          .map((b: unknown) => String((b as Record<string, unknown>).text ?? ""))
          .join(""),
      );

      logger.debug(
        `Compressed ${toolName}: ${originalTokens} → ${compressedTokens} tokens (${Math.round((1 - compressedTokens / originalTokens) * 100)}% reduction)`,
      );

      return {
        message: { ...message, content: newContent },
      };
    } catch (error) {
      // Non-fatal — return void to keep original message
      logger.debug(`Tool result compression failed: ${error}`);
    }
  };
}

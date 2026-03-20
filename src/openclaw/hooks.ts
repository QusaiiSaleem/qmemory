/**
 * Qmemory Hook Handlers
 *
 * All OpenClaw lifecycle hooks registered via api.on().
 * Separated from index.ts to keep the entry point clean.
 *
 * Hooks:
 *   after_tool_call     — log every tool call to the ledger
 *   tool_result_persist — compress large tool results before storage
 *   agent_end           — capture cron/subagent outcomes as memories
 *   llm_output          — track token usage per turn
 *   subagent_spawned    — create session→spawned→session graph edge
 *   subagent_ended      — capture child outcome + summary memory
 *   session_start       — track session lifecycle
 *   session_end         — session duration + message count
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
  /** Last known delivery target — set by message_sent hook, read by agent_end */
  lastDeliveryTarget: string | null;
  /** Current model name — set by llm_output hook, shown in session header */
  currentModel: string | null;
}

/**
 * Extract just the ID part from a SurrealDB record reference.
 * Handles both strings ("session:s1234") and RecordId objects from the SDK.
 * Returns just the ID part: "s1234abc"
 */
function sessionIdPart(fullId: unknown): string {
  const str = String(fullId); // RecordId.toString() → "session:s1234"
  const idx = str.indexOf(":");
  return idx >= 0 ? str.slice(idx + 1) : str;
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
    // Use console.error to bypass logger filtering — this MUST appear in logs
    console.error(`[QMEMORY-HOOK-DIAG] after_tool_call FIRED: tool=${event.toolName} sessionId=${sharedState.currentSessionId ?? "NULL"}`);

    // Skip if no active session
    if (!sharedState.currentSessionId) {
      console.error(`[QMEMORY-HOOK-DIAG] SKIPPED — no session ID`);
      return;
    }

    try {
      console.error(`[QMEMORY-HOOK-DIAG] step1: summarizing`);
      const inputSummary = summarizeInput(event.params);
      const outputSummary = event.error
        ? `ERROR: ${event.error.slice(0, 180)}`
        : summarizeOutput(event.result);
      const tokenCount = estimateTokens(outputSummary);
      const sid = sessionIdPart(sharedState.currentSessionId);

      console.error(`[QMEMORY-HOOK-DIAG] step2: building query (sid=${sid})`);
      const idPart = generateId("tc");
      const params: Record<string, unknown> = {
        idPart,
        sessionId: sid,
        toolName: event.toolName,
        inputSummary,
        outputSummary,
        tokenCount,
      };
      if (event.durationMs !== undefined) {
        params.durationMs = event.durationMs;
      }

      // Build query — conditionally include duration_ms
      const durationField = event.durationMs !== undefined ? "duration_ms: $durationMs," : "";

      console.error(`[QMEMORY-HOOK-DIAG] step3: calling query()`);
      const result = await query(
        `CREATE type::record("tool_call", $idPart) CONTENT {
          session: type::record("session", $sessionId),
          tool_name: $toolName,
          input_summary: $inputSummary,
          output_summary: $outputSummary,
          ${durationField}
          token_count: $tokenCount,
          created_at: time::now()
        }`,
        params,
      );
      console.error(`[QMEMORY-HOOK-DIAG] step4: result=${result ? "OK" : "NULL"}`);

      // Track tool_call metric (fire-and-forget)
      trackEvent(sharedState.currentSessionId!, "tool_call", event.toolName).catch(() => {});
    } catch (error) {
      console.error(`[QMEMORY-HOOK-DIAG] CATCH: ${error}`);
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

// ---------------------------------------------------------------------------
// agent_end handler — capture cron/subagent run outcomes
// ---------------------------------------------------------------------------

export function createAgentEndHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      messages: unknown[];
      success: boolean;
      error?: string;
      durationMs?: number;
    },
    ctx: {
      agentId?: string;
      sessionKey?: string;
      sessionId?: string;
      trigger?: string; // "user" | "cron" | "heartbeat" | "memory"
      channelId?: string;
    },
  ): Promise<void> => {
    // Only capture non-user triggers (cron, heartbeat, memory)
    if (!ctx.trigger || ctx.trigger === "user") return;
    if (!sharedState.currentSessionId) return;

    try {
      // Extract the last assistant message as the outcome summary
      const lastAssistant = [...event.messages].reverse().find(
        (m: any) => m?.role === "assistant",
      ) as { content: unknown } | undefined;

      let summary = ctx.trigger;
      if (lastAssistant) {
        // Extract text from content blocks
        const content = lastAssistant.content;
        if (typeof content === "string") {
          summary = content.slice(0, 300);
        } else if (Array.isArray(content)) {
          summary = content
            .filter((b: any) => b?.type === "text")
            .map((b: any) => b.text)
            .join(" ")
            .slice(0, 300);
        }
      }

      const status = event.success ? "OK" : `ERROR: ${event.error?.slice(0, 100) ?? "unknown"}`;
      const duration = event.durationMs ? `${Math.round(event.durationMs / 1000)}s` : "?";

      // Save as memory with source_type matching the trigger
      const idPart = generateId("mem");
      const sid = sessionIdPart(sharedState.currentSessionId);
      await query(
        `CREATE type::record("memory", $idPart) CONTENT {
          content: $content,
          category: "context",
          salience: $salience,
          scope: "global",
          is_active: true,
          confidence: 0.8,
          source_type: $sourceType,
          created_at: time::now(),
          updated_at: time::now()
        }`,
        {
          idPart,
          content: sharedState.lastDeliveryTarget
            ? `[${ctx.trigger} → ${sharedState.lastDeliveryTarget}] ${status} (${duration}): ${summary}`
            : `[${ctx.trigger}] ${status} (${duration}): ${summary}`,
          salience: event.success ? 0.4 : 0.7, // Failures are more important to remember
          sourceType: ctx.trigger === "cron" ? "cron" : "agent",
        },
      );

      // Track the event
      trackEvent(sharedState.currentSessionId, "background_run", ctx.trigger).catch(() => {});

      logger.info(`Agent end: ${ctx.trigger} ${status} (${duration})`);
    } catch (error) {
      logger.debug(`Agent end capture failed: ${error}`);
    }
  };
}

// ---------------------------------------------------------------------------
// llm_output handler — track token usage per turn
// ---------------------------------------------------------------------------

export function createLlmOutputHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      runId: string;
      sessionId: string;
      provider: string;
      model: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
    },
  ): Promise<void> => {
    // Track model name for session header
    if (event.model) sharedState.currentModel = event.model;

    if (!sharedState.currentSessionId || !event.usage) return;

    try {
      const { input = 0, output = 0, cacheRead = 0, total = 0 } = event.usage;
      const data = `in:${input} out:${output} cache:${cacheRead} total:${total}`;
      trackEvent(sharedState.currentSessionId, "llm_tokens", data).catch(() => {});
    } catch {
      // Fire-and-forget
    }
  };
}

// ---------------------------------------------------------------------------
// subagent_spawned handler — create parent→child session edge
// ---------------------------------------------------------------------------

export function createSubagentSpawnedHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      childSessionKey: string;
      agentId: string;
      label?: string;
      mode: "run" | "session";
      runId: string;
    },
  ): Promise<void> => {
    if (!sharedState.currentSessionId) return;

    try {
      // Create a "spawned" edge from parent session → child session (by key)
      // We store the child session key as the edge reason since we may not have the child's record ID yet
      const sid = sessionIdPart(sharedState.currentSessionId);
      await query(
        `LET $parent = type::record("session", $parentId);
         LET $child = (SELECT id FROM session WHERE session_key = $childKey LIMIT 1);
         IF $child[0] != NONE THEN
           RELATE $parent->relates->$child[0].id CONTENT {
             type: "spawned",
             reason: $label,
             confidence: 1.0,
             created_by: "system",
             created_at: time::now()
           }
         END;`,
        {
          parentId: sid,
          childKey: event.childSessionKey,
          label: event.label ?? `${event.mode} subagent`,
        },
      );

      logger.debug(`Subagent spawned: ${event.childSessionKey} (${event.mode})`);
    } catch (error) {
      logger.debug(`Subagent spawned edge failed: ${error}`);
    }
  };
}

// ---------------------------------------------------------------------------
// subagent_ended handler — capture child outcome
// ---------------------------------------------------------------------------

export function createSubagentEndedHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      targetSessionKey: string;
      reason: string;
      outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
      error?: string;
      runId?: string;
      endedAt?: number;
    },
  ): Promise<void> => {
    if (!sharedState.currentSessionId) return;

    try {
      const outcome = event.outcome ?? "unknown";
      const duration = event.endedAt
        ? `${Math.round((Date.now() - event.endedAt) / 1000)}s`
        : "?";

      trackEvent(
        sharedState.currentSessionId,
        "subagent_ended",
        `${outcome}:${event.reason}`,
      ).catch(() => {});

      if (outcome === "error" || outcome === "timeout") {
        // Save failures as memories — agent should know about them
        const idPart = generateId("mem");
        await query(
          `CREATE type::record("memory", $idPart) CONTENT {
            content: $content,
            category: "context",
            salience: 0.6,
            scope: "global",
            is_active: true,
            confidence: 0.8,
            source_type: "agent",
            created_at: time::now(),
            updated_at: time::now()
          }`,
          {
            idPart,
            content: `Subagent ${outcome}: ${event.error?.slice(0, 200) ?? event.reason} (session: ${event.targetSessionKey})`,
          },
        );
      }

      logger.debug(`Subagent ended: ${event.targetSessionKey} → ${outcome}`);
    } catch (error) {
      logger.debug(`Subagent ended capture failed: ${error}`);
    }
  };
}

// ---------------------------------------------------------------------------
// session_start handler — track session lifecycle
// ---------------------------------------------------------------------------

export function createSessionStartHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      sessionId: string;
      sessionKey?: string;
      resumedFrom?: string;
    },
  ): Promise<void> => {
    try {
      if (event.resumedFrom && sharedState.currentSessionId) {
        // Save as memory so agent knows this session was restored
        const idPart = generateId("mem");
        await query(
          `CREATE type::record("memory", $idPart) CONTENT {
            content: $content,
            category: "context",
            salience: 0.3,
            scope: "global",
            is_active: true,
            confidence: 1.0,
            source_type: "agent",
            created_at: time::now(),
            updated_at: time::now()
          }`,
          {
            idPart,
            content: `Session resumed from archive: ${event.resumedFrom}. Some earlier messages may not be in context.`,
          },
        );
        logger.info(`Session resumed from: ${event.resumedFrom}`);
      }
    } catch {
      // Non-fatal
    }
  };
}

// ---------------------------------------------------------------------------
// session_end handler — session duration + message count
// ---------------------------------------------------------------------------

export function createSessionEndHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      sessionId: string;
      sessionKey?: string;
      messageCount: number;
      durationMs?: number;
    },
  ): Promise<void> => {
    if (!sharedState.currentSessionId) return;

    try {
      const duration = event.durationMs
        ? `${Math.round(event.durationMs / 1000)}s`
        : "?";

      trackEvent(
        sharedState.currentSessionId,
        "session_end",
        `msgs:${event.messageCount} duration:${duration}`,
      ).catch(() => {});
    } catch {
      // Non-fatal
    }
  };
}

// ---------------------------------------------------------------------------
// message_received handler — capture sender identity into entity table
// ---------------------------------------------------------------------------

export function createMessageReceivedHandler(
  logger: QmemoryLogger,
) {
  return async (
    event: {
      from: string;
      content: string;
      timestamp?: number;
      metadata?: Record<string, unknown>;
    },
    ctx: {
      channelId?: string;
      accountId?: string;
      conversationId?: string;
    },
  ): Promise<void> => {
    if (!event.from) return;

    try {
      // Upsert the sender as an entity — if they exist, just update last_active
      const name = event.from;
      const channel = ctx.channelId ?? "unknown";

      await query(
        `UPSERT entity SET
          name = $name,
          type = "person",
          external_source = $channel,
          external_channel = $accountId,
          updated_at = time::now(),
          created_at = created_at ?? time::now()
        WHERE name = $name AND external_source = $channel`,
        { name, channel, accountId: ctx.accountId ?? "" },
      );
    } catch {
      // Fire-and-forget — never block message processing
    }
  };
}

// ---------------------------------------------------------------------------
// message_sent handler — track delivery target for cron/subagent routing
// ---------------------------------------------------------------------------

export function createMessageSentHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      to: string;
      content: string;
      success: boolean;
      error?: string;
    },
  ): Promise<void> => {
    // Store delivery target so agent_end can include it in cron memories
    if (event.to) {
      sharedState.lastDeliveryTarget = event.to;
    }

    // Track delivery failures as memories — agent should know if messages aren't getting through
    if (!event.success && sharedState.currentSessionId) {
      try {
        trackEvent(
          sharedState.currentSessionId,
          "delivery_failed",
          `to:${event.to} error:${event.error?.slice(0, 100) ?? "unknown"}`,
        ).catch(() => {});
      } catch {
        // Fire-and-forget
      }
    }
  };
}

// ---------------------------------------------------------------------------
// subagent_delivery_target handler — track where subagent output is routed
// ---------------------------------------------------------------------------

export function createSubagentDeliveryTargetHandler(
  logger: QmemoryLogger,
  sharedState: SharedEngineState,
) {
  return async (
    event: {
      childSessionKey: string;
      requesterSessionKey: string;
      requesterOrigin?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
      };
    },
  ): Promise<void> => {
    // Store the delivery target for enriching cron/subagent outcome memories
    if (event.requesterOrigin?.to) {
      sharedState.lastDeliveryTarget = event.requesterOrigin.to;
    } else if (event.requesterOrigin?.threadId) {
      sharedState.lastDeliveryTarget = `topic:${event.requesterOrigin.threadId}`;
    } else if (event.requesterOrigin?.channel) {
      sharedState.lastDeliveryTarget = event.requesterOrigin.channel;
    }
  };
}

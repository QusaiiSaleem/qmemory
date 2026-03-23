/**
 * Lifecycle hooks — session_start, session_end, llm_output
 */

import { query, generateId } from "../../db/client.js";
import { trackEvent } from "../../core/metrics.js";
import type { QmemoryLogger } from "../../config.js";
import type { SharedEngineState } from "./index.js";

/**
 * Extract just the ID part from a SurrealDB record reference.
 */
function sessionIdPart(fullId: unknown): string {
  const str = String(fullId);
  const idx = str.indexOf(":");
  return idx >= 0 ? str.slice(idx + 1) : str;
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

/**
 * Subagent hooks — subagent_spawned, subagent_ended, subagent_delivery_target
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

/**
 * Message hooks — message_received, message_sent
 */

import { query } from "../../db/client.js";
import { trackEvent } from "../../core/metrics.js";
import type { QmemoryLogger } from "../../config.js";
import type { SharedEngineState } from "./index.js";

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

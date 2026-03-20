/**
 * Qmemory Metrics — Lightweight Event Tracking
 *
 * Fire-and-forget event logging to the `metrics` table.
 * Never blocks hot paths — errors are caught and ignored.
 *
 * Event types:
 *   recall_hit    — memory recall returned results (data: count)
 *   recall_miss   — memory recall returned 0 results
 *   dedup_add     — new memory added
 *   dedup_update  — existing memory updated
 *   dedup_noop    — duplicate detected, skipped
 *   tool_call     — tool was called (data: tool name)
 *   compaction    — compaction triggered (data: stage number)
 *   extraction    — facts extracted (data: count)
 */

import { query, generateId } from "../db/client.js";
import type { MetricsSummary, QmemoryLogger } from "../config.js";

/** Extract ID from string or RecordId: "session:s1234" → "s1234" */
function sessionIdPart(fullId: unknown): string {
  const str = String(fullId);
  const idx = str.indexOf(":");
  return idx >= 0 ? str.slice(idx + 1) : str;
}

let logger: QmemoryLogger | null = null;

export function setMetricsLogger(l: QmemoryLogger): void {
  logger = l;
}

/**
 * Track an event. Fire-and-forget — never awaited in hot paths.
 * Errors are caught and silently ignored.
 */
export async function trackEvent(
  sessionId: string,
  eventType: string,
  data?: string,
): Promise<void> {
  try {
    const idPart = generateId("mt");

    if (data !== undefined) {
      await query(
        `CREATE type::record("metrics", $idPart) CONTENT {
          session: type::record("session", $sessionId),
          event_type: $eventType,
          event_data: $eventData,
          created_at: time::now()
        }`,
        { idPart, sessionId: sessionIdPart(sessionId), eventType, eventData: data },
      );
    } else {
      await query(
        `CREATE type::record("metrics", $idPart) CONTENT {
          session: type::record("session", $sessionId),
          event_type: $eventType,
          created_at: time::now()
        }`,
        { idPart, sessionId: sessionIdPart(sessionId), eventType },
      );
    }
  } catch {
    // Fire-and-forget — never fail the caller
  }
}

/**
 * Get aggregated metrics for a session.
 */
export async function getSessionMetrics(sessionId: string): Promise<MetricsSummary> {
  const empty: MetricsSummary = {
    recall_hits: 0,
    recall_misses: 0,
    dedup_adds: 0,
    dedup_updates: 0,
    dedup_noops: 0,
    tool_calls: 0,
    compactions: 0,
    extractions: 0,
  };

  try {
    const rows = await query<{ event_type: string; total: number }>(
      `SELECT event_type, count() AS total
       FROM metrics
       WHERE session = type::record("session", $sessionId)
       GROUP BY event_type`,
      { sessionId: sessionIdPart(sessionId) },
    );

    if (!rows) return empty;

    for (const row of rows) {
      switch (row.event_type) {
        case "recall_hit":   empty.recall_hits = row.total; break;
        case "recall_miss":  empty.recall_misses = row.total; break;
        case "dedup_add":    empty.dedup_adds = row.total; break;
        case "dedup_update": empty.dedup_updates = row.total; break;
        case "dedup_noop":   empty.dedup_noops = row.total; break;
        case "tool_call":    empty.tool_calls = row.total; break;
        case "compaction":   empty.compactions = row.total; break;
        case "extraction":   empty.extractions = row.total; break;
      }
    }

    return empty;
  } catch (error) {
    logger?.debug(`getSessionMetrics failed: ${error}`);
    return empty;
  }
}

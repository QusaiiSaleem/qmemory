/**
 * Linker service — Find unlinked memories and create relationships
 *
 * Three background tasks that make the graph smarter over time:
 *   1. LINKER: Find unlinked memories, ask LLM for relationships
 *   2. REFLECT: Review recent memories, synthesize insights
 *   3. SALIENCE DECAY: Pure DB, no LLM cost
 *
 * Self-scheduling: each task checks if it found work.
 * Found work → run again sooner. No work → back off.
 */

import { query } from "../../db/client.js";
import type { QmemoryConfig, QmemoryLogger, Memory } from "../../config.js";
import type { SubagentRunner } from "../index.js";
import { runReflect } from "./reflect.js";
import { runSalienceDecay } from "./salience.js";

// ---------------------------------------------------------------------------
// Linker — Find unlinked memories and create relationships
// Returns true if work was found (edges created) → schedule sooner
// ---------------------------------------------------------------------------

async function runLinker(
  subagentRunner: SubagentRunner | undefined,
  logger: QmemoryLogger,
): Promise<boolean> {
  if (!subagentRunner) return false;

  try {
    // Step 1: Find unlinked memories using the indexed `linked` field.
    // Much faster than count(->relates) = 0 which traverses every memory's edges.
    const unlinked = await query<Memory>(
      `SELECT * FROM memory
       WHERE is_active = true
         AND linked = false
       ORDER BY created_at DESC
       LIMIT 10`,
    );

    if (!unlinked || unlinked.length === 0) {
      logger.debug("Linker: no unlinked memories found");
      return false;
    }

    // Step 2: Get 20 most recent other memories for comparison
    const unlinkedIds = unlinked.map((m) => m.id);
    const candidates = await query<Memory>(
      `SELECT * FROM memory
       WHERE is_active = true
         AND id NOT IN $excludeIds
       ORDER BY created_at DESC
       LIMIT 20`,
      { excludeIds: unlinkedIds },
    );

    if (!candidates || candidates.length === 0) {
      logger.debug("Linker: no candidate memories to compare against");
      return false;
    }

    // Step 3: Ask the LLM which memories are related
    // Include evidence_type and source_person so the LLM can infer
    // richer relationship types (e.g. "stated_by", "supports" for corroboration)
    const unlinkedList = unlinked
      .map((m) => `  ${m.id}: "${m.content}" [${m.category}, ${m.evidence_type ?? "observed"}, source: ${m.source_person ?? "system"}]`)
      .join("\n");
    const candidateList = candidates
      .map((m) => `  ${m.id}: "${m.content}" [${m.category}, ${m.evidence_type ?? "observed"}, source: ${m.source_person ?? "system"}]`)
      .join("\n");

    const prompt = `You are a memory graph builder. Given two lists of memories, identify meaningful
relationships between them.

UNLINKED MEMORIES (need connections):
${unlinkedList}

CANDIDATE MEMORIES (potential targets):
${candidateList}

For each relationship you find, specify:
- from_id: the unlinked memory ID
- to_id: the candidate memory ID
- type: the relationship type (see options below)
- reason: brief explanation (1 sentence)

RELATIONSHIP TYPES:
- supports / contradicts / elaborates — evidence relationships
- depends_on / caused_by / blocks — causal chains
- supersedes / replaces — version relationships
- part_of / belongs_to — hierarchical
- stated_by — if source_person matches an entity
- related_to — fallback for genuine but uncategorized connections
- Or any type that fits — you are not limited to this list.

RULES:
- Only include MEANINGFUL relationships — not every memory is related
- Two memories from different sources about the same topic → "supports" (corroboration)
- A newer fact that changes an older one → "supersedes"
- A hypothesis and its evidence → "supports" with lower confidence
- Self-knowledge and feedback → "derived_from"

Return ONLY a JSON array (no other text):
[{"from_id": "memory:xxx", "to_id": "memory:yyy", "type": "supports", "reason": "..."}]

If no relationships found, return: []`;

    const response = await subagentRunner(prompt);

    // Step 4: Parse the response and create edges
    let relationships: Array<{
      from_id: string;
      to_id: string;
      type: string;
      reason: string;
    }> = [];

    try {
      // Extract JSON array from the response (handle markdown code blocks)
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        relationships = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      logger.warn(`Linker: failed to parse LLM response: ${parseError}`);
      return false;
    }

    // Step 5: Create `relates` edges for each relationship
    let edgesCreated = 0;
    for (const rel of relationships) {
      // Validate that IDs are in our working set (prevent hallucinated IDs)
      const allIds = [...unlinkedIds, ...candidates.map((c) => c.id)];
      if (!allIds.includes(rel.from_id) || !allIds.includes(rel.to_id)) {
        continue;
      }

      try {
        await query(
          `LET $f = type::record($from); LET $t = type::record($to);
           RELATE $f->relates->$t CONTENT {
            type: $type,
            reason: $reason,
            confidence: 0.7,
            created_by: "linker",
            created_at: time::now()
          };`,
          {
            from: rel.from_id,
            to: rel.to_id,
            type: rel.type,
            reason: rel.reason,
          },
        );
        edgesCreated++;
      } catch (error) {
        logger.warn(`Linker: failed to create edge: ${error}`);
      }
    }

    // Mark all processed memories as linked — even if no edges were created.
    // This prevents the same memories from being re-checked every cycle.
    // SurrealDB 3.0: UPDATE doesn't accept array params directly — use WHERE id IN
    const processedIds = unlinked.map((m) => m.id);
    await query(
      `UPDATE memory SET linked = true WHERE id IN $ids`,
      { ids: processedIds },
    );

    if (edgesCreated > 0) {
      logger.info(`Linker: created ${edgesCreated} relationship edges`);
    }
    return edgesCreated > 0;
  } catch (error) {
    logger.error(`Linker task failed: ${error}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linker service factory
// ---------------------------------------------------------------------------

export function createLinkerService(
  config: QmemoryConfig,
  logger: QmemoryLogger,
  subagentRunner?: SubagentRunner,
) {
  // Self-scheduling: each task schedules its own next run after completing
  let linkerTimeout: ReturnType<typeof setTimeout> | null = null;
  let reflectTimeout: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  // Overlap protection (safety net — self-scheduling prevents this naturally)
  let linkerRunning = false;
  let reflectRunning = false;

  // Shorter intervals when work was found (responsive to activity bursts)
  const LINKER_ACTIVE_MS = 5 * 60_000;   // 5 min — process next batch quickly
  const REFLECT_ACTIVE_MS = 10 * 60_000; // 10 min — heavier task, more spacing

  // Self-scheduling — each task decides when to run next based on
  // whether it found work. Active → short delay, idle → long delay.

  function scheduleLinker(delayMs: number) {
    if (!running) return;
    linkerTimeout = setTimeout(async () => {
      linkerTimeout = null;
      if (linkerRunning) return;
      linkerRunning = true;
      try {
        const hadWork = await runLinker(subagentRunner, logger);
        await runSalienceDecay(logger);
        // Found work (edges created) → check again in 5 min (burst mode)
        // No work → back off to configured interval (default 30 min)
        const nextDelay = hadWork ? LINKER_ACTIVE_MS : config.linker_interval_ms;
        if (hadWork) {
          logger.debug(`Linker: work found, next run in ${nextDelay / 1000}s`);
        }
        scheduleLinker(nextDelay);
      } finally {
        linkerRunning = false;
      }
    }, delayMs);
  }

  function scheduleReflect(delayMs: number) {
    if (!running) return;
    reflectTimeout = setTimeout(async () => {
      reflectTimeout = null;
      if (reflectRunning) return;
      reflectRunning = true;
      try {
        const hadWork = await runReflect(subagentRunner, logger);
        // Found insights/contradictions → check again in 10 min
        // No work → back off to configured interval (default 30 min)
        const nextDelay = hadWork ? REFLECT_ACTIVE_MS : config.reflect_interval_ms;
        if (hadWork) {
          logger.debug(`Reflect: work found, next run in ${nextDelay / 1000}s`);
        }
        scheduleReflect(nextDelay);
      } finally {
        reflectRunning = false;
      }
    }, delayMs);
  }

  // Service object — registered with OpenClaw via api.registerService()

  return {
    id: "qmemory-linker",

    async start() {
      running = true;

      // Linker: first run after 5s (DB warmup), then self-scheduling
      scheduleLinker(5000);

      // Reflect: stagger by half the linker interval so they never
      // compete for the subagent runner. With 30 min intervals:
      // Linker at 0, 5, 10... or 30 (idle) — Reflect at 15, 25... or 45 (idle)
      const staggerMs = Math.floor(config.linker_interval_ms / 2);
      scheduleReflect(staggerMs);

      logger.info(
        `Linker service started (self-scheduling: ` +
        `linker ${LINKER_ACTIVE_MS / 1000}s active / ${config.linker_interval_ms / 1000}s idle, ` +
        `reflect ${REFLECT_ACTIVE_MS / 1000}s active / ${config.reflect_interval_ms / 1000}s idle, ` +
        `stagger ${staggerMs / 1000}s)`,
      );
    },

    async stop() {
      running = false;
      if (linkerTimeout) {
        clearTimeout(linkerTimeout);
        linkerTimeout = null;
      }
      if (reflectTimeout) {
        clearTimeout(reflectTimeout);
        reflectTimeout = null;
      }
      logger.info("Linker service stopped");
    },
  };
}

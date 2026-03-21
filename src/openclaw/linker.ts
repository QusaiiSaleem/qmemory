/**
 * Qmemory Background Linker Service
 *
 * Three background tasks that make the graph smarter over time:
 *
 * 1. LINKER: Find unlinked memories, ask LLM for relationships,
 *    create `relates` edges. Self-scheduling: 5 min when active,
 *    30 min when idle.
 *
 * 2. REFLECT: Review recent memories, synthesize insights, resolve
 *    contradictions. Self-scheduling: 10 min when active, 30 min
 *    when idle. Staggered from Linker by half-interval.
 *
 * 3. SALIENCE DECAY: Piggybacks on Linker. Pure DB, no LLM cost.
 *
 * Scheduling pattern: each task checks if it found work, then
 * schedules its next run sooner (active) or later (idle). No fixed
 * intervals — responsive to bursts, efficient when quiet.
 *
 * Both LLM tasks use OpenClaw subagents — no extra API keys needed.
 */

import { query, generateId } from "../db/client.js";
import { saveMemory } from "../core/save.js";
import type { QmemoryConfig, QmemoryLogger, Memory } from "../config.js";
import type { SubagentRunner } from "./index.js";

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

  // -------------------------------------------------------------------
  // LINKER — Find unlinked memories and create relationships
  // Returns true if work was found (edges created) → schedule sooner
  // -------------------------------------------------------------------

  async function runLinker(): Promise<boolean> {
    if (linkerRunning) return false;
    if (!subagentRunner) return false;

    linkerRunning = true;

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
      const unlinkedList = unlinked
        .map((m) => `  ${m.id}: "${m.content}" [${m.category}]`)
        .join("\n");
      const candidateList = candidates
        .map((m) => `  ${m.id}: "${m.content}" [${m.category}]`)
        .join("\n");

      const prompt = `You are a memory graph builder. Given two lists of memories, identify meaningful relationships between them.

UNLINKED MEMORIES (need connections):
${unlinkedList}

CANDIDATE MEMORIES (potential targets):
${candidateList}

For each relationship you find, specify:
- from_id: the unlinked memory ID
- to_id: the candidate memory ID
- type: the relationship (supports, contradicts, elaborates, depends_on, caused_by, blocks, related_to, or any type that fits)
- reason: brief explanation (1 sentence)

Only include MEANINGFUL relationships — not every memory is related.

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
      const processedIds = unlinked.map((m) => m.id);
      await query(
        `UPDATE $ids SET linked = true`,
        { ids: processedIds },
      );

      if (edgesCreated > 0) {
        logger.info(`Linker: created ${edgesCreated} relationship edges`);
      }
      return edgesCreated > 0;
    } catch (error) {
      logger.error(`Linker task failed: ${error}`);
      return false;
    } finally {
      linkerRunning = false;
    }
  }

  // -------------------------------------------------------------------
  // REFLECT — Synthesize insights and resolve contradictions
  // Returns true if work was found (insights/contradictions) → schedule sooner
  // -------------------------------------------------------------------

  async function runReflect(): Promise<boolean> {
    if (reflectRunning) return false;
    if (!subagentRunner) return false;

    reflectRunning = true;

    try {
      // Step 1: Get the last 30 active memories
      const recentMemories = await query<Memory>(
        `SELECT * FROM memory
         WHERE is_active = true
         ORDER BY created_at DESC
         LIMIT 30`,
      );

      if (!recentMemories || recentMemories.length < 5) {
        logger.debug("Reflect: not enough memories to reflect on");
        return false;
      }

      // Step 2: Ask the LLM to identify patterns, insights, and contradictions
      const memoryList = recentMemories
        .map(
          (m) =>
            `  ${m.id}: "${m.content}" [${m.category}, salience: ${m.salience}]`,
        )
        .join("\n");

      const prompt = `You are a memory analyst. Review these recent memories and identify:

1. INSIGHTS: Patterns or synthesized knowledge that connect multiple memories
2. CONTRADICTIONS: Memories that conflict with each other

MEMORIES:
${memoryList}

Return ONLY a JSON object (no other text):
{
  "insights": [
    {"content": "synthesized insight", "based_on": ["memory:xxx", "memory:yyy"], "category": "context"}
  ],
  "contradictions": [
    {"old_id": "memory:xxx", "new_id": "memory:yyy", "explanation": "why they conflict"}
  ]
}

If nothing found, return: {"insights": [], "contradictions": []}`;

      const response = await subagentRunner(prompt);

      // Step 3: Parse the response
      let analysis: {
        insights: Array<{
          content: string;
          based_on: string[];
          category: string;
        }>;
        contradictions: Array<{
          old_id: string;
          new_id: string;
          explanation: string;
        }>;
      } = { insights: [], contradictions: [] };

      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        logger.warn(`Reflect: failed to parse LLM response: ${parseError}`);
        return false;
      }

      // Step 4: Save new insights as memory nodes
      const validIds = recentMemories.map((m) => m.id);

      for (const insight of analysis.insights ?? []) {
        try {
          const result = await saveMemory(
            {
              content: insight.content,
              category: (insight.category || "context") as import("../config.js").MemoryCategory,
              salience: 0.7,
              scope: "global",
              source_type: "reflect",
            },
            subagentRunner,
          );

          // Create `relates` edges from the insight to its source memories
          if (result?.memory_id) {
            for (const sourceId of insight.based_on ?? []) {
              if (!validIds.includes(sourceId)) continue;
              await query(
                `LET $f = type::record($from); LET $t = type::record($to);
                 RELATE $f->relates->$t CONTENT {
                  type: "synthesized_from",
                  reason: "Insight derived during reflection",
                  confidence: 0.7,
                  created_by: "reflect",
                  created_at: time::now()
                };`,
                { from: result.memory_id, to: sourceId },
              );
            }
          }
        } catch (error) {
          logger.warn(`Reflect: failed to save insight: ${error}`);
        }
      }

      // Step 5: Handle contradictions — deactivate the old memory
      for (const contradiction of analysis.contradictions ?? []) {
        // Validate that both IDs exist in our working set
        if (
          !validIds.includes(contradiction.old_id) ||
          !validIds.includes(contradiction.new_id)
        ) {
          continue;
        }

        try {
          // Soft-delete the old (contradicted) memory
          await query(
            `UPDATE $id SET is_active = false, updated_at = time::now()`,
            { id: contradiction.old_id },
          );

          // Create a `contradicts` edge from new → old
          await query(
            `LET $f = type::record($from); LET $t = type::record($to);
             RELATE $f->relates->$t CONTENT {
              type: "contradicts",
              reason: $reason,
              confidence: 0.8,
              created_by: "reflect",
              created_at: time::now()
            };`,
            {
              from: contradiction.new_id,
              to: contradiction.old_id,
              reason: contradiction.explanation,
            },
          );

          logger.info(
            `Reflect: resolved contradiction — deactivated ${contradiction.old_id}`,
          );
        } catch (error) {
          logger.warn(`Reflect: failed to resolve contradiction: ${error}`);
        }
      }

      const insightCount = analysis.insights?.length ?? 0;
      const contradictionCount = analysis.contradictions?.length ?? 0;

      if (insightCount > 0 || contradictionCount > 0) {
        logger.info(
          `Reflect: ${insightCount} insights, ${contradictionCount} contradictions resolved`,
        );
      }
      return insightCount > 0 || contradictionCount > 0;
    } catch (error) {
      logger.error(`Reflect task failed: ${error}`);
      return false;
    } finally {
      reflectRunning = false;
    }
  }

  // -------------------------------------------------------------------
  // SALIENCE DECAY — old memories gradually lose importance
  // Piggybacks on linker schedule (pure DB, no LLM cost)
  // -------------------------------------------------------------------

  async function runSalienceDecay(): Promise<void> {
    try {
      // Decay memories older than 7 days that haven't been recalled recently.
      // Multiply salience by 0.95 — a memory at 0.8 drops to 0.44 after 3 months.
      // Floor at 0.1 so no memory becomes completely invisible.
      //
      // SurrealDB best practice: indexes are NOT used in UPDATE...WHERE.
      // Wrap in SELECT subquery so the index drives the filter, then UPDATE by ID.
      const staleIds = await query<{ id: string }>(
        `SELECT id FROM memory
         WHERE is_active = true
           AND salience > 0.15
           AND updated_at < time::now() - 7d`,
      );

      if (!staleIds || staleIds.length === 0) return;

      await query(
        `UPDATE $ids SET salience = math::max(salience * 0.95, 0.1), updated_at = time::now()
         RETURN NONE;`,
        { ids: staleIds.map((r) => r.id) },
      );

      logger.info(`Salience decay: ${staleIds.length} memories decayed`);
    } catch (error) {
      logger.debug(`Salience decay failed: ${error}`);
    }
  }

  // -------------------------------------------------------------------
  // Self-scheduling — each task decides when to run next based on
  // whether it found work. Active → short delay, idle → long delay.
  // -------------------------------------------------------------------

  function scheduleLinker(delayMs: number) {
    if (!running) return;
    linkerTimeout = setTimeout(async () => {
      linkerTimeout = null;
      const hadWork = await runLinker();
      await runSalienceDecay();
      // Found work (edges created) → check again in 5 min (burst mode)
      // No work → back off to configured interval (default 30 min)
      const nextDelay = hadWork ? LINKER_ACTIVE_MS : config.linker_interval_ms;
      if (hadWork) {
        logger.debug(`Linker: work found, next run in ${nextDelay / 1000}s`);
      }
      scheduleLinker(nextDelay);
    }, delayMs);
  }

  function scheduleReflect(delayMs: number) {
    if (!running) return;
    reflectTimeout = setTimeout(async () => {
      reflectTimeout = null;
      const hadWork = await runReflect();
      // Found insights/contradictions → check again in 10 min
      // No work → back off to configured interval (default 30 min)
      const nextDelay = hadWork ? REFLECT_ACTIVE_MS : config.reflect_interval_ms;
      if (hadWork) {
        logger.debug(`Reflect: work found, next run in ${nextDelay / 1000}s`);
      }
      scheduleReflect(nextDelay);
    }, delayMs);
  }

  // -------------------------------------------------------------------
  // Service object — registered with OpenClaw via api.registerService()
  // -------------------------------------------------------------------

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

/**
 * Qmemory Background Linker Service
 *
 * Two periodic tasks that make the graph smarter over time:
 *
 * 1. LINKER (every 5 min): Find unlinked memories, ask LLM for
 *    relationships, create `relates` edges between them.
 *
 * 2. REFLECT (every 30 min): Review recent memories, synthesize
 *    insights, resolve contradictions. Inspired by Hindsight (91.4%
 *    LongMemEval — highest accuracy of any memory system).
 *
 * Both tasks use OpenClaw subagents — no extra API keys needed.
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
  let linkerTimer: ReturnType<typeof setInterval> | null = null;
  let reflectTimer: ReturnType<typeof setInterval> | null = null;

  // Track whether a task is already running (prevent overlap)
  let linkerRunning = false;
  let reflectRunning = false;

  // -------------------------------------------------------------------
  // LINKER — Find unlinked memories and create relationships
  // Runs every config.linker_interval_ms (default: 5 minutes)
  // -------------------------------------------------------------------

  async function runLinker(): Promise<void> {
    if (linkerRunning) return; // Prevent overlapping runs
    if (!subagentRunner) return;

    linkerRunning = true;

    try {
      // Step 1: Find memories with 0 outgoing `relates` edges (limit 10)
      const unlinked = await query<Memory>(
        `SELECT * FROM memory
         WHERE is_active = true
           AND count(->relates) = 0
         ORDER BY created_at DESC
         LIMIT 10`,
      );

      if (!unlinked || unlinked.length === 0) {
        logger.debug("Linker: no unlinked memories found");
        return;
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
        return;
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
        return;
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
            `RELATE $from -> relates -> $to CONTENT {
              type: $type,
              reason: $reason,
              confidence: 0.7,
              created_by: "linker",
              created_at: time::now()
            }`,
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

      if (edgesCreated > 0) {
        logger.info(`Linker: created ${edgesCreated} relationship edges`);
      }
    } catch (error) {
      logger.error(`Linker task failed: ${error}`);
    } finally {
      linkerRunning = false;
    }
  }

  // -------------------------------------------------------------------
  // REFLECT — Synthesize insights and resolve contradictions
  // Runs every config.reflect_interval_ms (default: 30 minutes)
  // -------------------------------------------------------------------

  async function runReflect(): Promise<void> {
    if (reflectRunning) return; // Prevent overlapping runs
    if (!subagentRunner) return;

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
        return;
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
        return;
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
                `RELATE type::thing($from) -> relates -> type::thing($to) CONTENT {
                  type: "synthesized_from",
                  reason: "Insight derived during reflection",
                  confidence: 0.7,
                  created_by: "reflect",
                  created_at: time::now()
                }`,
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
            `RELATE $from -> relates -> $to CONTENT {
              type: "contradicts",
              reason: $reason,
              confidence: 0.8,
              created_by: "reflect",
              created_at: time::now()
            }`,
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
    } catch (error) {
      logger.error(`Reflect task failed: ${error}`);
    } finally {
      reflectRunning = false;
    }
  }

  // -------------------------------------------------------------------
  // Service object — registered with OpenClaw via api.registerService()
  // -------------------------------------------------------------------

  return {
    id: "qmemory-linker",

    async start() {
      // Start periodic tasks
      linkerTimer = setInterval(runLinker, config.linker_interval_ms);
      reflectTimer = setInterval(runReflect, config.reflect_interval_ms);

      logger.info(
        `Linker service started (link every ${config.linker_interval_ms / 1000}s, ` +
        `reflect every ${config.reflect_interval_ms / 1000}s)`,
      );

      // Run the linker once on startup (after a short delay to let DB connect)
      setTimeout(runLinker, 5000);
    },

    async stop() {
      if (linkerTimer) {
        clearInterval(linkerTimer);
        linkerTimer = null;
      }
      if (reflectTimer) {
        clearInterval(reflectTimer);
        reflectTimer = null;
      }
      logger.info("Linker service stopped");
    },
  };
}

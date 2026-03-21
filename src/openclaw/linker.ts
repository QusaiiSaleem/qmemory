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
      // One-time identity summary after discovery mode ends (72-168h window)
      try {
        const firstMemory = await query<{ created_at: string }>(
          "SELECT created_at FROM memory ORDER BY created_at ASC LIMIT 1",
        );
        const firstDate = firstMemory?.[0]?.created_at;
        const hoursSinceFirst = firstDate
          ? (Date.now() - new Date(firstDate).getTime()) / 3_600_000
          : 0;

        if (hoursSinceFirst >= 72 && hoursSinceFirst < 168) {
          const existing = await query(
            `SELECT id FROM memory WHERE category = "self"
             AND content ~ "Identity Summary" AND is_active = true LIMIT 1`,
          );
          if (!existing?.length) {
            await runIdentitySummary();
          }
        }
      } catch (e) {
        logger.debug(`Identity summary check failed: ${e}`);
      }

      // Step 1: Get the last 30 active memories (exclude reflect outputs to avoid feedback loops)
      const recentMemories = await query<Memory>(
        `SELECT * FROM memory
         WHERE is_active = true AND source_type != "reflect"
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

      const prompt = `You are the agent's background thinking process. You review recent memories and
perform five types of cognitive work:

1. PATTERNS — Recurring behaviors or rules that connect multiple memories.
   Not just "these are related" but "this ALWAYS happens when X occurs."
   Example: "Every time a Railway deploy fails, the root cause is timing not logic"

2. CONTRADICTIONS — Memories that conflict with each other. Do NOT auto-resolve.
   Flag both sides with the source person so the agent can ask the user.
   Example: "Qusai said budget is 500K (mem:a) but Osama said 400K (mem:b)"

3. COMPRESSIONS — Groups of 3+ similar old memories that can be merged into
   one principle. The individual facts fade, the principle persists.
   This is how the agent forgets details but remembers lessons.
   Example: Merge "user said shorter" + "user said no summaries" + "user said concise"
   → "This user strongly prefers brevity — no trailing summaries, no over-explanation"

4. GHOST ENTITIES — Names, projects, or tools mentioned in 3+ memories but
   never saved as an entity node. These deserve to be tracked.
   Example: "MAZJ mentioned in 4 memories but has no entity node"

5. SELF LEARNINGS — Meta-observations about how the agent is performing.
   Look at feedback/correction memories and extract behavioral patterns:
   - What communication style gets engagement?
   - What mistakes keep recurring?
   - What does the user value most about the agent's help?
   Example: "Agent's Arabic responses get 3x more engagement than English"

MEMORIES:
${memoryList}

Return ONLY a JSON object (no other text):
{
  "patterns": [
    {"content": "The abstracted pattern or rule", "based_on": ["memory:xxx", "memory:yyy"], "category": "domain", "salience": 0.7}
  ],
  "contradictions": [
    {"memory_a": "memory:xxx", "memory_b": "memory:yyy", "person_a": "name", "person_b": "name", "explanation": "Why they conflict"}
  ],
  "compressions": [
    {"merge_ids": ["memory:aaa", "memory:bbb", "memory:ccc"], "into": "The compressed principle", "category": "self"}
  ],
  "ghost_entities": [
    {"name": "MAZJ", "type": "project", "mentioned_in": ["memory:xxx"], "mentioned_count": 4}
  ],
  "self_learnings": [
    {"content": "The meta-observation", "evidence": "Brief explanation", "salience": 0.7}
  ]
}

If nothing found for a category, use an empty array.
Focus on quality over quantity — one real pattern is worth more than five weak ones.`;

      const response = await subagentRunner(prompt);

      // Step 3: Parse the response
      let analysis: {
        patterns: Array<{ content: string; based_on: string[]; category: string; salience: number }>;
        contradictions: Array<{ memory_a: string; memory_b: string; person_a?: string; person_b?: string; explanation: string }>;
        compressions: Array<{ merge_ids: string[]; into: string; category: string }>;
        ghost_entities: Array<{ name: string; type: string; mentioned_in: string[]; mentioned_count: number }>;
        self_learnings: Array<{ content: string; evidence: string; salience: number }>;
      } = { patterns: [], contradictions: [], compressions: [], ghost_entities: [], self_learnings: [] };

      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        logger.warn(`Reflect: failed to parse LLM response: ${parseError}`);
        return false;
      }

      // Step 4: Process all 5 analysis jobs
      const validIds = recentMemories.map((m) => m.id);

      // --- PATTERNS: save as reflect memories with synthesized_from edges ---
      for (const pattern of analysis.patterns ?? []) {
        const result = await saveMemory({
          content: pattern.content,
          category: (pattern.category || "domain") as import("../config.js").MemoryCategory,
          salience: pattern.salience ?? 0.7,
          scope: "global",
          source_type: "reflect",
          evidence_type: "inferred",
        }, subagentRunner);
        if (result?.memory_id) {
          for (const sourceId of pattern.based_on ?? []) {
            if (!validIds.includes(sourceId)) continue;
            await query(
              `LET $f = type::record($from); LET $t = type::record($to);
               RELATE $f->relates->$t CONTENT {
                type: "synthesized_from", reason: "Pattern derived during reflection",
                confidence: 0.7, created_by: "reflect", created_at: time::now()
               };`,
              { from: result.memory_id, to: sourceId },
            );
          }
        }
      }

      // --- CONTRADICTIONS: flag both, DON'T auto-delete ---
      for (const c of analysis.contradictions ?? []) {
        if (!validIds.includes(c.memory_a) || !validIds.includes(c.memory_b)) continue;
        await query(
          `LET $f = type::record($from); LET $t = type::record($to);
           RELATE $f->relates->$t CONTENT {
            type: "contradicts", reason: $reason,
            confidence: 0.8, created_by: "reflect", created_at: time::now()
           };`,
          { from: c.memory_b, to: c.memory_a, reason: c.explanation },
        );
        logger.info(`Reflect: flagged contradiction between ${c.memory_a} and ${c.memory_b}`);
      }

      // --- COMPRESSIONS: merge old facts into principle, soft-delete originals ---
      for (const comp of analysis.compressions ?? []) {
        const validMergeIds = comp.merge_ids.filter(id =>
          validIds.includes(id) &&
          recentMemories.find(m => String(m.id) === id)?.source_type !== "reflect"
        );
        if (validMergeIds.length < 2) continue;

        const result = await saveMemory({
          content: comp.into,
          category: (comp.category || "self") as import("../config.js").MemoryCategory,
          salience: 0.7,
          scope: "global",
          source_type: "reflect",
          evidence_type: "inferred",
        }, subagentRunner);

        if (result?.memory_id) {
          for (const id of validMergeIds) {
            await query(`UPDATE type::record($id) SET is_active = false, updated_at = time::now()`, { id });
            await query(
              `LET $f = type::record($from); LET $t = type::record($to);
               RELATE $f->relates->$t CONTENT {
                type: "synthesized_from", reason: "Compressed during reflection",
                confidence: 0.7, created_by: "reflect", created_at: time::now()
               };`,
              { from: result.memory_id, to: id },
            );
          }
        }
      }

      // --- GHOST ENTITIES: UPSERT to prevent duplicates ---
      for (const ghost of analysis.ghost_entities ?? []) {
        await query(
          `UPSERT entity SET name = $name, type = $type,
             updated_at = time::now(), created_at = created_at ?? time::now()
           WHERE name = $name AND type = $type`,
          { name: ghost.name, type: ghost.type },
        );
        logger.info(`Reflect: created ghost entity "${ghost.name}" (${ghost.type})`);
      }

      // --- SELF LEARNINGS: save as self category ---
      for (const learning of analysis.self_learnings ?? []) {
        await saveMemory({
          content: learning.content,
          category: "self",
          salience: learning.salience ?? 0.7,
          scope: "global",
          source_type: "reflect",
          evidence_type: "self",
        }, subagentRunner);
      }

      // Step 5: Summary log
      const patternCount = analysis.patterns?.length ?? 0;
      const contradictionCount = analysis.contradictions?.length ?? 0;
      const compressionCount = analysis.compressions?.length ?? 0;
      const ghostCount = analysis.ghost_entities?.length ?? 0;
      const selfCount = analysis.self_learnings?.length ?? 0;
      const totalWork = patternCount + contradictionCount + compressionCount + ghostCount + selfCount;

      if (totalWork > 0) {
        logger.info(
          `Reflect: ${patternCount} patterns, ${contradictionCount} contradictions, ` +
          `${compressionCount} compressions, ${ghostCount} ghosts, ${selfCount} self-learnings`,
        );
      }
      return totalWork > 0;
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
      // Tier 1: Never recalled + old → fast decay (×0.90)
      const neverRecalled = await query<{ id: string }>(
        `SELECT id FROM memory
         WHERE is_active = true AND salience > 0.15
           AND recall_count = 0
           AND updated_at < time::now() - 7d`,
      );
      if (neverRecalled?.length) {
        await query(
          `UPDATE memory SET salience = math::max(salience * 0.90, 0.1),
             updated_at = time::now()
           WHERE id IN $ids`,
          { ids: neverRecalled.map(r => r.id) },
        );
        logger.info(`Salience decay: ${neverRecalled.length} never-recalled memories decayed (×0.90)`);
      }

      // Tier 2: Recalled but stale (last_recalled > 14d) → slow decay (×0.98)
      const staleRecalled = await query<{ id: string }>(
        `SELECT id FROM memory
         WHERE is_active = true AND salience > 0.15
           AND recall_count > 0
           AND last_recalled < time::now() - 14d`,
      );
      if (staleRecalled?.length) {
        await query(
          `UPDATE memory SET salience = math::max(salience * 0.98, 0.1),
             updated_at = time::now()
           WHERE id IN $ids`,
          { ids: staleRecalled.map(r => r.id) },
        );
        logger.info(`Salience decay: ${staleRecalled.length} stale-recalled memories decayed (×0.98)`);
      }

      // Tier 3: Recalled 5+ times → cemented, never below 0.5 (no decay applied)
    } catch (error) {
      logger.debug(`Salience decay failed: ${error}`);
    }
  }

  // -------------------------------------------------------------------
  // IDENTITY SUMMARY — One-time synthesis after discovery mode ends
  // Runs inside runReflect() when 72–168h have passed since first memory.
  // Creates two high-salience memories: user profile + agent soul.
  // -------------------------------------------------------------------

  async function runIdentitySummary(): Promise<void> {
    if (!subagentRunner) return;

    const allMemories = await query<Memory>(
      "SELECT * FROM memory WHERE is_active = true ORDER BY salience DESC LIMIT 50",
    );
    if (!allMemories?.length) return;

    const memList = allMemories
      .map((m) => `  "${m.content}" [${m.category}, salience: ${m.salience}]`)
      .join("\n");

    const prompt = `You are summarizing what the agent has learned about its user and about itself
during its first 72 hours. This will be presented to the user for validation.

Review these memories and create two summaries:

1. USER IDENTITY: Who is this person? Role, projects, people they work with,
   tools they use, communication preferences.

2. AGENT SOUL: How should the agent behave with this person? What communication
   style works? What to avoid? What is the agent's most valued contribution?

MEMORIES:
${memList}

Return a JSON object:
{
  "user_summary": "A paragraph describing the user",
  "agent_soul": "A paragraph describing how the agent should behave",
  "confidence": 0.7,
  "gaps": ["Questions still unanswered"]
}`;

    const response = await subagentRunner(prompt);

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const result = JSON.parse(jsonMatch[0]);

      await saveMemory(
        {
          content: `[Identity Summary — User] ${result.user_summary}`,
          category: "context" as import("../config.js").MemoryCategory,
          salience: 0.9,
          scope: "global",
          source_type: "reflect",
          evidence_type: "inferred",
          confidence: result.confidence ?? 0.7,
        },
        subagentRunner,
      );

      await saveMemory(
        {
          content: `[Identity Summary — Agent Soul] ${result.agent_soul}`,
          category: "self" as import("../config.js").MemoryCategory,
          salience: 0.95,
          scope: "global",
          source_type: "reflect",
          evidence_type: "self",
        },
        subagentRunner,
      );

      logger.info("Reflect: identity summary created after discovery mode");
    } catch (e) {
      logger.warn(`Reflect: identity summary parse failed: ${e}`);
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

/**
 * Reflect service — Review memories, synthesize insights, resolve contradictions
 *
 * 5 jobs:
 *   1. PATTERNS — Recurring behaviors or rules
 *   2. CONTRADICTIONS — Conflicting memories (flagged, not auto-resolved)
 *   3. COMPRESSIONS — Merge old facts into principles
 *   4. GHOST ENTITIES — Names mentioned but never saved as entities
 *   5. SELF LEARNINGS — Meta-observations about agent performance
 */

import { query } from "../../db/client.js";
import { saveMemory } from "../../core/save.js";
import type { QmemoryLogger, Memory } from "../../config.js";
import type { SubagentRunner } from "../index.js";

// ---------------------------------------------------------------------------
// Identity Summary — One-time synthesis after discovery mode ends
// ---------------------------------------------------------------------------

async function runIdentitySummary(
  subagentRunner: SubagentRunner,
  logger: QmemoryLogger,
): Promise<void> {
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
        category: "context" as import("../../config.js").MemoryCategory,
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
        category: "self" as import("../../config.js").MemoryCategory,
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

// ---------------------------------------------------------------------------
// runReflect — Main reflect task
// Returns true if work was found → schedule sooner
// ---------------------------------------------------------------------------

export async function runReflect(
  subagentRunner: SubagentRunner | undefined,
  logger: QmemoryLogger,
): Promise<boolean> {
  if (!subagentRunner) return false;

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
           AND string::contains(content, "Identity Summary") AND is_active = true LIMIT 1`,
        );
        if (!existing?.length) {
          await runIdentitySummary(subagentRunner, logger);
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
        category: (pattern.category || "domain") as import("../../config.js").MemoryCategory,
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
        category: (comp.category || "self") as import("../../config.js").MemoryCategory,
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
  }
}

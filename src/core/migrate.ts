/**
 * Migration — Import old memory files into Qmemory graph
 *
 * Reads existing OpenClaw memory files (MEMORY.md + memory/*.md)
 * and imports them as memory nodes with relationships.
 *
 * Two modes:
 * 1. Smart import (with subagent): LLM extracts facts, dedup, create edges
 * 2. Simple import (without LLM): Each paragraph becomes a memory, no dedup
 *
 * Preserves chronological order — older files get earlier created_at.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { query, generateId } from "../db/client.js";
import { saveMemory } from "./save.js";
import { linkNodes } from "./link.js";
import { extractMemories } from "./extract.js";
import { consoleLogger } from "../config.js";
import type { QmemoryLogger, ExtractedFact, Memory } from "../config.js";

let logger: QmemoryLogger = consoleLogger;

export function setMigrateLogger(l: QmemoryLogger): void {
  logger = l;
}

export type SubagentRunner = (task: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface MigrateResult {
  files_read: number;
  facts_extracted: number;
  memories_created: number;
  relationships_created: number;
  errors: string[];
}

/**
 * Import all memory files from an OpenClaw workspace into Qmemory.
 *
 * @param workspacePath - Path to ~/.openclaw/workspace/
 * @param subagentRunner - LLM runner for smart extraction (optional)
 */
export async function migrateWorkspaceMemories(
  workspacePath: string,
  subagentRunner?: SubagentRunner,
): Promise<MigrateResult> {
  const result: MigrateResult = {
    files_read: 0,
    facts_extracted: 0,
    memories_created: 0,
    relationships_created: 0,
    errors: [],
  };

  logger.info(`Starting migration from ${workspacePath}`);

  // 1. Collect all memory files (sorted oldest → newest)
  const files = await collectMemoryFiles(workspacePath);
  logger.info(`Found ${files.length} memory files`);

  // 2. Process each file
  let previousMemoryIds: string[] = [];

  for (const file of files) {
    try {
      logger.info(`Processing: ${file.name}`);
      const content = await readFile(file.path, "utf-8");
      if (!content.trim()) continue;
      result.files_read++;

      // Extract facts from file content
      const facts = subagentRunner
        ? await smartExtract(content, file.name, subagentRunner)
        : simpleExtract(content, file.name);

      result.facts_extracted += facts.length;

      // Save each fact
      const newMemoryIds: string[] = [];
      for (const fact of facts) {
        try {
          const saved = await saveMemory({
            content: fact.content,
            category: fact.category,
            salience: fact.salience,
            scope: fact.scope,
            source_type: "workspace",
          }, subagentRunner);

          if (saved.action !== "NOOP") {
            result.memories_created++;
            newMemoryIds.push(saved.memory_id);
          }
        } catch (error) {
          result.errors.push(`Save failed for "${fact.content.slice(0, 50)}...": ${error}`);
        }
      }

      // Link memories from this file to memories from the previous file
      if (previousMemoryIds.length > 0 && newMemoryIds.length > 0) {
        try {
          await linkNodes({
            from_id: newMemoryIds[0],
            to_id: previousMemoryIds[previousMemoryIds.length - 1],
            type: "follows",
            reason: `Chronological: ${file.name} follows previous file`,
            created_by: "compact",
          });
          result.relationships_created++;
        } catch {
          // Non-critical — skip
        }
      }

      // Ask subagent to find relationships BETWEEN memories from this file
      if (subagentRunner && newMemoryIds.length >= 2) {
        const newRelationships = await discoverRelationships(
          newMemoryIds,
          subagentRunner,
        );
        result.relationships_created += newRelationships;
      }

      previousMemoryIds = newMemoryIds;
    } catch (error) {
      result.errors.push(`Failed to process ${file.name}: ${error}`);
    }
  }

  logger.info(
    `Migration complete: ${result.files_read} files, ${result.facts_extracted} facts, ` +
    `${result.memories_created} memories, ${result.relationships_created} relationships`,
  );

  return result;
}

/**
 * Import a single file into Qmemory.
 * Useful as an agent tool — the agent can call this for specific files.
 */
export async function importFile(
  filePath: string,
  subagentRunner?: SubagentRunner,
): Promise<{ facts_extracted: number; memories_created: number }> {
  const content = await readFile(filePath, "utf-8");
  const fileName = basename(filePath);

  const facts = subagentRunner
    ? await smartExtract(content, fileName, subagentRunner)
    : simpleExtract(content, fileName);

  let memoriesCreated = 0;
  for (const fact of facts) {
    const saved = await saveMemory({
      content: fact.content,
      category: fact.category,
      salience: fact.salience,
      scope: fact.scope,
      source_type: "workspace",
    }, subagentRunner);

    if (saved.action !== "NOOP") memoriesCreated++;
  }

  return { facts_extracted: facts.length, memories_created: memoriesCreated };
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

interface MemoryFile {
  name: string;
  path: string;
  date?: string; // YYYY-MM-DD if daily file
}

async function collectMemoryFiles(workspacePath: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];

  // 1. MEMORY.md (oldest — curated long-term memory)
  try {
    const memoryMdPath = join(workspacePath, "MEMORY.md");
    await readFile(memoryMdPath, "utf-8"); // Check it exists
    files.push({ name: "MEMORY.md", path: memoryMdPath });
  } catch {
    // MEMORY.md doesn't exist — that's fine
  }

  // 2. memory/*.md files (sorted by date, oldest first)
  try {
    const memoryDir = join(workspacePath, "memory");
    const entries = await readdir(memoryDir);
    const mdFiles = entries
      .filter((f) => f.endsWith(".md"))
      .sort(); // Alphabetical = chronological for YYYY-MM-DD names

    for (const f of mdFiles) {
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
      files.push({
        name: f,
        path: join(memoryDir, f),
        date: dateMatch?.[1],
      });
    }
  } catch {
    // memory/ directory doesn't exist
  }

  return files;
}

// ---------------------------------------------------------------------------
// Extraction modes
// ---------------------------------------------------------------------------

/** Smart extraction — uses LLM to extract structured facts */
async function smartExtract(
  content: string,
  fileName: string,
  subagentRunner: SubagentRunner,
): Promise<ExtractedFact[]> {
  const prompt = `You are reading a memory file from an AI assistant.
File name: ${fileName}

Extract ALL important facts as a JSON array. Each fact should be:
- One clear, standalone sentence
- Categorized as: style, preference, context, decision, idea, feedback, or domain
- Scored by salience (0.0-1.0): 0.3=trivial, 0.5=normal, 0.8=important, 1.0=critical
- Scoped: "global" unless clearly about a specific project

IMPORTANT: Read carefully and preserve nuance. Extract from OLDEST to NEWEST.
If a fact contradicts an earlier fact, extract BOTH — the system handles contradictions.

Content:
${content.slice(0, 6000)}

Return JSON only:
[{"content": "...", "category": "...", "salience": 0.5, "scope": "global", "entities": ["..."]}]`;

  try {
    const response = await subagentRunner(prompt);
    // Parse JSON from response (handle markdown code fences)
    const cleaned = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return simpleExtract(content, fileName);
    return JSON.parse(jsonMatch[0]) as ExtractedFact[];
  } catch (error) {
    logger.warn(`Smart extraction failed for ${fileName}, falling back to simple: ${error}`);
    return simpleExtract(content, fileName);
  }
}

/** Simple extraction — each non-empty line becomes a memory */
function simpleExtract(content: string, fileName: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.replace(/^[-*#>\s]+/, "").trim();
    // Skip empty lines, headers, and very short lines
    if (!trimmed || trimmed.length < 10) continue;
    // Skip markdown formatting lines
    if (trimmed.startsWith("---") || trimmed.startsWith("```")) continue;

    facts.push({
      content: trimmed,
      category: guessCategory(trimmed),
      salience: 0.5,
      scope: "global",
    });
  }

  return facts;
}

/** Simple heuristic to guess category from content */
function guessCategory(text: string): ExtractedFact["category"] {
  const lower = text.toLowerCase();
  if (lower.includes("prefer") || lower.includes("يفضل")) return "preference";
  if (lower.includes("decided") || lower.includes("chose") || lower.includes("قرر")) return "decision";
  if (lower.includes("plan") || lower.includes("will") || lower.includes("خطة")) return "idea";
  if (lower.includes("actually") || lower.includes("correct") || lower.includes("في الحقيقة")) return "feedback";
  if (lower.includes("style") || lower.includes("أسلوب")) return "style";
  return "context";
}

// ---------------------------------------------------------------------------
// Post-import relationship discovery
// ---------------------------------------------------------------------------

/**
 * Ask subagent to find relationships between imported memories.
 * Runs AFTER facts are saved, so we can link them immediately
 * instead of waiting for the background linker (5 min).
 */
async function discoverRelationships(
  memoryIds: string[],
  subagentRunner: SubagentRunner,
): Promise<number> {
  if (memoryIds.length < 2) return 0;

  // Fetch the memories we just created
  const idList = memoryIds.map(id => `type::record("${id}")`).join(", ");
  const memories = await query<{ id: string; content: string }>(
    `SELECT id, content FROM memory WHERE id IN [${idList}] AND is_active = true;`,
  );

  if (!memories || memories.length < 2) return 0;

  const prompt = `You are analyzing memories that were just imported from a file.
Find relationships between them.

MEMORIES:
${memories.map(m => `[${m.id}] ${m.content}`).join("\n")}

For each relationship you find, return a JSON array:
[
  {
    "from_id": "memory:xxx",
    "to_id": "memory:yyy",
    "type": "supports|contradicts|elaborates|depends_on|caused_by|follows|blocks",
    "reason": "Brief explanation"
  }
]

Rules:
- Only create relationships that are clearly justified
- Use any relationship type that fits (not limited to the examples above)
- If a newer fact contradicts an older one, use "contradicts"
- If a fact adds detail to another, use "elaborates"
- If no relationships exist, return: []

Return JSON only:`;

  try {
    const response = await subagentRunner(prompt);
    const cleaned = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    const relationships = JSON.parse(jsonMatch[0]) as Array<{
      from_id: string;
      to_id: string;
      type: string;
      reason?: string;
    }>;

    let created = 0;
    for (const rel of relationships) {
      // Validate both IDs exist in our set
      if (!memoryIds.includes(rel.from_id) && !memoryIds.includes(rel.to_id)) continue;

      try {
        await linkNodes({
          from_id: rel.from_id,
          to_id: rel.to_id,
          type: rel.type,
          reason: rel.reason,
          created_by: "compact",
        });
        created++;
      } catch {
        // Skip invalid links
      }
    }

    if (created > 0) {
      logger.info(`Import: discovered ${created} relationships between imported memories`);
    }
    return created;
  } catch (error) {
    logger.warn(`Import relationship discovery failed: ${error}`);
    return 0;
  }
}

/**
 * LLM-Driven Deduplication
 *
 * When a new fact arrives, we need to decide:
 *   ADD    — brand new information, create a new memory
 *   UPDATE — supersedes an existing memory (soft-delete old, create new)
 *   NOOP   — already known, skip entirely
 *
 * Two modes:
 *   1. LLM-driven (via SubagentRunner) — most accurate
 *   2. Rule-based fallback — works offline, no API calls
 *
 * The SubagentRunner is a function the caller provides.
 * Inside OpenClaw it wraps api.runtime.subagent.run().
 * In standalone mode it can be any (task) => Promise<string> function.
 */

import type { Memory, DedupDecision, DedupAction } from "../config.js";
import { consoleLogger } from "../config.js";
import type { QmemoryLogger } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A function that sends a prompt to an LLM and returns the text response */
export type SubagentRunner = (task: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Module-level logger (can be replaced)
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setDedupLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Decide whether a new fact should be ADDed, UPDATEd over an existing
 * memory, or skipped entirely (NOOP).
 *
 * @param newFact          - The new fact content string
 * @param existingMemories - Candidate matches from BM25 search
 * @param subagentRunner   - Optional LLM function for smart dedup
 * @param context          - Optional metadata about the new fact (category,
 *                           confidence, source_person, evidence_type) used to
 *                           make smarter decisions (e.g. hypothesis vs confirmed fact)
 * @returns A DedupDecision with action, optional target_id, and confidence
 */
export async function dedup(
  newFact: string,
  existingMemories: Memory[],
  subagentRunner?: SubagentRunner,
  context?: {
    category?: string;
    confidence?: number;
    source_person?: string;
    evidence_type?: string;
  },
): Promise<DedupDecision> {
  // No existing memories → definitely ADD
  if (existingMemories.length === 0) {
    logger.debug("Dedup: no existing memories — ADD");
    return { action: "ADD", related: [], confidence: 1.0 };
  }

  // Try LLM-driven dedup first (most accurate)
  if (subagentRunner) {
    try {
      // Pass context so the LLM can apply evidence-aware rules
      return await llmDedup(newFact, existingMemories, subagentRunner, context);
    } catch (error) {
      logger.warn(`LLM dedup failed, falling back to rules: ${error}`);
      // Fall through to rule-based
    }
  }

  // Rule-based fallback (no LLM needed)
  return ruleBasedDedup(newFact, existingMemories);
}

// ---------------------------------------------------------------------------
// LLM-driven dedup
// ---------------------------------------------------------------------------

async function llmDedup(
  newFact: string,
  existingMemories: Memory[],
  subagentRunner: SubagentRunner,
  context?: { category?: string; confidence?: number; source_person?: string; evidence_type?: string },
): Promise<DedupDecision> {
  // Build the prompt with the new fact + existing candidates
  const existingList = existingMemories
    .map((m, i) => `  ${i + 1}. [${m.id}] ${m.content}`)
    .join("\n");

  const prompt = `You are a memory deduplication engine. Compare the NEW fact against EXISTING memories and decide:

- ADD: The new fact contains genuinely new information not covered by any existing memory.
- UPDATE: The new fact supersedes or corrects an existing memory (provide the target_id to replace).
- NOOP: The new fact is already fully captured by an existing memory.

IMPORTANT RULES:
- A hypothesis (confidence < 0.5) should NEVER auto-replace a confirmed fact
- Two memories from DIFFERENT sources are not duplicates even if similar —
  they are corroborating evidence (use "supports" relationship)
- A "self" category memory about agent behavior is NEVER a duplicate of a
  "context" memory about the world, even if they overlap
- If the new fact UPDATES an existing fact, preserve the source_person chain

NEW FACT:
"${newFact}" [category: ${context?.category ?? "unknown"}, confidence: ${context?.confidence ?? "0.8"}, source: ${context?.source_person ?? "unknown"}]

EXISTING MEMORIES:
${existingList}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "action": "ADD" | "UPDATE" | "NOOP",
  "target_id": "memory:xxx or null",
  "confidence": 0.0 to 1.0,
  "related": [{"id": "memory:xxx", "type": "supports|contradicts|elaborates"}]
}`;

  logger.debug("Dedup: sending to LLM for dedup decision");
  const response = await subagentRunner(prompt);

  // Parse the JSON response from the LLM
  const parsed = parseJsonResponse(response);

  // Validate the action is one of our expected values
  if (!isValidAction(parsed.action)) {
    logger.warn(`LLM returned invalid action "${parsed.action}", defaulting to ADD`);
    return { action: "ADD", related: [], confidence: 0.5 };
  }

  return {
    action: parsed.action as DedupAction,
    target_id: typeof parsed.target_id === "string" ? parsed.target_id : undefined,
    related: Array.isArray(parsed.related) ? parsed.related : [],
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
  };
}

// ---------------------------------------------------------------------------
// Rule-based fallback
// ---------------------------------------------------------------------------

/**
 * Simple rule-based dedup when no LLM is available.
 * Uses string comparison heuristics:
 *   - Exact match → NOOP
 *   - >80% substring overlap → UPDATE (the existing memory is close enough)
 *   - Otherwise → ADD
 */
function ruleBasedDedup(
  newFact: string,
  existingMemories: Memory[],
): DedupDecision {
  const normalizedNew = normalize(newFact);

  for (const existing of existingMemories) {
    const normalizedExisting = normalize(existing.content);

    // Exact match — already known
    if (normalizedNew === normalizedExisting) {
      logger.debug(`Dedup rule: exact match with ${existing.id} — NOOP`);
      return {
        action: "NOOP",
        target_id: existing.id,
        related: [{ id: existing.id, type: "supports" }],
        confidence: 1.0,
      };
    }

    // High overlap — likely an update to existing memory
    const overlap = substringOverlap(normalizedNew, normalizedExisting);
    if (overlap > 0.8) {
      logger.debug(
        `Dedup rule: ${Math.round(overlap * 100)}% overlap with ${existing.id} — UPDATE`,
      );
      return {
        action: "UPDATE",
        target_id: existing.id,
        related: [{ id: existing.id, type: "elaborates" }],
        confidence: overlap,
      };
    }
  }

  // No close matches — genuinely new
  logger.debug("Dedup rule: no close matches — ADD");
  return { action: "ADD", related: [], confidence: 0.8 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize text for comparison: lowercase, collapse whitespace, trim */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Calculate the substring overlap ratio between two strings.
 * Uses word-level intersection / union (Jaccard similarity).
 */
function substringOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));

  // Count words that appear in both
  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  // Union = total unique words across both
  const union = new Set([...wordsA, ...wordsB]).size;

  if (union === 0) return 0;
  return intersection / union;
}

/** Try to parse a JSON response from the LLM, handling markdown fences */
function parseJsonResponse(response: string): Record<string, unknown> {
  // Strip markdown code fences if present (```json ... ```)
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON object within the response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Could not parse LLM response as JSON: ${cleaned.slice(0, 200)}`);
  }
}

/** Check if a string is a valid DedupAction */
function isValidAction(action: unknown): boolean {
  return action === "ADD" || action === "UPDATE" || action === "NOOP";
}

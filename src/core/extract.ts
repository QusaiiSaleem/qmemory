/**
 * Memory Extraction from Conversations
 *
 * Takes a list of messages and extracts structured facts
 * using an LLM (via SubagentRunner).
 *
 * Each extracted fact includes:
 *   - content:    A single, clear factual statement
 *   - category:   One of the 7 memory categories
 *   - salience:   Importance score 0.0 - 1.0
 *   - scope:      Visibility ("global", "project:xxx", "topic:xxx")
 *   - entities:   Names of people/projects/concepts mentioned
 *
 * Graceful degradation: if no SubagentRunner is provided,
 * returns an empty array (extraction requires an LLM).
 */

import { consoleLogger, MEMORY_CATEGORIES } from "../config.js";
import type {
  Message,
  ExtractedFact,
  MemoryCategory,
  QmemoryLogger,
} from "../config.js";
import type { SubagentRunner } from "./dedup.js";

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setExtractLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Extract structured facts from a conversation.
 *
 * @param messages        - The conversation messages to extract from
 * @param subagentRunner  - LLM function to perform extraction (optional)
 * @returns Array of extracted facts, or empty if no LLM available
 */
export async function extractMemories(
  messages: Message[],
  subagentRunner?: SubagentRunner,
): Promise<ExtractedFact[]> {
  // No LLM available — graceful degradation
  if (!subagentRunner) {
    logger.debug("Extract: no subagentRunner provided — returning empty");
    return [];
  }

  // Skip extraction for very short conversations (nothing to extract)
  if (messages.length < 2) {
    logger.debug("Extract: fewer than 2 messages — skipping");
    return [];
  }

  // --- Build the conversation text for the LLM ---
  const conversationText = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  const categoryList = MEMORY_CATEGORIES.join(", ");

  const prompt = `You are a memory extraction engine. Read the conversation below and extract key facts worth remembering across future sessions.

Rules:
- Each fact must be a single, clear, self-contained statement
- Only extract information that would be useful in future conversations
- Skip greetings, pleasantries, and trivial exchanges
- Category must be one of: ${categoryList}
- Salience: 0.0 (trivial) to 1.0 (critical). Most facts are 0.4-0.7
- Scope: "global" unless the fact is clearly about a specific project or topic
- Entities: list any people, projects, organizations, or systems mentioned

EXTERNAL REFERENCES — watch for mentions of:
- Emails (HEY, Gmail): extract entity with type "email", include subject/sender
- Tasks (Apple Reminders): extract entity with type "task", include list name
- Calendar events: extract entity with type "event", include date/time
- Smartsheet rows: extract entity with type "smartsheet", include sheet name
- Railway deployments: extract entity with type "deployment", include service name
- URLs or documents: extract entity with type "document"

For external references, include "external_source" (e.g. "hey", "apple-reminders", "smartsheet", "railway", "calendar") in the entity entry.

CONVERSATION:
${conversationText}

Respond with ONLY a JSON array (no markdown, no explanation):
[
  {
    "content": "The single fact statement",
    "category": "context",
    "salience": 0.6,
    "scope": "global",
    "entities": [
      {"name": "entity_name", "type": "person"},
      {"name": "Budget approval email", "type": "email", "external_source": "hey"}
    ]
  }
]

If no facts worth extracting, respond with: []`;

  try {
    logger.debug(`Extract: sending ${messages.length} messages to LLM`);
    const response = await subagentRunner(prompt);

    // Parse the LLM response
    const facts = parseExtractedFacts(response);
    logger.info(`Extract: LLM returned ${facts.length} facts`);
    return facts;
  } catch (error) {
    logger.error(`Extract: LLM extraction failed: ${error}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the LLM response into validated ExtractedFact objects.
 * Handles markdown code fences and validates each fact's structure.
 */
function parseExtractedFacts(response: string): ExtractedFact[] {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
  }

  let parsed: unknown[];
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find a JSON array within the response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      logger.warn("Extract: could not parse LLM response as JSON array");
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    logger.warn("Extract: LLM response is not an array");
    return [];
  }

  // Validate and normalize each fact
  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const facts: ExtractedFact[] = [];

  for (const item of parsed) {
    if (!isFactLike(item)) continue;

    // Validate category — fall back to "context" if unrecognized
    const category: MemoryCategory = validCategories.has(item.category)
      ? (item.category as MemoryCategory)
      : "context";

    // Clamp salience to 0.0 - 1.0
    const salience = Math.max(0, Math.min(1, Number(item.salience) || 0.5));

    facts.push({
      content: String(item.content).trim(),
      category,
      salience,
      scope: typeof item.scope === "string" ? item.scope : "global",
      entities: Array.isArray(item.entities)
        ? item.entities.map(String)
        : undefined,
    });
  }

  return facts;
}

/** Type guard: does this object have the minimum fields for a fact? */
function isFactLike(
  item: unknown,
): item is { content: string; category: string; salience: number; scope?: string; entities?: unknown[] } {
  return (
    typeof item === "object" &&
    item !== null &&
    "content" in item &&
    typeof (item as Record<string, unknown>).content === "string" &&
    (item as Record<string, unknown>).content !== ""
  );
}

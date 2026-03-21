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
 * @param options         - Optional settings (discoveryMode for new relationships)
 * @returns Array of extracted facts, or empty if no LLM available
 */
export async function extractMemories(
  messages: Message[],
  subagentRunner?: SubagentRunner,
  options?: { discoveryMode?: boolean },
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
  // Filter out messages that look like extraction prompts/responses (prevent recursion loop)
  const filteredMessages = messages.filter((m) => {
    const content = m.content;
    // Skip messages that ARE extraction prompts or their JSON responses
    if (content.includes("You are a memory extraction engine")) return false;
    if (content.includes("memory extraction engine")) return false;
    if (content.includes("You are the memory system for an AI agent")) return false;
    if (content.includes("memory system for an AI agent")) return false;
    // Skip pure JSON array responses (extraction output)
    const trimmed = content.trim();
    if (trimmed.startsWith("[{") && trimmed.endsWith("}]") && trimmed.includes('"category"')) return false;
    if (trimmed === "[]") return false;
    return true;
  });

  if (filteredMessages.length < 2) {
    logger.debug("Extract: after filtering extraction artifacts, fewer than 2 messages — skipping");
    return [];
  }

  const conversationText = filteredMessages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n");

  // --- Build discovery mode section (extra-aggressive extraction for new relationships) ---
  const discoveryModeSection = options?.discoveryMode
    ? `DISCOVERY MODE — This is a new relationship. Extract AGGRESSIVELY:
- User's name, role, responsibilities, organization
- Projects they work on, tools they use daily
- Communication style (formal/casual, which language for what)
- People they mention and those people's roles/relationships
- Preferences about how the agent should behave
- Any corrections or feedback → save as category "self"
- Patterns in how they ask questions or give instructions

Use HIGHER salience than normal: 0.6+ for identity facts, 0.8+ for preferences.
Every piece of identity information matters in a new relationship.`
    : "";

  const prompt = `You are the memory system for an AI agent. You extract knowledge from conversations
that will persist across sessions — this is how the agent builds its brain over time.

You extract THREE types of knowledge:
1. WORLD KNOWLEDGE — facts, decisions, events, project info
2. USER KNOWLEDGE — who the user is, preferences, communication style
3. SELF KNOWLEDGE — what the agent should learn about its own behavior

Rules:
- Each fact must be a single, clear, self-contained statement
- Only extract information useful in future conversations
- Skip greetings, pleasantries, and trivial exchanges
- ALWAYS note WHO said something (source_person) when identifiable
- ALWAYS assess confidence: was this stated definitively or tentatively?
- When the user corrects the agent or expresses how they want to be communicated with,
  extract this as category "self" — the agent is learning about itself

Categories: ${MEMORY_CATEGORIES.join(", ")}
Evidence types:
- "observed" — agent directly saw this happen (tool output, action result)
- "reported" — someone stated this (may or may not be verified)
- "inferred" — agent concluded this from multiple signals
- "self" — agent learning about its own behavior or effectiveness

Context moods (when identifiable):
- "calm_decision" — deliberate choice in normal discussion
- "heated_discussion" — said during disagreement or frustration
- "brainstorm" — exploratory, not committed
- "correction" — user fixing a mistake
- "casual" — passing mention, not emphasized
- "urgent" — time-pressured decision

SELF-LEARNING — watch for these signals:
- User says "don't do X" or "stop doing X" → self memory about what to avoid
- User says "yes exactly" or "perfect" → self memory about what works
- User switches language mid-conversation → self memory about language preference
- User ignores a long response but engages with a short one → self memory about length
- User corrects a fact → feedback memory about the correction + self memory about being careful with that topic

EXTERNAL REFERENCES — watch for mentions of:
- Emails (HEY, Gmail): entity type "email", include subject/sender
- Tasks (Apple Reminders): entity type "task", include list name
- Calendar events: entity type "event", include date/time
- Smartsheet rows: entity type "smartsheet", include sheet name
- Railway deployments: entity type "deployment", include service name
- URLs or documents: entity type "document"

For external references, include "external_source" in the entity entry.

${discoveryModeSection}

CONVERSATION:
${conversationText}

Respond with ONLY a JSON array (no markdown, no explanation):
[
  {
    "content": "Budget approved at 500K SAR for MAZJ project",
    "category": "decision",
    "salience": 0.8,
    "scope": "project:mazj",
    "confidence": 0.9,
    "source_person": "Qusai",
    "evidence_type": "reported",
    "context_mood": "calm_decision",
    "entities": [
      {"name": "Qusai", "type": "person"},
      {"name": "MAZJ", "type": "project"}
    ]
  },
  {
    "content": "User prefers concise responses — said 'don't over-explain'",
    "category": "self",
    "salience": 0.8,
    "scope": "global",
    "confidence": 0.95,
    "evidence_type": "self",
    "context_mood": "correction"
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
      confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : undefined,
      source_person: typeof item.source_person === "string" ? item.source_person : undefined,
      evidence_type: typeof item.evidence_type === "string" ? item.evidence_type : undefined,
      context_mood: typeof item.context_mood === "string" ? item.context_mood : undefined,
      entities: Array.isArray(item.entities)
        ? item.entities.map((e) =>
            typeof e === "string" ? e
            : typeof e === "object" && e !== null && "name" in e ? e as import("../config.js").ExtractedEntityRef
            : String(e))
        : undefined,
    });
  }

  return facts;
}

/** Type guard: does this object have the minimum fields for a fact? */
function isFactLike(
  item: unknown,
): item is { content: string; category: string; salience: number; scope?: string; confidence?: number; source_person?: string; evidence_type?: string; context_mood?: string; entities?: unknown[] } {
  return (
    typeof item === "object" &&
    item !== null &&
    "content" in item &&
    typeof (item as Record<string, unknown>).content === "string" &&
    (item as Record<string, unknown>).content !== ""
  );
}

/**
 * Memory formatting for system prompt injection
 *
 * Formats memories as structured text with evidence markers.
 */

import type { RecalledMemory } from "../types.js";
import { getAge } from "./budget.js";

/**
 * Format a single memory line with evidence markers.
 *
 * Evidence markers provide at-a-glance provenance:
 *   - Source person: "— Qusai reported" (when source_person is set)
 *   - Confidence: "⚑0.8" (when confidence < 1.0)
 *   - Contradiction: "⚠︎" prefix (when is_contradicted is true)
 *   - Recall count: "4× recalled" (for self memories with recall_count > 1)
 */
function formatMemoryLine(m: RecalledMemory): string {
  const shortId = String(m.id).replace("memory:", "");
  const marker = m.salience >= 0.8 ? "!" : "";
  const scope = m.scope && m.scope !== "global" ? ` [${m.scope}]` : "";
  const age = getAge(m.created_at);

  // Evidence markers
  const contradictMark = m.is_contradicted ? "⚠︎" : "";

  // Source attribution — who said or inferred this fact
  let sourceMark = "";
  if (m.source_person) {
    // Extract person name from record ID if possible
    const personName = String(m.source_person).replace("entity:", "").replace(/^p_/, "");
    const evidenceVerb = m.evidence_type === "reported" ? "reported"
      : m.evidence_type === "inferred" ? "inferred"
      : "stated";
    sourceMark = ` — ${personName} ${evidenceVerb}`;
  } else if (m.evidence_type === "inferred") {
    sourceMark = " — inferred";
  } else if (m.evidence_type === "self") {
    sourceMark = " — self-learned";
  }

  // Confidence marker (show when < 1.0 and defined)
  const confMark = (m.confidence !== undefined && m.confidence < 1.0)
    ? ` ⚑${m.confidence.toFixed(1)}` : "";

  // Recall count (for self memories only — shows reinforcement)
  const recallMark = (m.category === "self" && m.recall_count > 1)
    ? `, ${m.recall_count}× recalled` : "";

  return `- [${shortId}] ${contradictMark}${marker}${m.content}${scope}${sourceMark}${confMark}${age}${recallMark}`;
}

/**
 * Format memories as a structured graph map for system prompt injection.
 *
 * Layout:
 *   1. Self-Model section (agent's self-knowledge) — always first
 *   2. Main memories grouped by category
 *   3. Hypotheses section (confidence < 0.5) — flagged as unconfirmed
 *   4. Tools guide (first message only)
 *
 * Each line carries evidence markers: source, confidence, contradiction flag.
 *
 * @param includeToolsGuide - true on first message of session, false after
 */
export function formatMemories(
  memories: RecalledMemory[],
  includeToolsGuide = false,
): string {
  if (memories.length === 0 && !includeToolsGuide) return "";

  const sections: string[] = [];

  // --- Self-Model section (always first) ---
  const selfMemories = memories.filter(m => m.category === "self");
  if (selfMemories.length > 0) {
    sections.push("## Agent Self-Model");
    sections.push("_How I work best with this user_");
    for (const m of selfMemories) {
      sections.push(formatMemoryLine(m));
    }
  }

  // --- Main memories (excluding self and hypotheses) ---
  const mainMemories = memories.filter(m =>
    m.category !== "self" &&
    !(m.confidence !== undefined && m.confidence < 0.5)
  );

  // Group by category
  const groups: Record<string, RecalledMemory[]> = {};
  for (const m of mainMemories) {
    const cat = m.category || "context";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(m);
  }

  // Category display order and labels
  const categoryOrder: Array<{ key: string; label: string }> = [
    { key: "decision", label: "Decisions & Rules" },
    { key: "preference", label: "Preferences" },
    { key: "style", label: "Communication Style" },
    { key: "feedback", label: "Corrections" },
    { key: "context", label: "Key Facts" },
    { key: "idea", label: "Plans & Ideas" },
    { key: "domain", label: "Domain Knowledge" },
  ];

  sections.push("", `## Cross-Session Memory`);
  sections.push(`_${memories.length} memories from all sessions_`);

  for (const { key, label } of categoryOrder) {
    const items = groups[key];
    if (!items || items.length === 0) continue;
    sections.push("", `### ${label}`);
    for (const m of items) {
      sections.push(formatMemoryLine(m));
    }
  }

  // --- Hypotheses section (confidence < 0.5, not self) ---
  const hypotheses = memories.filter(m =>
    m.category !== "self" &&
    m.confidence !== undefined && m.confidence < 0.5
  );
  if (hypotheses.length > 0) {
    sections.push("", "### Hypotheses (unconfirmed)");
    for (const m of hypotheses) {
      sections.push(formatMemoryLine(m));
    }
  }

  // Tools guide only on first message
  if (includeToolsGuide) {
    sections.push(
      "",
      "### Memory Tools",
      "- `qmemory_save` — Save facts/decisions/corrections/self-knowledge (auto-dedup)",
      "- `qmemory_search` — Deep search by meaning, category, or scope",
      "- `qmemory_link` — Create relationships between any two things",
      "- `qmemory_correct` — Fix, update, delete, or unlink",
      "- `qmemory_person` — Create/find people with linked contacts",
      "- `qmemory_import` — Import a markdown file into the graph",
    );
  }

  return sections.join("\n");
}

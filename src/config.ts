/**
 * Qmemory Configuration & Types
 *
 * Single source of truth for all types used across
 * core/, openclaw/, mcp/, and cli entry points.
 */

// ---------------------------------------------------------------------------
// Plugin config (from openclaw.plugin.json configSchema)
// ---------------------------------------------------------------------------

export interface QmemoryConfig {
  surrealdb_url: string;
  surrealdb_user: string;
  surrealdb_pass: string;
  namespace: string;
  database: string;
  context_threshold: number;
  fresh_tail_count: number;
  memory_budget_pct: number;
  embedding_provider: "voyage" | "openai" | "none";
  embedding_api_key?: string;
  embedding_model: string;
  embedding_dimension: number;
  linker_interval_ms: number;
  reflect_interval_ms: number;
  min_salience_recall: number;
  debug: boolean;
}

export const DEFAULT_CONFIG: QmemoryConfig = {
  surrealdb_url: "ws://localhost:8000",
  surrealdb_user: "root",
  surrealdb_pass: "root",
  namespace: "qmemory",
  database: "main",
  context_threshold: 0.75,
  fresh_tail_count: 32,
  memory_budget_pct: 0.15,
  embedding_provider: "none",
  embedding_model: "voyage-3",
  embedding_dimension: 1024,
  linker_interval_ms: 300_000,    // 5 minutes
  reflect_interval_ms: 1_800_000, // 30 minutes
  min_salience_recall: 0.3,
  debug: false,
};

// ---------------------------------------------------------------------------
// Memory categories (7 types, from new-R)
// ---------------------------------------------------------------------------

export const MEMORY_CATEGORIES = [
  "style",       // Communication preferences
  "preference",  // General preferences
  "context",     // Facts about projects/orgs
  "decision",    // Past decisions made
  "idea",        // Future plans/suggestions
  "feedback",    // User corrections
  "domain",      // Sector/domain knowledge
] as const;

export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

// ---------------------------------------------------------------------------
// Node types (4 tables in SurrealDB)
// ---------------------------------------------------------------------------

export interface Session {
  id: string;           // session:xxx
  session_key: string;  // agent:main:telegram:group:xxx:topic:xxx
  channel: string;      // "telegram", "whatsapp", "dm"
  chat_type: string;    // "direct", "group", "cron", "subagent"
  topic_id?: string;    // Telegram topic ID
  group_id?: string;    // Telegram group ID
  scope: string;        // "global", "project:xxx", "topic:xxx"
  last_active: string;  // ISO datetime
  created_at: string;
}

export interface Message {
  id: string;            // message:xxx
  session: string;       // FK → session:xxx
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: unknown[];
  tool_name?: string;
  token_count: number;
  created_at: string;
}

export interface Memory {
  id: string;             // memory:xxx
  content: string;        // One clear fact
  category: MemoryCategory;
  salience: number;       // 0.0 - 1.0 importance
  valid_from?: string;    // When fact became true (ISO)
  valid_until?: string;   // When fact expired (ISO)
  scope: string;          // "global", "project:xxx", "topic:xxx"
  is_active: boolean;     // Soft-delete flag
  confidence: number;     // LLM confidence 0.0 - 1.0
  source_type: "conversation" | "workspace" | "agent" | "linker" | "reflect" | "cron";
  prev_version?: string;  // FK → memory:xxx (version chain)
  embedding?: number[];   // Optional vector
  created_at: string;
  updated_at: string;
}

export interface Entity {
  id: string;                // entity:xxx
  name: string;
  type: string;              // Core: "person", "project", "org", "concept", "system", "topic"
                             // Contact: "contact" (linked to person via has_identity)
                             // External: "email", "task", "event", "document", "smartsheet", "deployment"
  aliases: string[];         // Alternative names
  external_id?: string;      // Reference ID: "966501234567", "ahmed@example.com", "user:789"
  external_url?: string;     // Direct URL: "https://wa.me/966501234567"
  external_source?: string;  // Source: "whatsapp", "telegram", "hey", "gmail", "smartsheet", etc.
  external_channel?: string; // Channel-specific ID: phone number, username, email address
  embedding?: number[];
  created_at: string;
  updated_at: string;
}

/**
 * Well-known external sources for contacts.
 * Used as values for entity.external_source when type = "contact".
 */
export const CONTACT_SOURCES = [
  "whatsapp",
  "telegram",
  "hey",
  "gmail",
  "apple-reminders",
  "calendar",
  "smartsheet",
  "railway",
  "linkedin",
  "github",
  "slack",
  "discord",
] as const;

export type ContactSource = typeof CONTACT_SOURCES[number];

// ---------------------------------------------------------------------------
// Tool call ledger
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;              // tool_call:xxx
  session: string;         // FK → session:xxx
  tool_name: string;
  input_summary: string;
  output_summary: string;
  duration_ms?: number;
  token_count: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Session scratchpad (working memory)
// ---------------------------------------------------------------------------

export interface Scratchpad {
  id: string;              // scratchpad:xxx
  session: string;         // FK → session:xxx
  task_progress: string;
  key_findings: string;
  open_questions: string;
  tool_summary: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Metrics tracking
// ---------------------------------------------------------------------------

export interface MetricsEvent {
  id: string;              // metrics:xxx
  session: string;         // FK → session:xxx
  event_type: string;
  event_data?: string;
  created_at: string;
}

export interface MetricsSummary {
  recall_hits: number;
  recall_misses: number;
  dedup_adds: number;
  dedup_updates: number;
  dedup_noops: number;
  tool_calls: number;
  compactions: number;
  extractions: number;
}

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

/** Structural edges (auto-created by system) */
export interface HasMessage {
  id: string;
  in: string;   // session:xxx
  out: string;  // message:xxx
  created_at: string;
}

export interface ExtractedFrom {
  id: string;
  in: string;   // memory:xxx
  out: string;  // message:xxx
  created_at: string;
}

export interface PrevVersion {
  id: string;
  in: string;   // memory:xxx (new)
  out: string;  // memory:xxx (old)
}

/** Dynamic edge (created by agent, linker, reflect, or compact) */
export interface Relates {
  id: string;
  in: string;        // any node
  out: string;       // any node
  type: string;      // ANY relationship: "supports", "manages", "blocks", etc.
  reason?: string;   // Why this relationship exists
  confidence: number;
  created_by: "agent" | "linker" | "compact" | "reflect";
  created_at: string;
}

// ---------------------------------------------------------------------------
// Dedup decisions (from LLM)
// ---------------------------------------------------------------------------

export type DedupAction = "ADD" | "UPDATE" | "NOOP";

export interface DedupDecision {
  action: DedupAction;
  target_id?: string;          // Only for UPDATE
  relationship_type?: string;  // Only for UPDATE
  related: Array<{
    id: string;
    type: string;  // "supports" | "contradicts" | "elaborates" | any
  }>;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Recall results
// ---------------------------------------------------------------------------

export interface RecallOptions {
  query?: string;
  categories?: MemoryCategory[];
  scope?: string;
  min_salience?: number;
  valid_at?: Date;
  limit?: number;
  token_budget?: number;
}

export interface RecalledMemory extends Memory {
  score?: number;       // Search relevance score
  source_session?: string; // Which session it came from
}

// ---------------------------------------------------------------------------
// Extract results (from LLM)
// ---------------------------------------------------------------------------

export interface ExtractedFact {
  content: string;
  category: MemoryCategory;
  salience: number;
  scope: string;
  entities?: Array<string | ExtractedEntityRef>;  // Simple name or rich reference
}

/** Rich entity reference — includes external source info */
export interface ExtractedEntityRef {
  name: string;
  type: string;              // "person", "email", "task", "event", "smartsheet", etc.
  external_source?: string;  // "hey", "apple-reminders", "smartsheet", "railway"
  external_id?: string;      // "hey:12345", "reminder:ABC"
  external_url?: string;     // Direct URL
}

// ---------------------------------------------------------------------------
// Logger interface (works with both OpenClaw and standalone)
// ---------------------------------------------------------------------------

export interface QmemoryLogger {
  debug: (msg: string, data?: unknown) => void;
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  error: (msg: string, data?: unknown) => void;
}

/** Console-based logger for standalone mode */
export const consoleLogger: QmemoryLogger = {
  debug: (msg, data) => console.debug(`[qmemory] ${msg}`, data ?? ""),
  info: (msg, data) => console.log(`[qmemory] ${msg}`, data ?? ""),
  warn: (msg, data) => console.warn(`[qmemory] ${msg}`, data ?? ""),
  error: (msg, data) => console.error(`[qmemory] ${msg}`, data ?? ""),
};

// ---------------------------------------------------------------------------
// Token estimation (rough, for budgeting)
// ---------------------------------------------------------------------------

/** ~4 chars per token (conservative estimate) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Trim memories to fit token budget */
export function fitToTokenBudget(
  memories: RecalledMemory[],
  maxTokens: number,
): RecalledMemory[] {
  const result: RecalledMemory[] = [];
  const seen = new Set<string>(); // Dedup by content similarity
  let tokens = 0;

  for (const mem of memories) {
    // Skip noise: very short, headers, file sizes, dates-only
    if (mem.content.length < 15) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(mem.content) && mem.content.length < 30) continue;
    if (/^\d+(\.\d+)?[KMG]?B?\s*[→←]/.test(mem.content)) continue;

    // Dedup: skip if we already have very similar content
    const normalized = mem.content.toLowerCase().replace(/\s+/g, " ").trim();
    const shortKey = normalized.slice(0, 60);
    if (seen.has(shortKey)) continue;
    seen.add(shortKey);

    const memTokens = estimateTokens(mem.content) + 20;
    if (tokens + memTokens > maxTokens) break;
    result.push(mem);
    tokens += memTokens;
  }

  return result;
}

/** Human-readable age: "2h ago", "3d ago", "2w ago" */
function getAge(isoDate: string): string {
  try {
    const ms = Date.now() - new Date(isoDate).getTime();
    if (ms < 0) return "";
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 1) return " (just now)";
    if (hours < 24) return ` (${hours}h ago)`;
    const days = Math.floor(hours / 24);
    if (days < 7) return ` (${days}d ago)`;
    const weeks = Math.floor(days / 7);
    return ` (${weeks}w ago)`;
  } catch {
    return "";
  }
}

/** Format recalled memories as markdown for system prompt injection */
/**
 * Format memories as a structured graph map for system prompt injection.
 *
 * Instead of a flat list, groups memories by category and shows
 * relationships — giving the agent a navigable world view.
 *
 * @param includeToolsGuide - true on first message of session, false after
 */
export function formatMemories(
  memories: RecalledMemory[],
  includeToolsGuide = false,
): string {
  if (memories.length === 0 && !includeToolsGuide) return "";

  // Group memories by category
  const groups: Record<string, RecalledMemory[]> = {};
  for (const m of memories) {
    const cat = m.category || "context";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(m);
  }

  // Category display order and labels
  const categoryOrder: Array<{ key: MemoryCategory; label: string }> = [
    { key: "decision", label: "Decisions & Rules" },
    { key: "preference", label: "Preferences" },
    { key: "style", label: "Communication Style" },
    { key: "feedback", label: "Corrections" },
    { key: "context", label: "Key Facts" },
    { key: "idea", label: "Plans & Ideas" },
    { key: "domain", label: "Domain Knowledge" },
  ];

  const sections: string[] = [
    "## Cross-Session Memory (Qmemory)",
    `_${memories.length} memories from all sessions_`,
  ];

  for (const { key, label } of categoryOrder) {
    const items = groups[key];
    if (!items || items.length === 0) continue;

    sections.push("", `### ${label}`);
    for (const m of items) {
      // Short ID for agent to reference in correct/link/delete calls
      const shortId = String(m.id).replace("memory:", "");
      const marker = m.salience >= 0.8 ? "!" : "";
      const scope = m.scope && m.scope !== "global" ? ` [${m.scope}]` : "";
      const expiry = m.valid_until ? ` (expires: ${m.valid_until})` : "";
      const age = getAge(m.created_at);
      sections.push(`- [${shortId}] ${marker}${m.content}${scope}${expiry}${age}`);
    }
  }

  // Tools guide only on first message
  if (includeToolsGuide) {
    sections.push(
      "",
      "### Memory Tools",
      "- `qmemory_save` — Save facts/decisions/corrections (auto-dedup)",
      "- `qmemory_search` — Deep search by meaning, category, or scope",
      "- `qmemory_link` — Create relationships between any two things",
      "- `qmemory_correct` — Fix, update, delete, or unlink",
      "- `qmemory_person` — Create/find people with linked contacts",
      "- `qmemory_import` — Import a markdown file into the graph",
    );
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Graph map format — shows entities + relationships as a navigable world
// ---------------------------------------------------------------------------

export interface GraphEntity {
  id: string;
  name: string;
  type: string;
  aliases?: string[];
  external_source?: string;
  external_id?: string;
  outgoing: number;
  incoming: number;
}

export interface GraphEdge {
  from_node: string;
  to_node: string;
  type: string;
  reason?: string;
}

export interface GraphStats {
  memories: number;
  entities: number;
  edges: number;
  sessions: number;
  orphans: number;
}

/**
 * Format the graph summary as a world map for the agent.
 * Shows entities grouped by type, relationships between them,
 * and a nudge about orphan memories that need linking.
 */
export function formatGraphMap(
  entities: GraphEntity[],
  edges: GraphEdge[],
  stats: GraphStats,
): string {
  if (entities.length === 0 && edges.length === 0) return "";

  const sections: string[] = [
    "### Knowledge Graph",
    `_${stats.entities} entities, ${stats.edges} relationships, ${stats.memories} memories_`,
  ];

  // Group entities by type
  const byType: Record<string, GraphEntity[]> = {};
  for (const e of entities) {
    const t = e.type || "other";
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }

  // Display order for entity types
  const typeLabels: Record<string, string> = {
    person: "People",
    project: "Projects",
    org: "Organizations",
    system: "Systems",
    concept: "Concepts",
    contact: "Contacts",
  };

  for (const [type, label] of Object.entries(typeLabels)) {
    const items = byType[type];
    if (!items || items.length === 0) continue;

    sections.push("", `**${label}**`);
    for (const e of items.slice(0, 10)) {
      // Find relationships for this entity
      const rels = edges.filter(
        (r) => String(r.from_node) === String(e.id) || String(r.to_node) === String(e.id),
      );
      const relStr = rels.slice(0, 3).map((r) => {
        const other = String(r.from_node) === String(e.id) ? String(r.to_node) : String(r.from_node);
        // Extract just the name part from record ID
        const otherName = other.split(":").slice(1).join(":");
        return `${r.type} → ${otherName}`;
      }).join(", ");

      const ext = e.external_source ? ` (${e.external_source})` : "";
      const connections = relStr ? ` | ${relStr}` : "";
      sections.push(`- ${e.name}${ext}${connections}`);
    }
  }

  // Show any remaining types not in the predefined list
  for (const [type, items] of Object.entries(byType)) {
    if (typeLabels[type] || items.length === 0) continue;
    sections.push("", `**${type}**`);
    for (const e of items.slice(0, 5)) {
      sections.push(`- ${e.name}`);
    }
  }

  // Orphan nudge — encourage agent to build relationships
  if (stats.orphans > 0) {
    sections.push(
      "",
      `_${stats.orphans} memories have no relationships yet. Use qmemory_link to connect them._`,
    );
  }

  return sections.join("\n");
}

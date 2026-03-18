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
  source_type: "conversation" | "workspace" | "agent" | "linker" | "reflect";
  prev_version?: string;  // FK → memory:xxx (version chain)
  embedding?: number[];   // Optional vector
  created_at: string;
  updated_at: string;
}

export interface Entity {
  id: string;               // entity:xxx
  name: string;
  type: string;             // Internal: "person", "project", "org", "concept", "system"
                            // External: "email", "task", "event", "document", "smartsheet", "deployment"
  aliases: string[];        // Alternative names
  external_id?: string;     // Reference ID: "hey:12345", "reminder:ABC", "smartsheet:row:789"
  external_url?: string;    // Direct URL: "https://app.hey.com/..."
  external_source?: string; // Source system: "hey", "apple-reminders", "smartsheet", "railway", "calendar"
  embedding?: number[];
  created_at: string;
  updated_at: string;
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
  let tokens = 0;

  for (const mem of memories) {
    const memTokens = estimateTokens(mem.content) + 20; // overhead per line
    if (tokens + memTokens > maxTokens) break;
    result.push(mem);
    tokens += memTokens;
  }

  return result;
}

/** Format recalled memories as markdown for system prompt injection */
export function formatMemories(memories: RecalledMemory[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const parts = [`[${m.category}`];
    if (m.salience >= 0.8) parts.push("!");        // critical marker
    parts.push(`] ${m.content}`);
    if (m.valid_until) parts.push(` (expires: ${m.valid_until})`);
    return `- ${parts.join("")}`;
  });

  return [
    "## Cross-Session Memory (Qmemory)",
    `_${memories.length} memories recalled, sorted by importance_`,
    "",
    ...lines,
  ].join("\n");
}

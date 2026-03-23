/**
 * Qmemory Type Definitions
 *
 * All interfaces and type definitions used across
 * core/, openclaw/, mcp/, and cli entry points.
 */

// ---------------------------------------------------------------------------
// Plugin config (from openclaw.plugin.json configSchema)
// ---------------------------------------------------------------------------

// Extraction mode presets
export type ExtractionMode = "economy" | "balanced" | "aggressive";

export interface ExtractionPreset {
  hourly_budget: number;           // Max extractions per hour
  score_threshold: number;         // Min score to extract (1-10)
  min_content_length: number;      // Min chars to consider
  dm_priority: number;             // DM channel bonus
  group_priority: number;          // Group channel bonus
  keyword_bonus: number;           // "remember", "note" bonus
  long_content_bonus: number;      // >500 chars bonus
  quiet_conversation_bonus: number; // <3 msgs/10min bonus
}

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
  subagent_model: string;
  // Extraction mode (simple preset)
  extraction_mode: ExtractionMode;
  debug: boolean;
}

// ---------------------------------------------------------------------------
// Memory categories (7 types, from new-R)
// ---------------------------------------------------------------------------

// MemoryCategory type — derived from the MEMORY_CATEGORIES const in constants.ts
// Duplicated here as a simple union to avoid circular imports
export type MemoryCategory =
  | "style"
  | "preference"
  | "context"
  | "decision"
  | "idea"
  | "feedback"
  | "domain"
  | "self";

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
  linked: boolean;        // Has been processed by linker (avoids expensive graph traversal)
  source_person?: string;   // record<entity> FK — who said this
  evidence_type: string;    // "observed" | "reported" | "inferred" | "self"
  recall_count: number;     // Biological memory counter — incremented each time this is retrieved
  last_recalled?: string;   // datetime of last recall
  context_mood?: string;    // "calm_decision" | "heated_discussion" | "brainstorm" | "correction" | "casual" | "urgent"
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
  is_contradicted?: boolean; // Flagged by assemble() when contradiction edges exist
}

// ---------------------------------------------------------------------------
// Extract results (from LLM)
// ---------------------------------------------------------------------------

export interface ExtractedFact {
  content: string;
  category: MemoryCategory;
  salience: number;
  scope: string;
  confidence?: number;             // LLM confidence in the fact (0.0 - 1.0)
  source_person?: string;          // Person name (resolved to entity later)
  evidence_type?: string;          // "observed" | "reported" | "inferred" | "self"
  context_mood?: string;           // "calm_decision" | "heated_discussion" | "brainstorm" | "correction" | "casual" | "urgent"
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

// ---------------------------------------------------------------------------
// Graph map types
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
  total_links?: number;
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

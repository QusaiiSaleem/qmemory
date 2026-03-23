/**
 * Qmemory Constants
 *
 * All constant values used across the codebase.
 */

import type { ExtractionMode, ExtractionPreset, QmemoryConfig, QmemoryLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Extraction presets
// ---------------------------------------------------------------------------

export const EXTRACTION_PRESETS: Record<ExtractionMode, ExtractionPreset> = {
  // economy: For Lite plans, minimal token usage
  economy: {
    hourly_budget: 2,
    score_threshold: 7,
    min_content_length: 300,
    dm_priority: 5,
    group_priority: 1,
    keyword_bonus: 5,
    long_content_bonus: 2,
    quiet_conversation_bonus: 2,
  },
  // balanced: For Pro plans, normal operation (default)
  balanced: {
    hourly_budget: 5,
    score_threshold: 4,
    min_content_length: 200,
    dm_priority: 4,
    group_priority: 1,
    keyword_bonus: 5,
    long_content_bonus: 2,
    quiet_conversation_bonus: 2,
  },
  // aggressive: For Team/Unlimited, extract everything
  aggressive: {
    hourly_budget: Infinity,
    score_threshold: 1,
    min_content_length: 100,
    dm_priority: 2,
    group_priority: 2,
    keyword_bonus: 5,
    long_content_bonus: 1,
    quiet_conversation_bonus: 1,
  },
};

// Keywords that trigger extraction regardless of score
export const EXTRACTION_KEYWORDS = [
  "remember", "note", "important", "don't forget", "save this",
  "keep in mind", "for the record", "just so you know"
];

// ---------------------------------------------------------------------------
// Default plugin config
// ---------------------------------------------------------------------------

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
  linker_interval_ms: 1_800_000,  // 30 minutes
  reflect_interval_ms: 1_800_000, // 30 minutes
  min_salience_recall: 0.3,
  subagent_model: "zai/glm-5",
  // Extraction mode (preset: economy/balanced/aggressive)
  extraction_mode: "balanced" as ExtractionMode,
  debug: false,
};

// ---------------------------------------------------------------------------
// Memory categories
// ---------------------------------------------------------------------------

export const MEMORY_CATEGORIES = [
  "style",       // Communication preferences
  "preference",  // General preferences
  "context",     // Facts about projects/orgs
  "decision",    // Past decisions made
  "idea",        // Future plans/suggestions
  "feedback",    // User corrections
  "domain",      // Sector/domain knowledge
  "self",        // Agent's self-knowledge (soul)
] as const;

// ---------------------------------------------------------------------------
// Console logger (for standalone mode)
// ---------------------------------------------------------------------------

/** Console-based logger for standalone mode */
export const consoleLogger: QmemoryLogger = {
  debug: (msg, data) => console.debug(`[qmemory] ${msg}`, data ?? ""),
  info: (msg, data) => console.log(`[qmemory] ${msg}`, data ?? ""),
  warn: (msg, data) => console.warn(`[qmemory] ${msg}`, data ?? ""),
  error: (msg, data) => console.error(`[qmemory] ${msg}`, data ?? ""),
};

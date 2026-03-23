/**
 * Qmemory Configuration & Types — Barrel Re-export
 *
 * This file re-exports everything from types.ts, constants.ts, and formatters/
 * so that existing imports from "../config.js" continue to work without changes.
 */

// Types
export type {
  ExtractionMode,
  ExtractionPreset,
  QmemoryConfig,
  MemoryCategory,
  Session,
  Message,
  Memory,
  Entity,
  ContactSource,
  ToolCall,
  Scratchpad,
  MetricsEvent,
  MetricsSummary,
  HasMessage,
  ExtractedFrom,
  PrevVersion,
  Relates,
  DedupAction,
  DedupDecision,
  RecallOptions,
  RecalledMemory,
  ExtractedFact,
  ExtractedEntityRef,
  QmemoryLogger,
  GraphEntity,
  GraphEdge,
  GraphStats,
} from "./types.js";

// Constants (values)
export { CONTACT_SOURCES } from "./types.js";
export {
  EXTRACTION_PRESETS,
  EXTRACTION_KEYWORDS,
  DEFAULT_CONFIG,
  MEMORY_CATEGORIES,
  consoleLogger,
} from "./constants.js";

// Formatters (functions)
export {
  formatMemories,
  formatGraphMap,
  estimateTokens,
  fitToTokenBudget,
  getAge,
} from "./formatters/index.js";

/**
 * Adaptive Extraction Engine
 *
 * Budget-aware extraction that adapts to rate limits.
 * Uses simple presets (economy/balanced/aggressive) instead of complex config.
 */

import {
  ExtractionMode,
  ExtractionPreset,
  EXTRACTION_PRESETS,
  EXTRACTION_KEYWORDS,
} from "../config.js";

// Track extractions per session (rolling hour window)
interface ExtractionRecord {
  timestamp: number;
  sessionId: string;
}

const extractionHistory: ExtractionRecord[] = [];

/**
 * Get the preset for a given mode
 */
export function getPreset(mode: ExtractionMode): ExtractionPreset {
  return EXTRACTION_PRESETS[mode] || EXTRACTION_PRESETS.balanced;
}

/**
 * Count extractions in the last hour for a session
 */
function getExtractionsLastHour(sessionId: string): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return extractionHistory.filter(
    (r) => r.timestamp > oneHourAgo && r.sessionId === sessionId
  ).length;
}

/**
 * Count total extractions in the last hour (all sessions)
 */
function getTotalExtractionsLastHour(): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return extractionHistory.filter((r) => r.timestamp > oneHourAgo).length;
}

/**
 * Clean old records (older than 1 hour)
 */
function cleanOldRecords(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  while (extractionHistory.length > 0 && extractionHistory[0].timestamp < oneHourAgo) {
    extractionHistory.shift();
  }
}

/**
 * Score message importance (1-10 scale)
 */
export function scoreImportance(
  content: string,
  channelType: "dm" | "group" | "cron" | "subagent",
  preset: ExtractionPreset,
  recentMessageCount: number = 5
): number {
  let score = 0;
  const lowerContent = content.toLowerCase();

  // Channel priority
  if (channelType === "dm") {
    score += preset.dm_priority;
  } else {
    score += preset.group_priority;
  }

  // Keyword trigger (strong signal)
  if (EXTRACTION_KEYWORDS.some((kw) => lowerContent.includes(kw))) {
    score += preset.keyword_bonus;
  }

  // Long content bonus
  if (content.length > 500) {
    score += preset.long_content_bonus;
  }

  // Quiet conversation bonus (sparse = more important)
  if (recentMessageCount < 3) {
    score += preset.quiet_conversation_bonus;
  }

  return score;
}

/**
 * Get adaptive threshold based on remaining budget
 */
function getAdaptiveThreshold(
  remainingBudget: number,
  baseThreshold: number
): number {
  if (remainingBudget <= 0) {
    return 100; // Effectively disabled
  } else if (remainingBudget === 1) {
    return Math.min(baseThreshold + 3, 9); // Tight budget, higher threshold
  } else if (remainingBudget === 2) {
    return Math.min(baseThreshold + 1, 7); // Moderate budget
  } else {
    return baseThreshold; // Plenty of budget
  }
}

/**
 * Decide whether to extract memories from this turn
 */
export function shouldExtract(params: {
  content: string;
  channelType: "dm" | "group" | "cron" | "subagent";
  sessionId: string;
  mode: ExtractionMode;
  recentMessageCount?: number;
}): {
  extract: boolean;
  reason: string;
  score: number;
  threshold: number;
  budgetUsed: number;
  budgetRemaining: number;
} {
  const { content, channelType, sessionId, mode, recentMessageCount = 5 } = params;

  // Clean old records first
  cleanOldRecords();

  // Get preset for mode
  const preset = getPreset(mode);

  // Check content length
  if (content.length < preset.min_content_length) {
    return {
      extract: false,
      reason: `Content too short (${content.length} < ${preset.min_content_length})`,
      score: 0,
      threshold: preset.score_threshold,
      budgetUsed: getTotalExtractionsLastHour(),
      budgetRemaining: preset.hourly_budget === Infinity ? Infinity : preset.hourly_budget - getTotalExtractionsLastHour(),
    };
  }

  // Check budget (unless aggressive mode with unlimited budget)
  const usedThisHour = getTotalExtractionsLastHour();
  const remainingBudget = preset.hourly_budget === Infinity
    ? Infinity
    : preset.hourly_budget - usedThisHour;

  // Score the message
  const score = scoreImportance(content, channelType, preset, recentMessageCount);

  // Get adaptive threshold
  const threshold = getAdaptiveThreshold(remainingBudget, preset.score_threshold);

  // Decision
  const extract = score >= threshold;

  // If extracting, record it
  if (extract) {
    extractionHistory.push({
      timestamp: Date.now(),
      sessionId,
    });
  }

  return {
    extract,
    reason: extract
      ? `Score ${score} >= threshold ${threshold}`
      : `Score ${score} < threshold ${threshold}`,
    score,
    threshold,
    budgetUsed: usedThisHour + (extract ? 1 : 0),
    budgetRemaining: remainingBudget - (extract ? 1 : 0),
  };
}

/**
 * Get current extraction stats (for debugging/monitoring)
 */
export function getExtractionStats(): {
  totalLastHour: number;
  historyLength: number;
} {
  cleanOldRecords();
  return {
    totalLastHour: getTotalExtractionsLastHour(),
    historyLength: extractionHistory.length,
  };
}

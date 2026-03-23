/**
 * Token budget utilities
 *
 * Functions for estimating tokens and fitting memories within budgets.
 */

import type { RecalledMemory } from "../types.js";

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
export function getAge(isoDate: string): string {
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

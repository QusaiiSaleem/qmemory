/**
 * Engine compact — memory extraction from old messages
 *
 * Called when context window exceeds threshold.
 * Extract memories from old messages, then drop them.
 * This is where memories are BORN — compaction = memory creation.
 */

import { recall } from "../../core/recall.js";
import { saveMemory } from "../../core/save.js";
import { extractMemories } from "../../core/extract.js";
import { trackEvent } from "../../core/metrics.js";
import { clearScratchpad, updateScratchpad } from "../../core/scratchpad.js";
import { query } from "../../db/client.js";
import type {
  QmemoryConfig,
  QmemoryLogger,
  ExtractedFact,
} from "../../config.js";
import { estimateTokens } from "../../config.js";
import type { EmbeddingConfig } from "../../core/embeddings.js";
import type { SubagentRunner } from "../index.js";
import { shouldExtract } from "../adaptive-extraction.js";
import { extractText, parseSessionKey, sessionIdPart, storeRecentMessages } from "./session.js";

// ---------------------------------------------------------------------------
// compact() — Called when context window exceeds threshold
// ---------------------------------------------------------------------------

export async function compact(
  params: {
    messages: unknown[];
    tokenBudget: number;
    currentTokenCount: number;
  },
  config: QmemoryConfig,
  logger: QmemoryLogger,
  subagentRunner: SubagentRunner | undefined,
  embeddingConfig: EmbeddingConfig | undefined,
  currentSessionId: string | null,
  isDiscoveryMode: boolean,
  invalidateGraphCache: () => void,
): Promise<{
  ok: boolean;
  compacted: boolean;
  result?: {
    summary: string;
    tokensBefore: number;
    tokensAfter: number;
    factsExtracted: number;
    factsSaved: number;
  };
}> {
  const { messages, tokenBudget, currentTokenCount } = params;

  if (!subagentRunner) {
    logger.warn("No subagent runner — cannot extract memories during compaction");
    return { ok: false, compacted: false };
  }

  // Stage-aware compaction: protect fewer messages at higher usage
  const usageRatio = currentTokenCount / tokenBudget;
  const protectedCount = usageRatio > 0.95
    ? Math.min(config.fresh_tail_count, 8)   // Emergency: keep fewer
    : usageRatio > 0.85
      ? Math.min(config.fresh_tail_count, 16) // Heavy: keep half
      : config.fresh_tail_count;               // Normal

  if (usageRatio > 0.85) {
    logger.info(`Stage-aware compaction: protecting only ${protectedCount} messages at ${Math.round(usageRatio * 100)}%`);
  }

  // Calculate how many messages to compact
  const totalMessages = messages.length;

  if (totalMessages <= protectedCount) {
    logger.debug("Not enough messages to compact");
    return { ok: true, compacted: false };
  }

  // Split: old messages (to compact) vs fresh messages (to keep)
  const oldMessages = messages.slice(0, totalMessages - protectedCount);
  const freshMessages = messages.slice(totalMessages - protectedCount);

  // Convert old messages to Message[] format for extractMemories
  const oldMsgArray = oldMessages.map((m: any) => ({
    id: "",
    session: "",
    role: m.role ?? "user",
    content: extractText(m?.content),
    token_count: 0,
    created_at: new Date().toISOString(),
  })) as import("../../config.js").Message[];

  let extractedFacts: ExtractedFact[] = [];
  try {
    extractedFacts = await extractMemories(oldMsgArray, subagentRunner, {
      discoveryMode: isDiscoveryMode,
    });
  } catch (error) {
    logger.error(`Memory extraction failed: ${error}`);
    return { ok: false, compacted: false };
  }

  // Save each extracted fact with dedup
  let savedCount = 0;
  for (const fact of extractedFacts) {
    try {
      await saveMemory(
        {
          content: fact.content,
          category: fact.category,
          salience: fact.salience,
          scope: fact.scope,
          source_type: "conversation",
          source_person: fact.source_person,
          evidence_type: fact.evidence_type,
          confidence: fact.confidence,
          context_mood: fact.context_mood,
        },
        subagentRunner,
        embeddingConfig,
      );
      savedCount++;
    } catch (error) {
      logger.warn(`Failed to save fact: ${error}`);
    }
  }

  // Invalidate graph cache since new memories were saved
  if (savedCount > 0) invalidateGraphCache();

  logger.info(
    `Compaction: extracted ${extractedFacts.length} facts, saved ${savedCount}`,
  );

  // Track compaction + extraction metrics (fire-and-forget)
  if (currentSessionId) {
    trackEvent(currentSessionId, "compaction", "compact").catch(() => {});
    if (extractedFacts.length > 0) {
      trackEvent(currentSessionId, "extraction", String(extractedFacts.length)).catch(() => {});
    }
  }

  // Re-inject high-salience memories into a summary
  // This prevents "post-compaction amnesia" (OpenClaw #19148)
  let summary = `[Compacted ${oldMessages.length} messages into ${savedCount} memories]`;
  try {
    const criticalMemories = await recall({
      min_salience: 0.8,
      limit: 10,
      token_budget: Math.floor(tokenBudget * 0.05), // 5% of budget for critical re-injection
    });

    if (criticalMemories.length > 0) {
      const criticalText = criticalMemories
        .map((m) => `- [${m.category}!] ${m.content}`)
        .join("\n");
      summary += `\n\nCritical context (must not forget):\n${criticalText}`;
    }
  } catch {
    // Non-fatal — summary without critical memories is still useful
  }

  const tokensAfter = estimateTokens(
    freshMessages.map((m: any) => extractText(m?.content)).join(" "),
  );

  return {
    ok: true,
    compacted: true,
    result: {
      summary,
      tokensBefore: currentTokenCount,
      tokensAfter,
      factsExtracted: extractedFacts.length,
      factsSaved: savedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// afterTurn() — Multi-stage graduated compaction + background extraction
// ---------------------------------------------------------------------------

export async function afterTurn(
  params: {
    messages: unknown[];
    tokenBudget?: number;
    currentTokenCount?: number;
  },
  config: QmemoryConfig,
  logger: QmemoryLogger,
  subagentRunner: SubagentRunner | undefined,
  embeddingConfig: EmbeddingConfig | undefined,
  currentSessionId: string | null,
  currentSessionKey: string | null,
  isDiscoveryMode: boolean,
  invalidateGraphCache: () => void,
): Promise<void> {
  if (!subagentRunner) return;

  const { messages, tokenBudget, currentTokenCount } = params;

  // --- STORE MESSAGES ---
  // OpenClaw calls afterTurn() INSTEAD of ingest() when afterTurn exists.
  // Store the last few messages so cross-session message search works.
  // This is what makes Qmemory bypass OpenClaw's session isolation.
  if (currentSessionId && messages.length > 0) {
    try {
      await storeRecentMessages(messages, currentSessionId, logger);
    } catch (msgErr) {
      logger.debug(`Message storage failed (non-fatal): ${msgErr}`);
    }
  }

  // --- MULTI-STAGE COMPACTION ---
  if (tokenBudget && currentTokenCount) {
    const usageRatio = currentTokenCount / tokenBudget;

    if (usageRatio > 0.95) {
      // STAGE 4: Emergency — full checkpoint
      logger.warn(`Emergency compaction at ${Math.round(usageRatio * 100)}%`);
      const allExtractable = messages.slice(
        0,
        Math.max(0, messages.length - Math.min(config.fresh_tail_count, 8)),
      );
      if (allExtractable.length > 0) {
        const msgArray = allExtractable.map((m: any) => ({
          id: "", session: "", role: m.role ?? "user",
          content: extractText(m?.content), token_count: 0, created_at: new Date().toISOString(),
        })) as import("../../config.js").Message[];
        try {
          const facts = await extractMemories(msgArray, subagentRunner, {
            discoveryMode: isDiscoveryMode,
          });
          for (const fact of facts) {
            await saveMemory(
              { content: fact.content, category: fact.category,
                salience: fact.salience, scope: fact.scope, source_type: "conversation",
                source_person: fact.source_person, evidence_type: fact.evidence_type,
                confidence: fact.confidence, context_mood: fact.context_mood },
              subagentRunner,
              embeddingConfig,
            );
          }
          logger.info(`Emergency compaction: saved ${facts.length} facts from all messages`);
          if (currentSessionId) {
            trackEvent(currentSessionId, "compaction", "4").catch(() => {});
            trackEvent(currentSessionId, "extraction", String(facts.length)).catch(() => {});
          }
        } catch (error) {
          logger.warn(`Emergency compaction failed: ${error}`);
        }
      }
      // Stage 4 includes all Stage 3 cleanup: clear tool_calls + scratchpad
      if (currentSessionId) {
        try {
          await query(
            'DELETE tool_call WHERE session = type::record("session", $sessionId)',
            { sessionId: sessionIdPart(currentSessionId!) },
          );
          await clearScratchpad(currentSessionId);
          logger.debug("Emergency compaction: cleared tool_calls + scratchpad");
        } catch { /* non-fatal */ }
      }

    } else if (usageRatio > 0.85) {
      // STAGE 3: Heavy — clear old tool_call records + compress scratchpad
      logger.info(`Heavy compaction at ${Math.round(usageRatio * 100)}%`);
      // Clear tool_call records older than 10 most recent
      if (currentSessionId) {
        try {
          // Keep only the 10 most recent tool calls
          const oldCalls = await query<{ id: string }>(
            `SELECT id FROM tool_call
             WHERE session = type::record("session", $sessionId)
             ORDER BY created_at DESC
             LIMIT 1000 START 10`,
            { sessionId: sessionIdPart(currentSessionId!) },
          );
          if (oldCalls && oldCalls.length > 0) {
            for (const call of oldCalls) {
              await query("DELETE type::record($id)", { id: call.id });
            }
            logger.debug(`Heavy compaction: cleared ${oldCalls.length} old tool_call records`);
          }
        } catch (error) {
          logger.debug(`Tool call cleanup failed: ${error}`);
        }
      }
      // Also do the stage 2 extraction
      const extractableMessages = messages.slice(
        0,
        Math.max(0, messages.length - config.fresh_tail_count),
      );
      if (extractableMessages.length > 0) {
        const msgArray = extractableMessages.map((m: any) => ({
          id: "", session: "", role: m.role ?? "user",
          content: extractText(m?.content), token_count: 0, created_at: new Date().toISOString(),
        })) as import("../../config.js").Message[];
        try {
          const facts = await extractMemories(msgArray, subagentRunner, {
            discoveryMode: isDiscoveryMode,
          });
          for (const fact of facts) {
            await saveMemory(
              { content: fact.content, category: fact.category,
                salience: fact.salience, scope: fact.scope, source_type: "conversation",
                source_person: fact.source_person, evidence_type: fact.evidence_type,
                confidence: fact.confidence, context_mood: fact.context_mood },
              subagentRunner,
              embeddingConfig,
            );
          }
          logger.info(`Heavy compaction: saved ${facts.length} facts`);
          if (currentSessionId) {
            trackEvent(currentSessionId, "compaction", "3").catch(() => {});
            trackEvent(currentSessionId, "extraction", String(facts.length)).catch(() => {});
          }
        } catch (error) {
          logger.warn(`Heavy compaction extraction failed: ${error}`);
        }
      }

    } else if (usageRatio > 0.7) {
      // STAGE 2: Medium — existing pre-compaction flush
      // This fixes OpenClaw #19488 where the built-in flush never fires
      logger.info(
        `Pre-compaction flush: context at ${Math.round(usageRatio * 100)}%`,
      );
      const extractableMessages = messages.slice(
        0,
        Math.max(0, messages.length - config.fresh_tail_count),
      );
      if (extractableMessages.length > 0) {
        const msgArray = extractableMessages.map((m: any) => ({
          id: "", session: "", role: m.role ?? "user",
          content: extractText(m?.content), token_count: 0, created_at: new Date().toISOString(),
        })) as import("../../config.js").Message[];
        try {
          const facts = await extractMemories(msgArray, subagentRunner, {
            discoveryMode: isDiscoveryMode,
          });
          for (const fact of facts) {
            await saveMemory(
              { content: fact.content, category: fact.category,
                salience: fact.salience, scope: fact.scope, source_type: "conversation",
                source_person: fact.source_person, evidence_type: fact.evidence_type,
                confidence: fact.confidence, context_mood: fact.context_mood },
              subagentRunner,
              embeddingConfig,
            );
          }
          logger.info(`Pre-compaction flush: saved ${facts.length} facts`);
          if (currentSessionId) {
            trackEvent(currentSessionId, "compaction", "2").catch(() => {});
            trackEvent(currentSessionId, "extraction", String(facts.length)).catch(() => {});
          }
        } catch (error) {
          logger.warn(`Pre-compaction flush failed: ${error}`);
        }
      }

    } else if (usageRatio > 0.5) {
      // STAGE 1: Light — summarize messages older than 15 turns
      logger.debug(`Light compaction at ${Math.round(usageRatio * 100)}%`);
      const oldMessages = messages.slice(0, Math.max(0, messages.length - 15));
      if (oldMessages.length > 5) {
        const msgArray = oldMessages.map((m: any) => ({
          id: "", session: "", role: m.role ?? "user",
          content: extractText(m?.content), token_count: 0, created_at: new Date().toISOString(),
        })) as import("../../config.js").Message[];
        try {
          const facts = await extractMemories(msgArray, subagentRunner, {
            discoveryMode: isDiscoveryMode,
          });
          for (const fact of facts) {
            await saveMemory(
              { content: fact.content, category: fact.category,
                salience: fact.salience, scope: fact.scope, source_type: "conversation",
                source_person: fact.source_person, evidence_type: fact.evidence_type,
                confidence: fact.confidence, context_mood: fact.context_mood },
              subagentRunner,
              embeddingConfig,
            );
          }
          if (facts.length > 0) {
            logger.debug(`Light compaction: saved ${facts.length} facts`);
            if (currentSessionId) {
              trackEvent(currentSessionId, "compaction", "1").catch(() => {});
              trackEvent(currentSessionId, "extraction", String(facts.length)).catch(() => {});
            }
          }
        } catch (error) {
          logger.debug(`Light compaction failed: ${error}`);
        }
      }
    }
  }

  // --- SCRATCHPAD UPDATE ---
  // Extract task state from the last assistant message
  // Rate-limited: only every 5 turns after the first 5, to avoid expensive subagent calls
  if (currentSessionId && messages.length > 5 && messages.length % 5 === 0) {
    try {
      // Find the last assistant message and extract its text
      const lastAssistantMsg = [...messages].reverse().find(
        (m: any) => m?.role === "assistant" && m?.content,
      );
      const lastAssistantText = lastAssistantMsg
        ? extractText((lastAssistantMsg as any).content)
        : "";

      if (lastAssistantText.length > 50) {
        const extractionResult = await subagentRunner(
          `Analyze this assistant message and extract ONLY what's relevant as working memory.
Return a JSON object with these fields (use "" for empty):
- task_progress: What task is being worked on and current status (1-2 sentences max)
- key_findings: Important data points or discoveries (1-2 sentences max)
- open_questions: Unresolved questions or next steps (1 sentence max)

Message:
${lastAssistantText.slice(0, 1000)}

Respond ONLY with the JSON object, no markdown fencing.`,
        );

        if (extractionResult) {
          try {
            // Strip markdown fencing if present
            const cleaned = extractionResult.replace(/```json?\n?|\n?```/g, "").trim();
            const parsed = JSON.parse(cleaned);
            await updateScratchpad(currentSessionId, {
              task_progress: parsed.task_progress ?? "",
              key_findings: parsed.key_findings ?? "",
              open_questions: parsed.open_questions ?? "",
            });
            logger.debug("Scratchpad updated from assistant message");
          } catch {
            logger.debug("Scratchpad extraction parse failed (non-fatal)");
          }
        }
      }
    } catch (error) {
      logger.debug(`Scratchpad update failed (non-fatal): ${error}`);
    }
  }

  // Background: extract facts from the last few messages (ADAPTIVE)
  const recentMsgArray = messages.slice(-4).map((m: any) => ({
    id: "", session: "", role: m.role ?? "user",
    content: extractText(m?.content), token_count: 0, created_at: new Date().toISOString(),
  })) as import("../../config.js").Message[];

  // Determine channel type from session key
  const parsedKey = parseSessionKey(currentSessionKey ?? "");
  const channelType: "dm" | "group" | "cron" | "subagent" =
    parsedKey.chatType === "direct" ? "dm" :
    parsedKey.chatType === "group" ? "group" :
    parsedKey.chatType === "cron" ? "cron" : "subagent";

  // Get content for scoring
  const content = recentMsgArray.map(m => m.content).join("");

  // Adaptive extraction decision
  const decision = shouldExtract({
    content,
    channelType,
    sessionId: currentSessionId ?? "unknown",
    mode: config.extraction_mode,
    recentMessageCount: messages.length,
  });

  // Skip if extraction not recommended
  if (!decision.extract) {
    logger.debug(
      `Adaptive extraction: skipped (${decision.reason}) [mode: ${config.extraction_mode}]`
    );
    return;
  }

  try {
    const facts = await extractMemories(recentMsgArray, subagentRunner, {
      discoveryMode: isDiscoveryMode,
    });
    for (const fact of facts) {
      await saveMemory(
        { content: fact.content, category: fact.category,
          salience: fact.salience, scope: fact.scope, source_type: "conversation",
          source_person: fact.source_person, evidence_type: fact.evidence_type,
          confidence: fact.confidence, context_mood: fact.context_mood },
        subagentRunner,
        embeddingConfig,
      );
    }
    if (facts.length > 0) {
      invalidateGraphCache(); // Invalidate graph cache
      logger.info(
        `Adaptive extraction: saved ${facts.length} facts (budget: ${decision.budgetRemaining} remaining, score: ${decision.score})`
      );
      if (currentSessionId) {
        trackEvent(currentSessionId, "extraction", String(facts.length)).catch(() => {});
      }
    }
  } catch (error) {
    logger.warn(`Adaptive extraction failed: ${error}`);
  }
}

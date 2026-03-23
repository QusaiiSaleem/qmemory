/**
 * Engine assemble — memory injection into context
 *
 * Called before sending context to the LLM.
 * Pass through current messages + inject cross-session memories.
 */

import { query } from "../../db/client.js";
import { recall } from "../../core/recall.js";
import {
  getGraphEntities,
  getGraphEdges,
  getGraphStats,
} from "../../db/queries.js";
import type {
  QmemoryConfig,
  QmemoryLogger,
  RecalledMemory,
  GraphEntity,
  GraphEdge,
  GraphStats,
  ToolCall,
} from "../../config.js";
import {
  formatMemories,
  formatGraphMap,
  fitToTokenBudget,
  estimateTokens,
  getAge,
} from "../../config.js";
import { getScratchpad } from "../../core/scratchpad.js";
import { trackEvent } from "../../core/metrics.js";
import type { SharedEngineState } from "../hooks.js";
import { sessionIdPart, extractText, parseSessionKey } from "./session.js";

// Graph map cache — avoid re-querying every assemble() turn
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface AssembleState {
  graphMapCache: string | null;
  graphMapCacheTime: number;
  hasShownToolsGuide: boolean;
}

export async function assemble(
  params: {
    messages: unknown[];
    tokenBudget: number;
    sessionKey?: string;
  },
  config: QmemoryConfig,
  logger: QmemoryLogger,
  currentSessionId: string | null,
  currentSessionKey: string | null,
  isDiscoveryMode: boolean,
  sharedState: SharedEngineState | undefined,
  state: AssembleState,
): Promise<{
  messages: unknown[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}> {
  const messages = params.messages;
  const totalTokens = params.tokenBudget || 200_000;

  // Calculate memory budget (max 15% of total context window)
  const memoryBudget = Math.floor(totalTokens * config.memory_budget_pct);

  // --- CONTEXTUAL RECALL ---
  // Extract what the conversation is about from recent messages
  // so we recall RELEVANT memories, not just top-salience ones
  const recentMessages = messages.slice(-6); // Last 3 turns (user + assistant)
  const conversationContext = recentMessages
    .map((m: any) => extractText(m?.content))
    .filter((c: string) => c.length > 0)
    .join(" ")
    .slice(0, 500); // Cap to avoid huge queries

  // Parse session key for scope-aware recall
  const sessionScope = currentSessionKey
    ? parseSessionKey(currentSessionKey).scope
    : "global";

  let memories: RecalledMemory[] = [];
  try {
    // Tier 1+2: Context-aware search (graph + BM25 using conversation context)
    if (conversationContext.length > 20) {
      const contextual = await recall({
        query: conversationContext,
        scope: sessionScope !== "global" ? sessionScope : undefined,
        min_salience: config.min_salience_recall,
        limit: 50,
        token_budget: Math.floor(memoryBudget * 0.7), // 70% for contextual
      });
      memories.push(...contextual);
    }

    // Always include high-salience memories (critical rules, preferences)
    // These are recalled regardless of what the conversation is about
    const critical = await recall({
      min_salience: 0.8,
      limit: 20,
      token_budget: Math.floor(memoryBudget * 0.3), // 30% for critical
    });

    // Merge and deduplicate by ID
    const seen = new Set(memories.map(m => m.id));
    for (const m of critical) {
      if (!seen.has(m.id)) {
        memories.push(m);
        seen.add(m.id);
      }
    }

    // Sort: critical first (salience DESC), then by relevance score
    memories.sort((a, b) => {
      if (a.salience >= 0.8 && b.salience < 0.8) return -1;
      if (b.salience >= 0.8 && a.salience < 0.8) return 1;
      return (b.score ?? b.salience) - (a.score ?? a.salience);
    });
  } catch (error) {
    logger.warn(`Recall failed (non-fatal): ${error}`);
  }

  // Track recall metrics (fire-and-forget)
  if (currentSessionId) {
    if (memories.length > 0) {
      trackEvent(currentSessionId, "recall_hit", String(memories.length)).catch(() => {});
    } else {
      trackEvent(currentSessionId, "recall_miss").catch(() => {});
    }
  }

  // --- Contradiction detection ---
  // Check if any recalled memories have "contradicts" edges in the graph.
  // This lets the agent see ⚠︎ markers on disputed facts.
  let enriched: RecalledMemory[] = memories;
  try {
    const recalledIds = memories.map(m => String(m.id));
    const contradictedIds = new Set<string>();
    if (recalledIds.length > 0) {
      const contradictions = await query<{ in: string; out: string }>(
        `SELECT in, out FROM relates WHERE type = "contradicts"
         AND (in IN $ids OR out IN $ids)`,
        { ids: recalledIds },
      );
      for (const c of contradictions ?? []) {
        contradictedIds.add(String(c.in));
        contradictedIds.add(String(c.out));
      }
    }
    // Enrich with contradiction flag
    enriched = memories.map(m => ({
      ...m,
      is_contradicted: contradictedIds.has(String(m.id)),
    }));
  } catch (contradictErr) {
    logger.debug(`Contradiction detection failed (non-fatal): ${contradictErr}`);
  }

  // --- Biological memory: boost salience for recalled memories ---
  // Every time a memory is recalled, its salience gets a small bump
  // and recall_count increments — just like biological reinforcement.
  const finalIds = [...new Set(enriched.map(m => String(m.id)))];
  if (finalIds.length > 0) {
    query(
      `UPDATE memory SET recall_count += 1, last_recalled = time::now(),
         salience = math::min([salience + 0.05, 1.0])
       WHERE id IN $ids`,
      { ids: finalIds },
    ).catch(() => {}); // Fire-and-forget — non-blocking
  }

  // Token budget split (must sum to 100%):
  //   52% memories, 5% tool ledger, 3% scratchpad, 40% graph map
  const isFirstAssemble = !state.hasShownToolsGuide;
  const memBudget = Math.floor(memoryBudget * 0.52);
  const fitted = fitToTokenBudget(enriched, memBudget);

  // Build injection — session header + FOUR parts:
  const parts: string[] = [];

  // Session context header — orientation for the agent
  if (currentSessionKey) {
    const parsed = parseSessionKey(currentSessionKey);
    const channelLabel = parsed.channel !== "unknown" ? parsed.channel : "direct";
    const topicLabel = parsed.topicId ? `/topic:${parsed.topicId}` : "";
    const scopeLabel = sessionScope !== "global" ? ` | scope: ${sessionScope}` : "";
    const modelLabel = sharedState?.currentModel ? ` | model: ${sharedState.currentModel}` : "";
    parts.push(`_Session: ${channelLabel}/${parsed.chatType}${topicLabel}${scopeLabel} | ${fitted.length} memories recalled${modelLabel}_`);
  }

  // Part 0a: Background activity — cron/heartbeat outcomes + session activity
  // Shows what happened across OTHER sessions (agent's blind spot)
  try {
    const bgRuns = await query<{ content: string; source_type: string; created_at: string }>(
      `SELECT content, source_type, created_at FROM memory
       WHERE is_active = true
         AND source_type IN ["cron", "agent"]
         AND string::contains(content, "[cron")
       ORDER BY created_at DESC
       LIMIT 5`,
    );

    const recentSessions = await query<{
      session_key: string; last_active: string; chat_type: string;
    }>(
      `SELECT session_key, last_active, chat_type FROM session
       ORDER BY last_active DESC
       LIMIT 10`,
    );

    if ((bgRuns && bgRuns.length > 0) || (recentSessions && recentSessions.length > 1)) {
      const activityLines: string[] = ["## Background Activity"];

      if (bgRuns && bgRuns.length > 0) {
        activityLines.push("**Recent background runs:**");
        for (const run of bgRuns) {
          const age = getAge(run.created_at);
          activityLines.push(`- ${run.content}${age}`);
        }
      }

      if (recentSessions && recentSessions.length > 1) {
        activityLines.push("", "**Active sessions:**");
        for (const sess of recentSessions.slice(0, 7)) {
          // Parse session key to show human-readable label
          const p = parseSessionKey(sess.session_key);
          const topicTag = p.topicId ? `/topic:${p.topicId}` : "";
          const age = getAge(sess.last_active);
          const current = sess.session_key === currentSessionKey ? " ← you are here" : "";
          activityLines.push(`- ${p.channel}/${p.chatType}${topicTag}${age}${current}`);
        }
      }

      const activityText = activityLines.join("\n");
      if (estimateTokens(activityText) < Math.floor(memoryBudget * 0.05)) {
        parts.push(activityText);
      }
    }
  } catch (actErr) {
    logger.debug(`Background activity injection failed: ${actErr}`);
  }

  // Part 0b: Tool call ledger — max 5% of memory budget
  try {
    if (currentSessionId) {
      const ledgerBudget = Math.floor(memoryBudget * 0.05);
      const recentCalls = await query<ToolCall>(
        `SELECT * FROM tool_call
         WHERE session = type::record("session", $sessionId)
         ORDER BY created_at DESC
         LIMIT 20`,
        { sessionId: sessionIdPart(currentSessionId!) },
      );
      if (recentCalls && recentCalls.length > 0) {
        const rows = recentCalls.reverse().map((tc) => {
          const ago = tc.duration_ms != null ? `${tc.duration_ms}ms` : "?";
          return `| ${tc.tool_name} | ${tc.input_summary} | ${tc.output_summary} | ${ago} |`;
        });
        let ledgerText =
          "## Recent Tool Calls\n" +
          "| Tool | Input | Output | Time |\n" +
          "|------|-------|--------|------|\n" +
          rows.join("\n");
        // Trim to budget
        const ledgerTokens = estimateTokens(ledgerText);
        if (ledgerTokens > ledgerBudget) {
          // Drop oldest rows until it fits
          while (rows.length > 1 && estimateTokens(ledgerText) > ledgerBudget) {
            rows.shift();
            ledgerText =
              "## Recent Tool Calls\n" +
              "| Tool | Input | Output | Time |\n" +
              "|------|-------|--------|------|\n" +
              rows.join("\n");
          }
        }
        parts.push(ledgerText);
      }
    }
  } catch (ledgerError) {
    logger.debug(`Tool ledger injection failed (non-fatal): ${ledgerError}`);
  }

  // Part 1: Categorized memories
  const memoriesText = formatMemories(fitted, isFirstAssemble);
  if (memoriesText) parts.push(memoriesText);

  // Part 1.5: Session scratchpad (working memory) — max 3% of memory budget
  try {
    if (currentSessionId) {
      const scratchpadBudget = Math.floor(memoryBudget * 0.03);
      const pad = await getScratchpad(currentSessionId);
      if (pad) {
        // Only inject if there's actual content
        const fields: string[] = [];
        if (pad.task_progress) fields.push(`**Progress:** ${pad.task_progress}`);
        if (pad.key_findings) fields.push(`**Findings:** ${pad.key_findings}`);
        if (pad.open_questions) fields.push(`**Open questions:** ${pad.open_questions}`);
        if (pad.tool_summary) fields.push(`**Tool summary:** ${pad.tool_summary}`);

        if (fields.length > 0) {
          let scratchpadText = "## Working Memory\n" + fields.join("\n");
          // Trim to budget
          if (estimateTokens(scratchpadText) > scratchpadBudget) {
            scratchpadText = scratchpadText.slice(0, scratchpadBudget * 4); // ~4 chars/token
          }
          parts.push(scratchpadText);
        }
      }
    }
  } catch (scratchpadError) {
    logger.debug(`Scratchpad injection failed (non-fatal): ${scratchpadError}`);
  }

  // Part 2: Knowledge graph map — cached with 5-min TTL
  try {
    const now = Date.now();
    if (!state.graphMapCache || now - state.graphMapCacheTime > GRAPH_CACHE_TTL_MS) {
      const entQ = getGraphEntities();
      const edgeQ = getGraphEdges();
      const statsQ = getGraphStats();

      const [entities, edges, statsResult] = await Promise.all([
        query<GraphEntity>(entQ.surql, entQ.params),
        query<GraphEdge>(edgeQ.surql, edgeQ.params),
        query<{ total: number }>(statsQ.surql, statsQ.params),
      ]);

      const stats: GraphStats = {
        memories: statsResult?.[0]?.total ?? 0,
        entities: entities?.length ?? 0,
        edges: edges?.length ?? 0,
        sessions: 0,
        orphans: 0,
      };
      state.graphMapCache = formatGraphMap(
        (entities ?? []) as GraphEntity[],
        (edges ?? []) as GraphEdge[],
        stats,
      );
      state.graphMapCacheTime = now;
    }
    if (state.graphMapCache) parts.push(state.graphMapCache);
  } catch (graphError) {
    logger.debug(`Graph map failed (non-fatal): ${graphError}`);
  }

  // --- Discovery mode nudge ---
  // In the first 72 hours, remind the agent to learn aggressively
  if (isDiscoveryMode) {
    parts.push(
      "",
      "### Discovery Mode Active",
      "You are in discovery mode (first 72 hours). Learn aggressively:",
      "- Save every person, project, preference you encounter",
      "- When corrected, save BOTH the correction AND what you learned about yourself",
      "- Prefer higher salience (0.6+) for identity facts",
    );
  }

  if (isFirstAssemble) state.hasShownToolsGuide = true;

  const systemPromptAddition = parts.join("\n\n");

  // Estimate tokens for the current messages
  const messagesText = messages
    .map((m: any) => extractText(m?.content))
    .join(" ");
  const estimatedTokens = estimateTokens(messagesText);

  if (fitted.length > 0 || parts.length > 1) {
    logger.debug(
      `Assembled: ${messages.length} msgs + ${fitted.length} memories` +
      `${parts.length > 1 ? " + graph map" : ""}` +
      ` (${estimateTokens(systemPromptAddition)} tokens)`,
    );
  }

  return {
    messages,
    estimatedTokens,
    systemPromptAddition: systemPromptAddition || undefined,
  };
}

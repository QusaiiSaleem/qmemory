/**
 * Qmemory Context Engine
 *
 * Implements the full OpenClaw ContextEngine interface.
 * This is what OpenClaw calls instead of LCM for every session lifecycle event:
 *
 *   bootstrap → ingest → assemble → compact → afterTurn → dispose
 *
 * Key insight: compaction doesn't just shrink context — it creates living
 * memory nodes in the graph that grow smarter over time.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connect,
  disconnect,
  query,
  applySchema,
  generateId,
  setLogger,
} from "../db/client.js";
import { searchMemories } from "../core/search.js";
import { recall } from "../core/recall.js";
import { saveMemory } from "../core/save.js";
import { extractMemories } from "../core/extract.js";
import { dedup } from "../core/dedup.js";
import type {
  QmemoryConfig,
  QmemoryLogger,
  Memory,
  RecalledMemory,
  ExtractedFact,
} from "../config.js";
import {
  formatMemories,
  fitToTokenBudget,
  estimateTokens,
} from "../config.js";
import { resolveEmbeddingConfig, generateEmbedding, enableVectorIndex, setEmbeddingLogger } from "../core/embeddings.js";
import type { EmbeddingConfig } from "../core/embeddings.js";
import type { SubagentRunner } from "./index.js";

// ---------------------------------------------------------------------------
// Schema file path — resolved relative to this file's location
// ---------------------------------------------------------------------------

function getSchemaPath(): string {
  // In compiled JS: dist/openclaw/engine.js → ../../schema/qmemory.surql
  // In source TS: src/openclaw/engine.ts → ../../schema/qmemory.surql
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, "..", "..", "schema", "qmemory.surql");
  } catch {
    // Fallback for environments where import.meta.url is unavailable
    return join(process.cwd(), "schema", "qmemory.surql");
  }
}

// ---------------------------------------------------------------------------
// Session key parser — extracts topic/group/channel from OpenClaw session keys
// Format: agent:<agentId>:<channel>:group:<groupId>:topic:<topicId>
// ---------------------------------------------------------------------------

interface ParsedSessionKey {
  channel: string;
  chatType: string;
  topicId?: string;
  groupId?: string;
  scope: string;
}

function parseSessionKey(sessionKey: string): ParsedSessionKey {
  // Default values
  const result: ParsedSessionKey = {
    channel: "unknown",
    chatType: "direct",
    scope: "global",
  };

  if (!sessionKey) return result;

  // Extract channel: agent:<id>:<channel>:...
  const parts = sessionKey.split(":");
  if (parts.length >= 3) {
    result.channel = parts[2]; // "telegram", "whatsapp", etc.
  }

  // Check for group
  const groupIdx = parts.indexOf("group");
  if (groupIdx >= 0 && parts[groupIdx + 1]) {
    result.chatType = "group";
    result.groupId = parts[groupIdx + 1];
    result.scope = `group:${result.groupId}`;
  }

  // Check for topic
  const topicIdx = parts.indexOf("topic");
  if (topicIdx >= 0 && parts[topicIdx + 1]) {
    result.topicId = parts[topicIdx + 1];
    result.scope = `topic:${result.topicId}`;
  }

  // Check for subagent
  if (sessionKey.includes("subagent")) {
    result.chatType = "subagent";
  }

  // Check for cron
  if (sessionKey.includes("cron")) {
    result.chatType = "cron";
  }

  return result;
}

// ---------------------------------------------------------------------------
// Engine factory — returns the ContextEngine object
// ---------------------------------------------------------------------------

export function createEngine(
  config: QmemoryConfig,
  logger: QmemoryLogger,
  subagentRunner?: SubagentRunner,
  openclawConfig?: Record<string, unknown>,
) {
  // Resolve embedding config from OpenClaw's existing settings (no extra API key!)
  setEmbeddingLogger(logger);
  const embeddingConfig: EmbeddingConfig = resolveEmbeddingConfig(config, openclawConfig);

  // Track the current session for this engine instance
  let currentSessionId: string | null = null;
  let currentSessionKey: string | null = null;
  let hasShownToolsGuide = false; // Show tools list only on first assemble per session

  // Set the logger on the DB client so it uses OpenClaw's logger
  setLogger(logger);

  return {
    // ----- Engine metadata -----
    info: {
      id: "qmemory",
      name: "Qmemory",
      version: "0.1.0",
      // We own compaction — OpenClaw won't run its built-in compaction
      ownsCompaction: true,
    },

    // -----------------------------------------------------------------
    // bootstrap() — Called once when a session starts
    // Connect to SurrealDB, apply schema, create/load session node.
    // -----------------------------------------------------------------
    async bootstrap(params: {
      sessionId: string;
      sessionKey?: string;
      channel?: string;
      chatType?: string;
      topicId?: string;
      groupId?: string;
      scope?: string;
    }) {
      logger.info(`Bootstrapping session: ${params.sessionId}`);

      // Connect to SurrealDB (reuses existing connection if already connected)
      const db = await connect(config);
      if (!db) {
        logger.warn("SurrealDB unavailable — running in degraded mode");
        return { bootstrapped: false };
      }

      // Apply schema (safe to run multiple times)
      try {
        const schemaPath = getSchemaPath();
        const schemaSurql = await readFile(schemaPath, "utf-8");
        await applySchema(schemaSurql);

        // --- AUTO-IMPORT: First run detection ---
        // If 0 memories exist, auto-import old memory files
        const memCount = await query<{ count: number }>(
          "SELECT count() AS count FROM memory GROUP ALL;"
        );
        if (memCount && memCount.length > 0 && memCount[0].count === 0) {
          logger.info("First run detected (0 memories) — auto-importing workspace memory files...");
          try {
            const { migrateWorkspaceMemories, setMigrateLogger } = await import("../core/migrate.js");
            setMigrateLogger(logger);
            // Detect workspace path from OpenClaw config or default
            const workspacePath = (openclawConfig as any)?.workspace?.path
              ?? join(process.env.HOME ?? "", ".openclaw", "workspace");
            const result = await migrateWorkspaceMemories(workspacePath, subagentRunner);
            logger.info(
              `Auto-import complete: ${result.files_read} files, ${result.memories_created} memories, ${result.relationships_created} relationships`
            );
          } catch (importError) {
            logger.warn(`Auto-import failed (non-fatal): ${importError}`);
          }
        }
      } catch (error) {
        logger.error(`Failed to load/apply schema: ${error}`);
        return { bootstrapped: false };
      }

      // Parse session key to extract topic/group/channel automatically
      // OpenClaw sends: "agent:main:telegram:group:-1003655876469:topic:7"
      const sessionKey = params.sessionKey ?? params.sessionId;
      currentSessionKey = sessionKey;
      hasShownToolsGuide = false; // Reset for new session
      const parsed = parseSessionKey(sessionKey);

      // Use parsed values, allow explicit params to override
      const channel = params.channel ?? parsed.channel;
      const chatType = params.chatType ?? parsed.chatType;
      const topicId = params.topicId ?? parsed.topicId ?? null;
      const groupId = params.groupId ?? parsed.groupId ?? null;
      const scope = params.scope ?? parsed.scope;

      if (parsed.topicId) {
        logger.info(`Detected Telegram topic: ${parsed.topicId} in group: ${parsed.groupId}`);
      }

      const existing = await query<{ id: string }>(
        "SELECT id FROM session WHERE session_key = $key LIMIT 1",
        { key: sessionKey },
      );

      if (existing && existing.length > 0) {
        currentSessionId = existing[0].id;
        await query(
          "UPDATE $id SET last_active = time::now()",
          { id: currentSessionId },
        );
        logger.debug(`Loaded existing session: ${currentSessionId}`);
      } else {
        currentSessionId = `session:${generateId("s")}`;
        await query(
          `CREATE $id CONTENT {
            session_key: $key,
            channel: $channel,
            chat_type: $chatType,
            topic_id: $topicId,
            group_id: $groupId,
            scope: $scope,
            last_active: time::now(),
            created_at: time::now()
          }`,
          {
            id: currentSessionId,
            key: sessionKey,
            channel,
            chatType,
            topicId,
            groupId,
            scope,
          },
        );
        logger.info(`Created session: ${currentSessionId} (${channel}/${chatType}, topic:${topicId})`);
      }

      return { bootstrapped: true };
    },

    // -----------------------------------------------------------------
    // ingest() — Called for each new message
    // Store as message node, create has_message edge to session.
    // -----------------------------------------------------------------
    async ingest(params: {
      role: string;
      content: string;
      toolCalls?: unknown[];
      toolName?: string;
    }) {
      if (!currentSessionId) {
        logger.warn("ingest() called before bootstrap — skipping");
        return { ingested: false };
      }

      const messageId = `message:${generateId("m")}`;
      const tokenCount = estimateTokens(params.content);

      // Create message node
      await query(
        `CREATE $id CONTENT {
          session: $session,
          role: $role,
          content: $content,
          tool_calls: $toolCalls,
          tool_name: $toolName,
          token_count: $tokenCount,
          created_at: time::now()
        }`,
        {
          id: messageId,
          session: currentSessionId,
          role: params.role,
          content: params.content,
          toolCalls: params.toolCalls ?? null,
          toolName: params.toolName ?? null,
          tokenCount: tokenCount,
        },
      );

      // Create structural edge: session → message
      await query(
        `LET $f = type::record($from); LET $t = type::record($to); RELATE $f->has_message->$t SET created_at = time::now();`,
        { from: currentSessionId, to: messageId },
      );

      logger.debug(`Ingested ${params.role} message (${tokenCount} tokens)`);
      return { ingested: true, messageId };
    },

    // -----------------------------------------------------------------
    // assemble() — Called before sending context to the LLM
    // Pass through current messages + inject cross-session memories.
    // -----------------------------------------------------------------
    async assemble(params: {
      messages: unknown[];
      tokenBudget: number;
      sessionKey?: string;
    }) {
      const messages = params.messages;
      const totalTokens = params.tokenBudget || 200_000;

      // Calculate memory budget (max 15% of total context window)
      const memoryBudget = Math.floor(totalTokens * config.memory_budget_pct);

      // --- CONTEXTUAL RECALL ---
      // Extract what the conversation is about from recent messages
      // so we recall RELEVANT memories, not just top-salience ones
      const recentMessages = messages.slice(-6); // Last 3 turns (user + assistant)
      const conversationContext = recentMessages
        .map((m: any) => m?.content ?? "")
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
            limit: 20,
            token_budget: Math.floor(memoryBudget * 0.7), // 70% for contextual
          });
          memories.push(...contextual);
        }

        // Always include high-salience memories (critical rules, preferences)
        // These are recalled regardless of what the conversation is about
        const critical = await recall({
          min_salience: 0.8,
          limit: 10,
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

      // Fit to token budget: 60% memories, 40% graph map
      const isFirstAssemble = !hasShownToolsGuide;
      const memBudget = Math.floor(memoryBudget * 0.6);
      const fitted = fitToTokenBudget(memories, memBudget);

      // Build injection — THREE parts on EVERY message:
      // 1. Categorized memories (contextual to conversation)
      // 2. Knowledge graph map (entities + relationships)
      // 3. Tools list (first message only)
      const parts: string[] = [];

      // Part 1: Categorized memories
      const memoriesText = formatMemories(fitted, isFirstAssemble);
      if (memoriesText) parts.push(memoriesText);

      // Part 2: Knowledge graph map — ALWAYS shown (this is the core product)
      try {
        const { getGraphSummary } = await import("../db/queries.js");
        const { queryMulti } = await import("../db/client.js");
        const graphQ = getGraphSummary();
        const graphResults = await queryMulti<[
          import("../config.js").GraphEntity[],
          import("../config.js").GraphEdge[],
          Array<{ count: number }>,
          Array<{ memories: number; entities: number; edges: number; sessions: number }>,
        ]>(graphQ.surql, graphQ.params);

        if (graphResults) {
          const [entities, edges, orphanResult, statsResult] = graphResults;
          const stats: import("../config.js").GraphStats = {
            memories: statsResult?.[0]?.memories ?? 0,
            entities: statsResult?.[0]?.entities ?? 0,
            edges: statsResult?.[0]?.edges ?? 0,
            sessions: statsResult?.[0]?.sessions ?? 0,
            orphans: orphanResult?.[0]?.count ?? 0,
          };
          const { formatGraphMap } = await import("../config.js");
          const graphMap = formatGraphMap(
            (entities ?? []) as import("../config.js").GraphEntity[],
            (edges ?? []) as import("../config.js").GraphEdge[],
            stats,
          );
          if (graphMap) parts.push(graphMap);
        }
      } catch (graphError) {
        logger.debug(`Graph map failed (non-fatal): ${graphError}`);
      }

      if (isFirstAssemble) hasShownToolsGuide = true;

      const systemPromptAddition = parts.join("\n\n");

      // Estimate tokens for the current messages
      const messagesText = messages
        .map((m: any) => m?.content ?? "")
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
    },

    // -----------------------------------------------------------------
    // compact() — Called when context window exceeds threshold
    // Extract memories from old messages, then drop them.
    // This is where memories are BORN — compaction = memory creation.
    // -----------------------------------------------------------------
    async compact(params: {
      messages: unknown[];
      tokenBudget: number;
      currentTokenCount: number;
    }) {
      const { messages, tokenBudget, currentTokenCount } = params;

      if (!subagentRunner) {
        logger.warn("No subagent runner — cannot extract memories during compaction");
        return { ok: false, compacted: false };
      }

      // Calculate how many messages to compact
      // Keep fresh_tail_count messages protected from compaction
      const protectedCount = config.fresh_tail_count;
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
        content: m.content ?? "",
        token_count: 0,
        created_at: new Date().toISOString(),
      })) as import("../config.js").Message[];

      let extractedFacts: ExtractedFact[] = [];
      try {
        extractedFacts = await extractMemories(oldMsgArray, subagentRunner);
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
            },
            subagentRunner,
          );
          savedCount++;
        } catch (error) {
          logger.warn(`Failed to save fact: ${error}`);
        }
      }

      logger.info(
        `Compaction: extracted ${extractedFacts.length} facts, saved ${savedCount}`,
      );

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
        freshMessages.map((m: any) => m?.content ?? "").join(" "),
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
    },

    // -----------------------------------------------------------------
    // afterTurn() — Called after the agent responds (async, non-blocking)
    // Extract facts from recent messages, dedup, and save.
    // Also: pre-compaction flush at 70% context usage.
    // -----------------------------------------------------------------
    async afterTurn(params: {
      messages: unknown[];
      tokenBudget?: number;
      currentTokenCount?: number;
    }) {
      if (!subagentRunner) return;

      const { messages, tokenBudget, currentTokenCount } = params;

      // Pre-compaction flush: if context > 70%, extract memories NOW
      // This fixes OpenClaw #19488 where the built-in flush never fires
      if (tokenBudget && currentTokenCount) {
        const usageRatio = currentTokenCount / tokenBudget;
        if (usageRatio > 0.7) {
          logger.info(
            `Pre-compaction flush: context at ${Math.round(usageRatio * 100)}%`,
          );
          // Extract from all but the most recent messages
          const extractableMessages = messages.slice(
            0,
            Math.max(0, messages.length - config.fresh_tail_count),
          );
          if (extractableMessages.length > 0) {
            const msgArray = extractableMessages.map((m: any) => ({
              id: "", session: "", role: m.role ?? "user",
              content: m.content ?? "", token_count: 0, created_at: new Date().toISOString(),
            })) as import("../config.js").Message[];
            try {
              const facts = await extractMemories(msgArray, subagentRunner);
              for (const fact of facts) {
                await saveMemory(
                  { content: fact.content, category: fact.category,
                    salience: fact.salience, scope: fact.scope, source_type: "conversation" },
                  subagentRunner,
                );
              }
              logger.info(`Pre-compaction flush: saved ${facts.length} facts`);
            } catch (error) {
              logger.warn(`Pre-compaction flush failed: ${error}`);
            }
          }
        }
      }

      // Background: extract facts from the last few messages
      const recentMsgArray = messages.slice(-4).map((m: any) => ({
        id: "", session: "", role: m.role ?? "user",
        content: m.content ?? "", token_count: 0, created_at: new Date().toISOString(),
      })) as import("../config.js").Message[];

      // Skip very short messages
      const totalContent = recentMsgArray.map(m => m.content).join("").length;
      if (totalContent < 100) return;

      try {
        const facts = await extractMemories(recentMsgArray, subagentRunner);
        for (const fact of facts) {
          await saveMemory(
            { content: fact.content, category: fact.category,
              salience: fact.salience, scope: fact.scope, source_type: "conversation" },
            subagentRunner,
          );
        }
        if (facts.length > 0) {
          logger.debug(`afterTurn: extracted ${facts.length} facts`);
        }
      } catch (error) {
        logger.warn(`afterTurn extraction failed: ${error}`);
      }
    },

    // -----------------------------------------------------------------
    // prepareSubagentSpawn() — Called when a subagent is about to start
    // Query relevant memories for the child session.
    // -----------------------------------------------------------------
    async prepareSubagentSpawn(params: {
      parentSessionKey: string;
      childSessionKey: string;
      task?: string;
    }) {
      // Search for memories relevant to the child's task
      let context = "";

      if (params.task) {
        try {
          const relevant = await recall({
            query: params.task,
            limit: 10,
            token_budget: 2000,
          });

          if (relevant.length > 0) {
            context = formatMemories(relevant);
            logger.debug(
              `Sharing ${relevant.length} memories with child session`,
            );
          }
        } catch (error) {
          logger.warn(`Failed to prepare subagent context: ${error}`);
        }
      }

      return { context };
    },

    // -----------------------------------------------------------------
    // onSubagentEnded() — Called when a subagent finishes
    // Could ingest child's output into graph (future enhancement).
    // -----------------------------------------------------------------
    async onSubagentEnded(params: {
      childSessionKey: string;
      reason: string;
      output?: string;
    }) {
      // Future: ingest child output as memories
      logger.debug(
        `Subagent ended: ${params.childSessionKey} (${params.reason})`,
      );
    },

    // -----------------------------------------------------------------
    // dispose() — Called when the session ends
    // Disconnect from SurrealDB.
    // -----------------------------------------------------------------
    async dispose() {
      logger.info("Disposing Qmemory engine");
      await disconnect();
    },
  };
}

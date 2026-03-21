/**
 * Qmemory Context Engine
 *
 * Implements the full OpenClaw ContextEngine interface.
 * OpenClaw calls these methods for every session lifecycle event:
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
import {
  getGraphEntities,
  getGraphEdges,
  getGraphStats,
} from "../db/queries.js";
import type {
  QmemoryConfig,
  QmemoryLogger,
  Memory,
  RecalledMemory,
  ExtractedFact,
  GraphEntity,
  GraphEdge,
  GraphStats,
} from "../config.js";
import {
  formatMemories,
  formatGraphMap,
  fitToTokenBudget,
  estimateTokens,
  getAge,
} from "../config.js";
import { enableVectorIndex, backfillEmbeddings } from "../core/embeddings.js";
import type { EmbeddingConfig } from "../core/embeddings.js";
import { migrateWorkspaceMemories, setMigrateLogger } from "../core/migrate.js";
import { getScratchpad, updateScratchpad, clearScratchpad, setScratchpadLogger } from "../core/scratchpad.js";
import { trackEvent, setMetricsLogger } from "../core/metrics.js";
import type { SubagentRunner } from "./index.js";
import type { SharedEngineState } from "./hooks.js";
import type { ToolCall } from "../config.js";

// Module-level logger — set by createEngine(), used by extractText()
let moduleLogger: QmemoryLogger | null = null;

/** Extract ID from string or RecordId: "session:s1234" → "s1234" */
function sessionIdPart(fullId: unknown): string {
  const str = String(fullId);
  const idx = str.indexOf(":");
  return idx >= 0 ? str.slice(idx + 1) : str;
}

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
// Message content extractor
// ---------------------------------------------------------------------------
// OpenClaw messages use content blocks: [{type:"text",text:"..."}, ...]
// NOT plain strings. This helper extracts the text safely.

/**
 * Extract plain text from an OpenClaw message's content field.
 *
 * OpenClaw uses the pi-ai message format where content is:
 *   - string (rare, some user messages)
 *   - array of content blocks: [{type:"text", text:"..."}, {type:"toolCall",...}]
 *
 * Without this helper, you'd get "[object Object]" from .toString() on the array.
 */
function extractText(content: unknown): string {
  // Already a string — return as-is
  if (typeof content === "string") return content;

  // Array of content blocks — extract text from "text" blocks
  if (Array.isArray(content)) {
    const text = content
      .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
      .map((block: any) => block.text)
      .join("\n");
    // Warn if array had items but none were text blocks (new provider format?)
    if (text.length === 0 && content.length > 0) {
      const types = content.map((b: any) => b?.type ?? typeof b).join(", ");
      moduleLogger?.debug(`extractText: no text blocks in array of ${content.length} items (types: ${types})`);
    }
    return text;
  }

  // Non-null unknown type — log so we catch new provider formats
  if (content !== null && content !== undefined) {
    moduleLogger?.debug(`extractText: unexpected content type: ${typeof content}`);
  }
  return "";
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
// Process-level flags — avoid redundant work across sessions
// ---------------------------------------------------------------------------

let schemaApplied = false;
let vectorIndexEnabled = false;
let backfillDone = false;

// Graph map cache — avoid re-querying every assemble() turn
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Engine factory — returns the ContextEngine object
// ---------------------------------------------------------------------------

export function createEngine(
  config: QmemoryConfig,
  logger: QmemoryLogger,
  subagentRunner?: SubagentRunner,
  _openclawConfig?: Record<string, unknown>,
  embeddingConfig?: EmbeddingConfig,
  sharedState?: SharedEngineState,
) {
  // Track the current session for this engine instance
  let currentSessionId: string | null = null;
  let currentSessionKey: string | null = null;
  let hasShownToolsGuide = false; // Show tools list only on first assemble per session

  // Graph map cache (per engine instance)
  let graphMapCache: string | null = null;
  let graphMapCacheTime: number = 0;

  // Set the logger on the DB client, core modules, and module-level
  setLogger(logger);
  setScratchpadLogger(logger);
  setMetricsLogger(logger);
  moduleLogger = logger;

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

      // Check SurrealDB version — v3.0+ required
      try {
        const versionResult = await query<string>("INFO FOR DB;");
        // If INFO FOR DB works without error, we're on a supported version.
        // SurrealDB v2 would fail on our schema syntax anyway.
      } catch {
        // Non-fatal — version check is best-effort
      }

      // Apply schema (skipped if already applied this process)
      try {
        if (!schemaApplied) {
          const schemaPath = getSchemaPath();
          const schemaSurql = await readFile(schemaPath, "utf-8");
          await applySchema(schemaSurql);
          schemaApplied = true;
        }

        // --- AUTO-IMPORT: First run detection ---
        // If 0 memories exist, auto-import old memory files
        const memCount = await query<{ count: number }>(
          "SELECT count() AS count FROM memory GROUP ALL;"
        );
        if (memCount && memCount.length > 0 && memCount[0].count === 0 && subagentRunner) {
          logger.info("First run detected (0 memories) — auto-importing workspace memory files...");
          try {
            setMigrateLogger(logger);
            // Detect workspace path from OpenClaw config or default
            const workspacePath = (_openclawConfig as any)?.workspace?.path
              ?? join(process.env.HOME ?? "", ".openclaw", "workspace");
            const result = await migrateWorkspaceMemories(workspacePath, subagentRunner!);
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

      // Enable vector index (skipped if already enabled this process)
      if (!vectorIndexEnabled && embeddingConfig && embeddingConfig.provider !== "none") {
        try {
          await enableVectorIndex(embeddingConfig.dimension);
          vectorIndexEnabled = true;
        } catch {
          // Non-fatal — vector search degrades gracefully
        }
      }
      // Backfill embeddings (separate from index — runs once per process)
      if (!backfillDone && embeddingConfig && embeddingConfig.provider !== "none") {
        backfillDone = true;
        backfillEmbeddings(embeddingConfig).catch((e) => {
          logger.debug(`Backfill error: ${e}`);
        });
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
        currentSessionId = String(existing[0].id); // RecordId → string
        if (sharedState) sharedState.currentSessionId = currentSessionId;
        await query(
          "UPDATE type::record($id) SET last_active = time::now()",
          { id: currentSessionId },
        );
        logger.debug(`Loaded existing session: ${currentSessionId}`);
      } else {
        const sessionIdPart = generateId("s");
        currentSessionId = `session:${sessionIdPart}`;
        if (sharedState) sharedState.currentSessionId = currentSessionId;
        // Build params — omit null optional fields (SurrealDB 3.0 rejects NULL for option<string>)
        const sessionParams: Record<string, unknown> = {
          idPart: sessionIdPart,
          key: sessionKey,
          channel,
          chatType,
          scope,
        };
        // Only include optional fields when they have values
        const optionalFields: string[] = [];
        if (topicId) {
          sessionParams.topicId = topicId;
          optionalFields.push("topic_id: $topicId,");
        }
        if (groupId) {
          sessionParams.groupId = groupId;
          optionalFields.push("group_id: $groupId,");
        }
        await query(
          `CREATE type::record("session", $idPart) CONTENT {
            session_key: $key,
            channel: $channel,
            chat_type: $chatType,
            ${optionalFields.join("\n            ")}
            scope: $scope,
            last_active: time::now(),
            created_at: time::now()
          }`,
          sessionParams,
        );
        logger.info(`Created session: ${currentSessionId} (${channel}/${chatType}, topic:${topicId})`);
      }

      // --- AUTO-CREATE GRAPH STRUCTURE ---
      // Create channel + topic entities and link session to them.
      // This builds the tree: channel → has_topic → topic → has_session → session
      // Runs in background — non-blocking.
      (async () => {
        try {
          if (!currentSessionId) return;
          const sid = sessionIdPart(currentSessionId);

          // Create or find channel entity
          if (channel && channel !== "unknown") {
            await query(
              `UPSERT entity SET
                name = $name, type = "channel",
                external_source = $channel,
                updated_at = time::now(),
                created_at = created_at ?? time::now()
              WHERE name = $name AND type = "channel"`,
              { name: channel, channel },
            );
          }

          // Link session → channel directly (for DMs, crons, non-topic sessions)
          if (channel && channel !== "unknown" && !topicId) {
            const existing = await query<{ id: string }>(
              `SELECT id FROM relates
               WHERE in = type::record("session", $sid)
                 AND type = "belongs_to_channel"
               LIMIT 1`,
              { sid },
            );
            if (!existing || existing.length === 0) {
              await query(
                `LET $s = type::record("session", $sid);
                 LET $c = (SELECT id FROM entity WHERE name = $channel AND type = "channel" LIMIT 1);
                 IF $c[0] != NONE THEN
                   RELATE $s->relates->$c[0].id CONTENT {
                     type: "belongs_to_channel",
                     confidence: 1.0,
                     created_by: "system",
                     created_at: time::now()
                   }
                 END;`,
                { sid, channel },
              );
            }
          }

          // Create or find topic entity + link session → topic
          if (topicId) {
            const topicName = `${channel}/topic:${topicId}`;
            await query(
              `UPSERT entity SET
                name = $name, type = "topic",
                external_source = $channel,
                external_id = $topicId,
                updated_at = time::now(),
                created_at = created_at ?? time::now()
              WHERE name = $name AND type = "topic"`,
              { name: topicName, channel, topicId },
            );

            // Link session → topic (if not already linked)
            const existing = await query<{ id: string }>(
              `SELECT id FROM relates
               WHERE in = type::record("session", $sid)
                 AND type = "belongs_to_topic"
               LIMIT 1`,
              { sid },
            );
            if (!existing || existing.length === 0) {
              await query(
                `LET $s = type::record("session", $sid);
                 LET $t = (SELECT id FROM entity WHERE name = $topicName AND type = "topic" LIMIT 1);
                 IF $t[0] != NONE THEN
                   RELATE $s->relates->$t[0].id CONTENT {
                     type: "belongs_to_topic",
                     confidence: 1.0,
                     created_by: "system",
                     created_at: time::now()
                   }
                 END;`,
                { sid, topicName },
              );
            }

            // Link topic → channel (if not already linked)
            await query(
              `LET $t = (SELECT id FROM entity WHERE name = $topicName AND type = "topic" LIMIT 1);
               LET $c = (SELECT id FROM entity WHERE name = $channel AND type = "channel" LIMIT 1);
               IF $t[0] != NONE AND $c[0] != NONE THEN
                 IF (SELECT id FROM relates WHERE in = $t[0].id AND out = $c[0].id AND type = "part_of_channel" LIMIT 1) = [] THEN
                   RELATE $t[0].id->relates->$c[0].id CONTENT {
                     type: "part_of_channel",
                     confidence: 1.0,
                     created_by: "system",
                     created_at: time::now()
                   }
                 END
               END;`,
              { topicName, channel },
            );
          }
        } catch (err) {
          logger.debug(`Auto-graph structure failed (non-fatal): ${err}`);
        }
      })();

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
      // SurrealDB 3.0: option<> fields reject NULL — omit them entirely when absent
      const optionalMsgFields: string[] = [];
      const msgParams: Record<string, unknown> = {
        id: messageId,
        sessionId: sessionIdPart(currentSessionId!),
        role: params.role,
        content: params.content,
        tokenCount: tokenCount,
      };
      if (params.toolCalls) {
        optionalMsgFields.push("tool_calls: $toolCalls,");
        msgParams.toolCalls = params.toolCalls;
      }
      if (params.toolName) {
        optionalMsgFields.push("tool_name: $toolName,");
        msgParams.toolName = params.toolName;
      }

      await query(
        `CREATE $id CONTENT {
          session: type::record("session", $sessionId),
          role: $role,
          content: $content,
          ${optionalMsgFields.join("\n          ")}
          token_count: $tokenCount,
          created_at: time::now()
        }`,
        msgParams,
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

      // Token budget split (must sum to 100%):
      //   52% memories, 5% tool ledger, 3% scratchpad, 40% graph map
      const isFirstAssemble = !hasShownToolsGuide;
      const memBudget = Math.floor(memoryBudget * 0.52);
      const fitted = fitToTokenBudget(memories, memBudget);

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
             AND content ~ "[cron"
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
        if (!graphMapCache || now - graphMapCacheTime > GRAPH_CACHE_TTL_MS) {
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
          graphMapCache = formatGraphMap(
            (entities ?? []) as GraphEntity[],
            (edges ?? []) as GraphEdge[],
            stats,
          );
          graphMapCacheTime = now;
        }
        if (graphMapCache) parts.push(graphMapCache);
      } catch (graphError) {
        logger.debug(`Graph map failed (non-fatal): ${graphError}`);
      }

      if (isFirstAssemble) hasShownToolsGuide = true;

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
            embeddingConfig,
          );
          savedCount++;
        } catch (error) {
          logger.warn(`Failed to save fact: ${error}`);
        }
      }

      // Invalidate graph cache since new memories were saved
      if (savedCount > 0) graphMapCache = null;

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
    },

    // -----------------------------------------------------------------
    // afterTurn() — Called after the agent responds (async, non-blocking)
    // Multi-stage graduated compaction:
    //   Stage 1 (50%+): Light — summarize old turns
    //   Stage 2 (70%+): Medium — existing pre-compaction flush
    //   Stage 3 (85%+): Heavy — clear old tool_call records, compress scratchpad
    //   Stage 4 (95%+): Emergency — extract ALL memories, full checkpoint
    // -----------------------------------------------------------------
    async afterTurn(params: {
      messages: unknown[];
      tokenBudget?: number;
      currentTokenCount?: number;
    }) {
      if (!subagentRunner) return;

      const { messages, tokenBudget, currentTokenCount } = params;

      // --- STORE MESSAGES ---
      // OpenClaw calls afterTurn() INSTEAD of ingest() when afterTurn exists.
      // Store the last few messages so cross-session message search works.
      // This is what makes Qmemory bypass OpenClaw's session isolation.
      if (currentSessionId && messages.length > 0) {
        try {
          const sid = sessionIdPart(currentSessionId);
          // Only store the last 2 messages (current turn) to avoid re-storing old ones
          const newMsgs = messages.slice(-2);
          for (const m of newMsgs) {
            const text = extractText((m as any)?.content);
            if (!text || text.length < 5) continue;
            const role = (m as any)?.role ?? "unknown";
            const msgId = `message:${generateId("m")}`;
            await query(
              `CREATE $id CONTENT {
                session: type::record("session", $sid),
                role: $role,
                content: $content,
                token_count: $tokenCount,
                created_at: time::now()
              }`,
              {
                id: msgId,
                sid,
                role,
                content: text.slice(0, 2000), // Cap to avoid huge records
                tokenCount: estimateTokens(text),
              },
            );
            // Create structural edge
            await query(
              `LET $f = type::record("session", $sid); LET $t = type::record($to);
               RELATE $f->has_message->$t SET created_at = time::now();`,
              { sid, to: msgId },
            );
          }
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
            })) as import("../config.js").Message[];
            try {
              const facts = await extractMemories(msgArray, subagentRunner);
              for (const fact of facts) {
                await saveMemory(
                  { content: fact.content, category: fact.category,
                    salience: fact.salience, scope: fact.scope, source_type: "conversation" },
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
            })) as import("../config.js").Message[];
            try {
              const facts = await extractMemories(msgArray, subagentRunner);
              for (const fact of facts) {
                await saveMemory(
                  { content: fact.content, category: fact.category,
                    salience: fact.salience, scope: fact.scope, source_type: "conversation" },
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
            })) as import("../config.js").Message[];
            try {
              const facts = await extractMemories(msgArray, subagentRunner);
              for (const fact of facts) {
                await saveMemory(
                  { content: fact.content, category: fact.category,
                    salience: fact.salience, scope: fact.scope, source_type: "conversation" },
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
            })) as import("../config.js").Message[];
            try {
              const facts = await extractMemories(msgArray, subagentRunner);
              for (const fact of facts) {
                await saveMemory(
                  { content: fact.content, category: fact.category,
                    salience: fact.salience, scope: fact.scope, source_type: "conversation" },
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

      // Background: extract facts from the last few messages
      const recentMsgArray = messages.slice(-4).map((m: any) => ({
        id: "", session: "", role: m.role ?? "user",
        content: extractText(m?.content), token_count: 0, created_at: new Date().toISOString(),
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
            embeddingConfig,
          );
        }
        if (facts.length > 0) {
          graphMapCache = null; // Invalidate graph cache
          logger.debug(`afterTurn: extracted ${facts.length} facts`);
          if (currentSessionId) {
            trackEvent(currentSessionId, "extraction", String(facts.length)).catch(() => {});
          }
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
    // dispose() — Called when an agent run ends
    // Do NOT disconnect SurrealDB here — the connection is shared across
    // all engine instances and must persist for the gateway's lifetime.
    // OpenClaw creates/disposes engines per agent run, but the DB
    // connection is process-level. Disconnecting here causes Bug 3
    // (recall returns 0) because subsequent runs find db = null.
    // -----------------------------------------------------------------
    async dispose() {
      logger.debug("Engine dispose (connection kept alive)");
    },
  };
}

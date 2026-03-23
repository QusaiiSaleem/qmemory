/**
 * Engine bootstrap — DB init, schema apply, session creation, graph tree
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connect,
  query,
  applySchema,
  generateId,
} from "../../db/client.js";
import { enableVectorIndex, backfillEmbeddings } from "../../core/embeddings.js";
import { migrateWorkspaceMemories, setMigrateLogger } from "../../core/migrate.js";
import type { QmemoryConfig, QmemoryLogger } from "../../config.js";
import type { EmbeddingConfig } from "../../core/embeddings.js";
import type { SubagentRunner } from "../index.js";
import type { SharedEngineState } from "../hooks.js";
import { sessionIdPart, parseSessionKey } from "./session.js";

// ---------------------------------------------------------------------------
// Process-level flags — avoid redundant work across sessions
// ---------------------------------------------------------------------------

let schemaApplied = false;
let vectorIndexEnabled = false;
let backfillDone = false;

// ---------------------------------------------------------------------------
// Schema file path — resolved relative to this file's location
// ---------------------------------------------------------------------------

function getSchemaPath(): string {
  // In compiled JS: dist/openclaw/engine/bootstrap.js → ../../../schema/qmemory.surql
  // In source TS: src/openclaw/engine/bootstrap.ts → ../../../schema/qmemory.surql
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, "..", "..", "..", "schema", "qmemory.surql");
  } catch {
    // Fallback for environments where import.meta.url is unavailable
    return join(process.cwd(), "schema", "qmemory.surql");
  }
}

// ---------------------------------------------------------------------------
// Bootstrap state — returned to the engine factory
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  bootstrapped: boolean;
  currentSessionId?: string;
  currentSessionKey?: string;
  isDiscoveryMode?: boolean;
}

// ---------------------------------------------------------------------------
// bootstrap() — Called once when a session starts
// ---------------------------------------------------------------------------

export async function bootstrap(
  params: {
    sessionId: string;
    sessionKey?: string;
    channel?: string;
    chatType?: string;
    topicId?: string;
    groupId?: string;
    scope?: string;
  },
  config: QmemoryConfig,
  logger: QmemoryLogger,
  subagentRunner?: SubagentRunner,
  _openclawConfig?: Record<string, unknown>,
  embeddingConfig?: EmbeddingConfig,
  sharedState?: SharedEngineState,
): Promise<BootstrapResult> {
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

  let isDiscoveryMode = false;

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
    // Check if in discovery mode (< 72h since first memory)
    const firstMemoryResult = await query<{ created_at: string }>(
      "SELECT created_at FROM memory ORDER BY created_at ASC LIMIT 1",
    );
    const firstMemoryDate = firstMemoryResult?.[0]?.created_at;
    isDiscoveryMode = !firstMemoryDate ||
      (Date.now() - new Date(firstMemoryDate).getTime()) < 72 * 60 * 60 * 1000;

    if (isDiscoveryMode) {
      logger.info("Discovery Mode active — aggressive extraction enabled");
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

  let currentSessionId: string;

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
    const sessionIdPartStr = generateId("s");
    currentSessionId = `session:${sessionIdPartStr}`;
    if (sharedState) sharedState.currentSessionId = currentSessionId;
    // Build params — omit null optional fields (SurrealDB 3.0 rejects NULL for option<string>)
    const sessionParams: Record<string, unknown> = {
      idPart: sessionIdPartStr,
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
        ${optionalFields.join("\n        ")}
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

  return {
    bootstrapped: true,
    currentSessionId,
    currentSessionKey: sessionKey,
    isDiscoveryMode,
  };
}

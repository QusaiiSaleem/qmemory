/**
 * Qmemory — OpenClaw Plugin Entry Point
 *
 * Registers Qmemory as a context engine (replaces LCM),
 * plus 4 agent tools, a background linker service,
 * and an HTTP route for the graph viewer.
 *
 * This is the "deepest" integration — full context engine
 * that owns bootstrap, ingest, assemble, compact, and afterTurn.
 */

import { Type } from "@sinclair/typebox";
import { createEngine } from "./engine.js";
import { createLinkerService } from "./linker.js";
import { searchMemories } from "../core/search.js";
import { saveMemory } from "../core/save.js";
import { correctMemory } from "../core/correct.js";
import { linkNodes } from "../core/link.js";
import { resolveEmbeddingConfig, setEmbeddingLogger } from "../core/embeddings.js";
import type {
  QmemoryConfig,
  QmemoryLogger,
  RecallOptions,
} from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Subagent runner type — wraps OpenClaw's subagent API into a simple function
// ---------------------------------------------------------------------------

export type SubagentRunner = (task: string) => Promise<string>;

let subagentCounter = 0;

function createSubagentRunner(api: any): SubagentRunner {
  return async (task: string): Promise<string> => {
    // Generate a unique session key for this subagent run
    const sessionKey = `qmemory:subagent:${Date.now()}-${++subagentCounter}`;

    try {
      // 1. Start the subagent run
      const { runId } = await api.runtime.subagent.run({
        sessionKey,
        message: task,
        idempotencyKey: `qmem-${Date.now()}-${subagentCounter}`,
        lane: "subagent",
      });

      // 2. Wait for it to complete (15s timeout)
      const waitResult = await api.runtime.subagent.waitForRun({
        runId,
        timeoutMs: 15000,
      });

      if (waitResult.status !== "ok") {
        return "";
      }

      // 3. Read the assistant's response
      const { messages } = await api.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 10,
      });

      // Extract text from the last assistant message
      const assistantMsgs = messages.filter(
        (m: any) => m.role === "assistant",
      );
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      const text = lastMsg?.content
        ?.filter((c: any) => c.type === "text")
        ?.map((c: any) => c.text)
        ?.join("") ?? "";

      // 4. Cleanup
      await api.runtime.subagent.deleteSession({
        sessionKey,
        deleteTranscript: true,
      }).catch(() => {});

      return text;
    } catch (error) {
      return "";
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin entry — OpenClaw calls this function on load
// ---------------------------------------------------------------------------

export default function register(api: any): void {
  // 1. Merge user config with defaults
  const userConfig = api.getPluginConfig?.() ?? {};
  const config: QmemoryConfig = { ...DEFAULT_CONFIG, ...userConfig };

  // 2. Use OpenClaw's logger (falls back to console in standalone)
  const logger: QmemoryLogger = api.logger ?? {
    debug: (msg: string) => console.debug(`[qmemory] ${msg}`),
    info: (msg: string) => console.log(`[qmemory] ${msg}`),
    warn: (msg: string) => console.warn(`[qmemory] ${msg}`),
    error: (msg: string) => console.error(`[qmemory] ${msg}`),
  };

  // 3. Create the subagent runner (for LLM operations: dedup, extract, link)
  const subagentRunner = createSubagentRunner(api);

  // 4. Resolve embedding config from OpenClaw's EXISTING settings (no extra API key!)
  const openclawConfig = api.config as Record<string, unknown> | undefined;

  // 4b. Resolve embedding config (used by save tool for vector generation)
  setEmbeddingLogger(logger);
  const embeddingConfig = resolveEmbeddingConfig(config, openclawConfig);

  // 5. Pre-flight: check SurrealDB health (non-blocking)
  (async () => {
    try {
      const { connect, isHealthy } = await import("../db/client.js");
      const db = await connect(config);
      if (db) {
        const healthy = await isHealthy();
        if (healthy) {
          logger.info(`SurrealDB connected: ${config.surrealdb_url}`);
        } else {
          logger.warn(
            `SurrealDB at ${config.surrealdb_url} is not responding. ` +
            `Run: surreal start --user root --pass root file:~/.qmemory/data.db`
          );
        }
      } else {
        logger.warn(
          `Cannot connect to SurrealDB at ${config.surrealdb_url}. ` +
          `Qmemory will run in degraded mode (no memory persistence). ` +
          `To fix: bash /path/to/Qmemory/scripts/setup-surrealdb-launchagent.sh`
        );
      }
    } catch {
      // Non-fatal — bootstrap() will retry
    }
  })();

  // 6. Check tools.alsoAllow config — warn if plugin tools will be hidden
  const toolsConfig = (openclawConfig as any)?.tools;
  const alsoAllow: string[] = toolsConfig?.alsoAllow ?? [];
  const hasPluginGroup = alsoAllow.some(
    (entry: string) => entry === "group:plugins" || entry === "qmemory",
  );
  if (!hasPluginGroup && toolsConfig?.profile) {
    logger.warn(
      `tools.profile="${toolsConfig.profile}" is set but tools.alsoAllow does not include "group:plugins". ` +
      `Qmemory tools will NOT be visible to the agent. ` +
      `Fix: openclaw config set tools.alsoAllow '["group:plugins"]'`,
    );
  }

  // 7. Register the context engine (replaces LCM)
  const engine = createEngine(config, logger, subagentRunner, openclawConfig);
  api.registerContextEngine("qmemory", () => engine);

  logger.info("Context engine registered");

  // ----- TOOLS -----

  // Tool 1: qmemory_search — search cross-session memory
  api.registerTool(
    {
      name: "qmemory_search",
      label: "Qmemory Search",
      description:
        "Search cross-session memory by meaning, category, scope, or graph traversal. " +
        "Use when you need to recall past knowledge from any session or topic.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({ description: "Search by meaning (BM25 full-text)" }),
        ),
        categories: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Filter by category: style, preference, context, decision, idea, feedback, domain",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Filter by scope: global, project:xxx, topic:xxx",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max results (default 10)",
            minimum: 1,
            maximum: 50,
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const results = await searchMemories(params as RecallOptions);
        return {
          content: [
            { type: "text", text: JSON.stringify(results, null, 2) },
          ],
        };
      },
    },
    { name: "qmemory_search", optional: false },
  );

  // Tool 2: qmemory_save — save a fact with LLM dedup
  api.registerTool(
    {
      name: "qmemory_save",
      label: "Qmemory Save",
      description:
        "Save a fact to cross-session memory with LLM-driven deduplication. " +
        "The system will check for duplicates and update existing memories if needed.",
      parameters: Type.Object({
        content: Type.String({ description: "The fact to remember (one clear statement)" }),
        category: Type.String({
          description:
            "Category: style, preference, context, decision, idea, feedback, or domain",
        }),
        salience: Type.Optional(
          Type.Number({
            description: "Importance 0.0-1.0 (default 0.5). Use 0.8+ for critical facts",
            minimum: 0,
            maximum: 1,
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description: "Scope: global (default), project:xxx, or topic:xxx",
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const result = await saveMemory(
          {
            content: params.content as string,
            category: params.category as import("../config.js").MemoryCategory,
            salience: (params.salience as number) ?? 0.5,
            scope: (params.scope as string) ?? "global",
          },
          subagentRunner,
          embeddingConfig,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    },
    { name: "qmemory_save", optional: false },
  );

  // Tool 3: qmemory_correct — fix or delete a wrong memory
  api.registerTool(
    {
      name: "qmemory_correct",
      label: "Qmemory Correct",
      description:
        "Fix, update, delete, or unlink memories and relationships. " +
        "4 actions: 'correct' = fix content (creates version chain), " +
        "'delete' = soft-delete, 'update' = change salience/scope/expiry without new version, " +
        "'unlink' = remove a relationship edge. Use when user gives feedback.",
      parameters: Type.Object({
        memory_id: Type.String({ description: "The memory ID to correct (e.g. memory:xxx)" }),
        action: Type.String({
          description:
            '"correct" = fix content (version chain), "delete" = soft-delete, ' +
            '"update" = change metadata (salience/scope/valid_until), ' +
            '"unlink" = remove a relationship edge',
        }),
        new_content: Type.Optional(
          Type.String({ description: "New content (for correct/update)" }),
        ),
        salience: Type.Optional(
          Type.Number({ description: "New salience 0-1 (for update)", minimum: 0, maximum: 1 }),
        ),
        scope: Type.Optional(
          Type.String({ description: "New scope (for update): global, project:xxx, topic:xxx" }),
        ),
        valid_until: Type.Optional(
          Type.String({ description: "Expiry date ISO (for update): marks fact as no longer true" }),
        ),
        edge_id: Type.Optional(
          Type.String({ description: "Edge ID to remove (for unlink): e.g. relates:xxx" }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const result = await correctMemory({
          memory_id: params.memory_id as string,
          action: params.action as "correct" | "delete" | "update" | "unlink",
          new_content: params.new_content as string | undefined,
          salience: params.salience as number | undefined,
          scope: params.scope as string | undefined,
          valid_until: params.valid_until as string | undefined,
          edge_id: params.edge_id as string | undefined,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    },
    { name: "qmemory_correct", optional: false },
  );

  // Tool 4: qmemory_link — create a relationship between any two things
  api.registerTool(
    {
      name: "qmemory_link",
      label: "Qmemory Link",
      description:
        "Create a relationship between any two things in memory. " +
        "The type can be ANY relationship — supports, contradicts, manages, " +
        "blocks, depends_on, caused_by, or anything that fits.",
      parameters: Type.Object({
        from_id: Type.String({ description: "Source node ID (e.g. memory:xxx, entity:xxx)" }),
        to_id: Type.String({ description: "Target node ID (e.g. memory:xxx, entity:xxx)" }),
        type: Type.String({
          description:
            "Relationship type — any string: supports, contradicts, manages, " +
            "blocks, depends_on, caused_by, reports_to, monitors, etc.",
        }),
        reason: Type.Optional(
          Type.String({ description: "Why this relationship exists" }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const result = await linkNodes({
          from_id: params.from_id as string,
          to_id: params.to_id as string,
          type: params.type as string,
          reason: params.reason as string | undefined,
          created_by: "agent",
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    },
    { name: "qmemory_link", optional: false },
  );

  // Tool 5: qmemory_import — import a file into the memory graph
  api.registerTool(
    {
      name: "qmemory_import",
      label: "Qmemory Import",
      description:
        "Import a memory file into the Qmemory graph. " +
        "Reads the file, extracts facts using AI, saves with dedup, " +
        "and creates relationships. Use to migrate old memory files " +
        "or import any markdown file as knowledge. " +
        "Example: qmemory_import({file_path: '~/.openclaw/workspace/memory/2026-03-14.md'})",
      parameters: Type.Object({
        file_path: Type.String({
          description: "Absolute path to the markdown file to import",
        }),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const { importFile, setMigrateLogger } = await import("../core/migrate.js");
        setMigrateLogger(logger);
        const result = await importFile(
          params.file_path as string,
          subagentRunner,
        );
        return {
          content: [
            {
              type: "text",
              text: `Imported: ${result.facts_extracted} facts extracted, ${result.memories_created} new memories created`,
            },
          ],
        };
      },
    },
    { name: "qmemory_import", optional: false },
  );

  // Tool 6: qmemory_person — create/find a person with linked identities
  api.registerTool(
    {
      name: "qmemory_person",
      label: "Qmemory Person",
      description:
        "Create or find a person with multiple linked identities (WhatsApp, email, " +
        "Telegram, Smartsheet, etc). A person can have many contacts — each linked " +
        "via 'has_identity'. Use to build a contact graph that connects people to " +
        "their messages, tasks, emails, and decisions across all systems.\n\n" +
        "Examples:\n" +
        "- Create: qmemory_person({ name: 'Ahmed', contacts: [{source: 'whatsapp', id: '966501234567'}, {source: 'gmail', id: 'ahmed@example.com'}] })\n" +
        "- Find: qmemory_person({ name: 'Ahmed', action: 'find' })",
      parameters: Type.Object({
        name: Type.String({ description: "Person's name" }),
        action: Type.Optional(
          Type.String({
            description: '"create" (default) or "find" — find returns person + all contacts + linked memories',
          }),
        ),
        aliases: Type.Optional(
          Type.Array(Type.String(), { description: "Alternative names (Arabic, nicknames)" }),
        ),
        contacts: Type.Optional(
          Type.Array(
            Type.Object({
              source: Type.String({
                description:
                  "System: whatsapp, telegram, hey, gmail, apple-reminders, " +
                  "calendar, smartsheet, railway, linkedin, github, slack, discord",
              }),
              id: Type.String({
                description: "ID in that system: phone number, email, username, user ID",
              }),
              url: Type.Optional(Type.String({ description: "Direct URL (optional)" })),
              label: Type.Optional(Type.String({ description: 'Display label: "Work email"' })),
            }),
            { description: "Contact identities to link" },
          ),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const { createPerson, findPersonContext, setPersonLogger } = await import("../core/person.js");
        setPersonLogger(logger);

        const action = (params.action as string) || "create";

        if (action === "find") {
          const result = await findPersonContext(params.name as string);
          if (!result.person) {
            return { content: [{ type: "text", text: `Person "${params.name}" not found` }] };
          }
          const summary = [
            `Person: ${result.person.name} (${String(result.person.id)})`,
            `Aliases: ${result.person.aliases?.join(", ") || "none"}`,
            `\nContacts (${result.contacts.length}):`,
            ...result.contacts.map(c =>
              `  - ${c.external_source}: ${c.external_id} ${c.external_url ? `(${c.external_url})` : ""}`
            ),
            `\nLinked memories (${result.memories.length}):`,
            ...result.memories.slice(0, 10).map(m => `  - [${m.type}] ${m.content}`),
          ].join("\n");
          return { content: [{ type: "text", text: summary }] };
        }

        const result = await createPerson({
          name: params.name as string,
          aliases: params.aliases as string[] | undefined,
          contacts: params.contacts as Array<{
            source: string; id: string; url?: string; label?: string;
          }> | undefined,
        });
        return {
          content: [{
            type: "text",
            text: `Person: ${result.person_id}\nContacts linked: ${result.contact_ids.length}\nNew links: ${result.links_created}`,
          }],
        };
      },
    },
    { name: "qmemory_person", optional: false },
  );

  // ----- SERVICE: Background Linker -----

  const linkerService = createLinkerService(config, logger, subagentRunner);
  api.registerService(linkerService);

  logger.info("Linker service registered");

  // ----- HTTP ROUTE: Graph Viewer -----

  api.registerHttpRoute({
    path: "/qmemory",
    auth: "plugin",
    match: "prefix",
    handler: async (req: any, res: any) => {
      const { handleGraphRequest } = await import("../ui/graph-handler.js");
      const host = req.headers.host ?? "localhost";
      const protocol = req.headers["x-forwarded-proto"] ?? "http";
      const url = new URL(req.url ?? "/", `${protocol}://${host}`);
      const handled = await handleGraphRequest(url, (status, headers, body) => {
        res.writeHead(status, headers);
        res.end(body);
      });
      if (!handled) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    },
  });

  logger.info("Qmemory plugin loaded (context engine + 6 tools + linker + graph route)");
}

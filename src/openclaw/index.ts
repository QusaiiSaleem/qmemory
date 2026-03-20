/**
 * Qmemory — OpenClaw Plugin Entry Point
 *
 * Registers Qmemory as a context-engine plugin,
 * plus 4 agent tools, a background linker service,
 * and an HTTP route for the graph viewer.
 *
 * This is the "deepest" integration — full context engine
 * that owns bootstrap, ingest, assemble, compact, and afterTurn.
 */

import { Type } from "@sinclair/typebox";
import { query } from "../db/client.js";
import { createEngine } from "./engine.js";
import { createLinkerService } from "./linker.js";
import { searchMemories } from "../core/search.js";
import { saveMemory } from "../core/save.js";
import { correctMemory } from "../core/correct.js";
import { linkNodes } from "../core/link.js";
import { resolveEmbeddingConfig, setEmbeddingLogger } from "../core/embeddings.js";
import { importFile, setMigrateLogger } from "../core/migrate.js";
import { createPerson, findPersonContext, setPersonLogger } from "../core/person.js";
import { handleGraphRequest } from "../ui/graph-handler.js";
import {
  createAfterToolCallHandler,
  createToolResultPersistHandler,
  createAgentEndHandler,
  createLlmOutputHandler,
  createSubagentSpawnedHandler,
  createSubagentEndedHandler,
  createSubagentDeliveryTargetHandler,
  createSessionStartHandler,
  createSessionEndHandler,
  createMessageReceivedHandler,
  createMessageSentHandler,
} from "./hooks.js";
import type { SharedEngineState } from "./hooks.js";
import type {
  QmemoryConfig,
  QmemoryLogger,
  RecallOptions,
} from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Agent system context — appended to system prompt via before_prompt_build
// Static text, cached by the provider (no per-turn token cost).
// Follows Anthropic prompting best practices: clear, direct, XML-structured.
// ---------------------------------------------------------------------------

const AGENT_SYSTEM_CONTEXT = `
<qmemory_graph_database>
You have a persistent graph database (Qmemory) that captures everything across sessions.
At the top of this prompt you'll see injected context from the graph — this is your cross-session awareness.

## What's injected automatically (you don't need to search for these)

- **Session header**: Which channel/topic you're in, memory count, DB health
- **Recent Tool Calls**: Table of tools used this session (survives compaction)
- **Cross-Session Memories**: Facts organized by category, each with an ID like [mem1234]
- **Working Memory**: Current task progress, findings, open questions
- **Knowledge Graph**: Entities and their relationships

## Your graph database tools

<tool name="qmemory_save">
Save a fact, decision, preference, or correction. Auto-deduplicates against existing memories.
Use PROACTIVELY when you learn something new — don't wait to be asked.
- category: "decision" for choices made, "preference" for user likes, "context" for facts, "feedback" for corrections
- salience: 0.8+ for critical rules/decisions, 0.5 for normal facts, 0.3 for minor details
Example: qmemory_save({content: "User prefers Arabic for reports", category: "preference", salience: 0.7})
</tool>

<tool name="qmemory_search">
Search across ALL sessions — memories, tool calls, and messages. Bypasses OpenClaw's session isolation.
OpenClaw blocks sessions_history across sessions. But Qmemory stores all messages in its own graph.
Use include_messages to read what happened in OTHER sessions (groups, topics, crons, DMs).
Examples:
- Find memories: qmemory_search({query: "Railway deployment"})
- Read other sessions: qmemory_search({query: "أسامة", include_messages: true})
- Find tool history: qmemory_search({include_tool_calls: true, tool_name: "exec"})
</tool>

<tool name="qmemory_correct">
Fix, update, or delete a memory using its ID (shown as [mem1234] in the injected context).
Actions: "correct" (new version), "update" (change metadata), "delete" (soft-delete), "unlink" (remove edge)
Example: qmemory_correct({memory_id: "memory:mem1234", action: "correct", new_content: "Budget is 600K not 500K"})
</tool>

<tool name="qmemory_link">
Connect any two things in the graph. The relationship type can be anything that fits.
Example: qmemory_link({from_id: "memory:mem1234", to_id: "entity:ent5678", type: "decided_by", reason: "Ahmed approved this"})
</tool>

<tool name="qmemory_person">
Create or find a person with linked contact identities (WhatsApp, email, Telegram, etc).
Example: qmemory_person({name: "Ahmed", contacts: [{source: "whatsapp", id: "966501234567"}]})
</tool>

## When to use memory tools

- **Save immediately**: decisions, user corrections, important facts, preferences
- **Search when**: you need context from other sessions, someone asks "what did we decide about X?"
- **Correct when**: user says "that's wrong" or "actually it's..."
- **Link when**: you notice two things are related (person→project, decision→outcome)
- **Don't save**: temporary debugging info, one-time commands, things already in the conversation

## Reading the injected context

Each memory line looks like: \`- [mem1234] !Budget approved at 500K [project:rakeezah] (3d ago)\`
- \`[mem1234]\` — ID, use with qmemory_correct/qmemory_link
- \`!\` — high salience (≥0.8), critical rule
- \`[project:rakeezah]\` — scope (only shown for non-global)
- \`(3d ago)\` — when it was created
</qmemory_graph_database>
`;

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

  // 5. SurrealDB connection is handled by bootstrap() in engine.ts
  //    (removed pre-flight IIFE that caused a duplicate connection race condition)

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

  // 7. Shared state — lets hooks access the engine's current session
  const sharedState: SharedEngineState = { currentSessionId: null, lastDeliveryTarget: null, currentModel: null };

  // 8. Register the context engine
  const engine = createEngine(config, logger, subagentRunner, openclawConfig, embeddingConfig, sharedState);
  api.registerContextEngine("qmemory", () => engine);

  logger.info("Context engine registered");

  // 9. Register lifecycle hooks
  try {
    api.on("after_tool_call", createAfterToolCallHandler(logger, sharedState));
    logger.info("Hook registered: after_tool_call");
  } catch (hookErr) {
    logger.error(`Failed to register after_tool_call hook: ${hookErr}`);
  }
  try {
    api.on("tool_result_persist", createToolResultPersistHandler(logger));
    logger.info("Hook registered: tool_result_persist");
  } catch (hookErr) {
    logger.error(`Failed to register tool_result_persist hook: ${hookErr}`);
  }

  // 10. Agent instructions — static prompt appended to system prompt (cached, no per-turn cost)
  try {
    api.on("before_prompt_build", () => ({
      appendSystemContext: AGENT_SYSTEM_CONTEXT,
    }));
    logger.info("Hook registered: before_prompt_build");
  } catch (hookErr) {
    logger.error(`Failed to register before_prompt_build hook: ${hookErr}`);
  }

  // 11. Lifecycle hooks — capture everything into the graph
  const lifecycleHooks: Array<[string, (...args: any[]) => any]> = [
    ["agent_end", createAgentEndHandler(logger, sharedState)],
    ["llm_output", createLlmOutputHandler(logger, sharedState)],
    ["subagent_spawned", createSubagentSpawnedHandler(logger, sharedState)],
    ["subagent_ended", createSubagentEndedHandler(logger, sharedState)],
    ["subagent_delivery_target", createSubagentDeliveryTargetHandler(logger, sharedState)],
    ["session_start", createSessionStartHandler(logger, sharedState)],
    ["session_end", createSessionEndHandler(logger, sharedState)],
    ["message_received", createMessageReceivedHandler(logger)],
    ["message_sent", createMessageSentHandler(logger, sharedState)],
  ];
  for (const [name, handler] of lifecycleHooks) {
    try {
      api.on(name as any, handler);
      logger.info(`Hook registered: ${name}`);
    } catch (hookErr) {
      logger.error(`Failed to register ${name} hook: ${hookErr}`);
    }
  }

  // ----- TOOLS -----

  // Tool 1: qmemory_search — search cross-session memory
  api.registerTool(
    {
      name: "qmemory_search",
      label: "Qmemory Search",
      description:
        "Search cross-session memory AND tool call history. " +
        "Use when you need to recall past knowledge, decisions, or tool usage from any session.\n\n" +
        "RETURNS: Memories (facts, decisions, preferences) + optionally tool calls from all sessions.\n\n" +
        "EXAMPLES:\n" +
        '- Find a person: qmemory_search({query: "John"})\n' +
        '- Find decisions: qmemory_search({categories: ["decision"]})\n' +
        '- Find tool usage: qmemory_search({query: "Railway", include_tool_calls: true})\n' +
        '- Just tool calls: qmemory_search({include_tool_calls: true, tool_name: "exec"})',
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
        include_tool_calls: Type.Optional(
          Type.Boolean({
            description: "Also search the tool_call table across all sessions (default false)",
          }),
        ),
        tool_name: Type.Optional(
          Type.String({
            description: "Filter tool calls by tool name (e.g. 'exec', 'qmemory_save')",
          }),
        ),
        include_messages: Type.Optional(
          Type.Boolean({
            description: "Search messages across ALL sessions — bypasses OpenClaw's session isolation",
          }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        // Search memories
        const memories = await searchMemories(params as RecallOptions);

        // Optionally search tool_call table
        let toolCalls: unknown[] = [];
        if (params.include_tool_calls) {
          const toolNameFilter = params.tool_name
            ? "AND tool_name = $toolName"
            : "";
          const queryFilter = params.query
            ? "AND (input_summary ~ $query OR output_summary ~ $query)"
            : "";

          const tcParams: Record<string, unknown> = {};
          if (params.tool_name) tcParams.toolName = params.tool_name;
          if (params.query) tcParams.query = params.query;
          tcParams.limit = (params.limit as number) ?? 20;

          const results = await query<Record<string, unknown>>(
            `SELECT tool_name, input_summary, output_summary, duration_ms, created_at
             FROM tool_call
             WHERE true ${toolNameFilter} ${queryFilter}
             ORDER BY created_at DESC
             LIMIT $limit`,
            tcParams,
          );
          toolCalls = results ?? [];
        }

        // Optionally search messages across ALL sessions
        let crossSessionMessages: unknown[] = [];
        if (params.include_messages && params.query) {
          const msgResults = await query<Record<string, unknown>>(
            `SELECT role, content, created_at, session FROM message
             WHERE content ~ $query
             ORDER BY created_at DESC
             LIMIT $limit`,
            { query: params.query, limit: (params.limit as number) ?? 10 },
          );
          crossSessionMessages = msgResults ?? [];
        }

        const response: Record<string, unknown> = { memories };
        if (toolCalls.length > 0) response.tool_calls = toolCalls;
        if (crossSessionMessages.length > 0) response.messages = crossSessionMessages;

        return {
          content: [
            { type: "text", text: JSON.stringify(response, null, 2) },
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
        "The system will check for duplicates and update existing memories if needed.\n\n" +
        "WHY: Every session you start from zero. If you learn something important and " +
        "don't save it, it's lost forever. This is how you get smarter over time — " +
        "each session should leave the graph richer than it found it.\n\n" +
        "WHEN TO USE: New person mentioned → save + link. Decision made → save as 'decision'. " +
        "User corrects you → save as 'feedback'. New project info → save as 'context'. " +
        "Lesson learned → save as 'feedback'.\n\n" +
        "WHEN NOT TO USE: Trivial greetings, temporary task status (use scratchpad), " +
        "raw tool outputs (they go to tool_call ledger automatically).\n\n" +
        "RETURNS: {action: 'ADD'|'UPDATE'|'NOOP', memory_id: string}. " +
        "ADD = new memory created. UPDATE = replaced an older version. NOOP = already known.\n\n" +
        "EXAMPLES:\n" +
        '- New person: qmemory_save({content: "Alice — engineering lead at Acme", category: "context", salience: 0.6})\n' +
        '- Decision: qmemory_save({content: "Decided to use SurrealDB instead of SQLite", category: "decision", salience: 0.8, scope: "project:acme"})\n' +
        '- Correction: qmemory_save({content: "User prefers short direct responses", category: "feedback", salience: 0.9})',
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
        "Fix, update, or delete memories and relationships. " +
        "4 actions: 'correct' (fix content, creates version chain), " +
        "'delete' (soft-delete), 'update' (change salience/scope/expiry), " +
        "'unlink' (remove a relationship edge).\n\n" +
        "WHY: Memory must stay accurate. Wrong memories cause wrong decisions in future " +
        "sessions. When a user corrects you, the old fact must be fixed — not duplicated.\n\n" +
        "WHEN TO USE: User says 'that's wrong' → correct. Info expired → update with valid_until. " +
        "Memory is junk → delete. Wrong relationship → unlink.\n\n" +
        "RETURNS: {ok: true} on success.\n\n" +
        "EXAMPLES:\n" +
        '- Fix wrong info: qmemory_correct({memory_id: "memory:xxx", action: "correct", new_content: "الصحيح هو..."})\n' +
        '- Mark expired: qmemory_correct({memory_id: "memory:xxx", action: "update", valid_until: "2026-03-01"})\n' +
        '- Delete junk: qmemory_correct({memory_id: "memory:xxx", action: "delete"})',
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
        "blocks, depends_on, caused_by, or anything that fits.\n\n" +
        "WHY: Isolated facts are weak. Connected facts are intelligence. A person linked " +
        "to a project linked to a decision linked to a topic — that's how you understand " +
        "context instantly in future sessions. No orphan nodes.\n\n" +
        "WHEN TO USE: After EVERY qmemory_save or qmemory_person — link the new node to " +
        "something that already exists. Link people to projects. Link decisions to the " +
        "decisions they replace. Link memories to topic entities.\n\n" +
        "WHEN NOT TO USE: Don't create weak/trivial links just to link. The relationship " +
        "should be meaningful and specific.\n\n" +
        "RETURNS: {edge_id: 'relates:xxx'}\n\n" +
        "EXAMPLES:\n" +
        '- Person → project: qmemory_link({from_id: "entity:p_xxx", to_id: "entity:topic_eduarabia", type: "works_at"})\n' +
        '- Decision chain: qmemory_link({from_id: "memory:new", to_id: "memory:old", type: "supersedes"})\n' +
        '- Memory → topic: qmemory_link({from_id: "memory:xxx", to_id: "entity:topic_sales", type: "belongs_to"})',
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
        "and creates relationships.\n\n" +
        "WHY: Bulk-load knowledge from existing markdown files, meeting notes, or daily logs " +
        "into the graph — faster than saving facts one by one.\n\n" +
        "WHEN TO USE: Migrating old memory files. Importing a document someone shared. " +
        "Loading daily notes that weren't auto-extracted.\n\n" +
        "WHEN NOT TO USE: For single facts (use qmemory_save). For real-time conversation " +
        "extraction (afterTurn handles that automatically).\n\n" +
        "RETURNS: {facts_extracted: number, memories_created: number}\n\n" +
        "EXAMPLE: qmemory_import({file_path: '~/.openclaw/workspace/memory/2026-03-14.md'})",
      parameters: Type.Object({
        file_path: Type.String({
          description: "Absolute path to the markdown file to import",
        }),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
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
        "via 'has_identity'.\n\n" +
        "WHY: People appear across many systems — WhatsApp, email, Smartsheet, calendar. " +
        "This tool unifies them into one entity so you can say 'find everything about Ahmed' " +
        "and get his phone, email, linked memories, and project roles in one query.\n\n" +
        "WHEN TO USE: New person mentioned in conversation → create with aliases. " +
        "Need context about someone → find. Always link the person to their project/topic after creation.\n\n" +
        "WHEN NOT TO USE: For organizations or projects (those are topic entities, not persons). " +
        "For anonymous mentions ('someone said...').\n\n" +
        "RETURNS (create): {person_id, contact_ids, links_created}\n" +
        "RETURNS (find): Person name, aliases, all contacts, and linked memories.\n\n" +
        "EXAMPLES:\n" +
        "- Create: qmemory_person({name: 'Alice', aliases: ['Ali'], contacts: [{source: 'whatsapp', id: '15551234567'}]})\n" +
        "- Find: qmemory_person({name: 'Alice', action: 'find'})",
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

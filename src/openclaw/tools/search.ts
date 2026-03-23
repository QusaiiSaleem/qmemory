/**
 * qmemory_search tool — search cross-session memory
 */

import { Type } from "@sinclair/typebox";
import { query } from "../../db/client.js";
import { searchMemories, enrichWithConnections } from "../../core/search.js";
import type { RecallOptions } from "../../config.js";

export function registerSearchTool(api: any): void {
  api.registerTool(
    {
      name: "qmemory_search",
      label: "Qmemory Search",
      description:
        "Search your brain across ALL sessions — memories, tool calls, and messages. " +
        "Bypasses OpenClaw's session isolation. This is how you remember things from other conversations.\n\n" +
        "WHY: Each session starts fresh. This tool is your recall — use it to remember what happened " +
        "in other sessions, what decisions were made, what the user told you before.\n\n" +
        "WHEN TO USE: You need context from another session, someone asks 'what did we decide?', " +
        "you want to recall self-knowledge (categories: ['self']), or find who said what.\n\n" +
        "WHEN NOT TO USE: For things already in the current conversation.\n\n" +
        "RETURNS: Memories with CONNECTION HINTS (top 5 results show graph edges — linked books, people, other memories). " +
        "When you see connections, FOLLOW THEM to explore the knowledge graph deeper. " +
        "Each hint shows: type, target_name, target_type, reason.\n\n" +
        "EXAMPLES:\n" +
        '- Find memories: qmemory_search({query: "budget MAZJ"})\n' +
        '- Read other sessions: qmemory_search({query: "أسامة", include_messages: true})\n' +
        '- Recall self-knowledge: qmemory_search({categories: ["self"]})\n' +
        '- Find decisions: qmemory_search({categories: ["decision"], scope: "project:mazj"})\n' +
        '- Find tool usage: qmemory_search({include_tool_calls: true, tool_name: "exec"})',
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
        // Search memories + enrich top 5 with graph connection hints
        const rawMemories = await searchMemories(params as RecallOptions);
        const memories = await enrichWithConnections(rawMemories, 5, 3);

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
             WHERE string::contains(content, $query)
             ORDER BY created_at DESC
             LIMIT $limit`,
            { query: params.query, limit: (params.limit as number) ?? 10 },
          );
          crossSessionMessages = msgResults ?? [];
        }

        const response: Record<string, unknown> = { memories };
        if (toolCalls.length > 0) response.tool_calls = toolCalls;
        if (crossSessionMessages.length > 0) response.messages = crossSessionMessages;

        // Count how many results have connections — nudge agent to explore
        const connectedCount = memories.filter(
          (m) => "connections" in m && m.connections?.total
        ).length;
        if (connectedCount > 0) {
          response["💡 explore"] =
            `${connectedCount} result(s) have graph connections. ` +
            `Follow them with qmemory_search({query: "target name"}) to explore deeper, ` +
            `or qmemory_link() to create new connections.`;
        }

        return {
          content: [
            { type: "text", text: JSON.stringify(response, null, 2) },
          ],
        };
      },
    },
    { name: "qmemory_search", optional: false },
  );
}

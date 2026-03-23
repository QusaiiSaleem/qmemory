/**
 * qmemory_link tool — create a relationship between any two things
 */

import { Type } from "@sinclair/typebox";
import { linkNodes } from "../../core/link.js";

export function registerLinkTool(api: any): void {
  api.registerTool(
    {
      name: "qmemory_link",
      label: "Qmemory Link",
      description:
        "Connect any two things in the graph. The relationship type can be anything that fits.\n\n" +
        "WHY: Isolated facts are weak. Connected facts are intelligence. A person linked " +
        "to a project linked to a decision — that's how you understand context. " +
        "Use 'contradicts' to mark conflicting memories (shows ⚠︎ in injected context).\n\n" +
        "WHEN TO USE: After EVERY qmemory_save or qmemory_person — link the new node to " +
        "something that already exists. Link people to projects. Link decisions to the " +
        "decisions they replace. Link 'self' memories to feedback that triggered them.\n\n" +
        "WHEN NOT TO USE: Don't create weak/trivial links just to link. The relationship " +
        "should be meaningful and specific.\n\n" +
        "RETURNS: {edge_id: 'relates:xxx'}\n\n" +
        "EXAMPLES:\n" +
        '- Person → project: qmemory_link({from_id: "entity:p_xxx", to_id: "entity:topic_eduarabia", type: "works_at"})\n' +
        '- Decision chain: qmemory_link({from_id: "memory:new", to_id: "memory:old", type: "supersedes"})\n' +
        '- Self ← feedback: qmemory_link({from_id: "memory:self_xxx", to_id: "memory:feedback_xxx", type: "learned_from"})\n' +
        '- Contradiction: qmemory_link({from_id: "memory:a", to_id: "memory:b", type: "contradicts", reason: "Different budgets"})',
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
}

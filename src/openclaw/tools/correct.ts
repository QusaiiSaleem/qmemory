/**
 * qmemory_correct tool — fix or delete a wrong memory
 */

import { Type } from "@sinclair/typebox";
import { correctMemory } from "../../core/correct.js";

export function registerCorrectTool(api: any): void {
  api.registerTool(
    {
      name: "qmemory_correct",
      label: "Qmemory Correct",
      description:
        "Fix, update, or retire a memory. Use the ID shown in brackets [mem1234].\n" +
        "4 actions: 'correct' (fix content, creates version chain), " +
        "'delete' (soft-delete), 'update' (change salience/scope/expiry/confidence), " +
        "'unlink' (remove a relationship edge).\n\n" +
        "WHY: Memory must stay accurate. Wrong memories cause wrong decisions in future " +
        "sessions. When a user corrects you, the old fact must be fixed — not duplicated.\n\n" +
        "WHEN TO USE: User says 'that's wrong' → correct. Info expired → update with valid_until. " +
        "Memory is junk → delete. Wrong relationship → unlink. Confidence changed → update.\n" +
        "IMPORTANT: When correcting, also save a 'self' memory about what you learned from the mistake.\n\n" +
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
}

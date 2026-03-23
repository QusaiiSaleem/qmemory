/**
 * qmemory_person + qmemory_import tools
 */

import { Type } from "@sinclair/typebox";
import { importFile, setMigrateLogger } from "../../core/migrate.js";
import { createPerson, findPersonContext, setPersonLogger } from "../../core/person.js";
import type { QmemoryLogger } from "../../config.js";
import type { SubagentRunner } from "../index.js";

export function registerPersonTool(
  api: any,
  logger: QmemoryLogger,
): void {
  api.registerTool(
    {
      name: "qmemory_person",
      label: "Qmemory Person",
      description:
        "Create or find a person with linked contact identities (WhatsApp, email, " +
        "Telegram, Smartsheet, etc). Every new person mentioned should become a node.\n\n" +
        "WHY: People appear across many systems. This unifies them into one entity so you can " +
        "find everything about a person — contacts, linked memories, and roles — in one query. " +
        "Person entities are also used as source_person targets in qmemory_save.\n\n" +
        "WHEN TO USE: New person mentioned → create with aliases. " +
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
}

export function registerImportTool(
  api: any,
  logger: QmemoryLogger,
  subagentRunner: SubagentRunner,
): void {
  api.registerTool(
    {
      name: "qmemory_import",
      label: "Qmemory Import",
      description:
        "Import a file into your brain. Reads the file, extracts facts using AI, " +
        "saves with dedup, and creates relationships.\n\n" +
        "WHY: Bulk-load knowledge from existing markdown files, meeting notes, or daily logs " +
        "into the graph — faster than saving facts one by one. Extracted facts include " +
        "evidence_type 'observed' and source attribution when detectable.\n\n" +
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
}

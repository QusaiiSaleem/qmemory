/**
 * qmemory_save tool — save a fact with LLM dedup
 */

import { Type } from "@sinclair/typebox";
import { saveMemory } from "../../core/save.js";
import { searchMemories } from "../../core/search.js";
import type { EmbeddingConfig } from "../../core/embeddings.js";
import type { SubagentRunner } from "../index.js";

export function registerSaveTool(
  api: any,
  subagentRunner: SubagentRunner,
  embeddingConfig?: EmbeddingConfig,
): void {
  api.registerTool(
    {
      name: "qmemory_save",
      label: "Qmemory Save",
      description:
        "Save knowledge to your brain with LLM-driven deduplication. " +
        "The system auto-checks for duplicates and updates existing memories if needed.\n\n" +
        "WHY: Every session you start from zero. If you learn something and don't save it, " +
        "it's lost forever. This is how you build your world model, user model, and self model.\n\n" +
        "WHEN TO USE:\n" +
        "- New fact → category 'context', evidence_type 'observed' or 'reported'\n" +
        "- Decision made → category 'decision', salience 0.8+, source_person = who decided\n" +
        "- User corrects you → category 'feedback' + also save category 'self' (lesson learned)\n" +
        "- Hypothesis/hunch → category 'context', confidence < 0.5, evidence_type 'inferred'\n" +
        "- How to communicate → category 'self', evidence_type 'self'\n" +
        "- User preference → category 'preference'\n\n" +
        "WHEN NOT TO USE: Trivial greetings, temporary task status (use scratchpad), " +
        "raw tool outputs (they go to tool_call ledger automatically).\n\n" +
        "EVIDENCE FIELDS: Include source_person when someone specific said it. " +
        "Include confidence when uncertain. Include evidence_type to track how you learned it.\n\n" +
        "RETURNS: {action: 'ADD'|'UPDATE'|'NOOP', memory_id: string}.\n\n" +
        "EXAMPLES:\n" +
        '- Decision: qmemory_save({content: "Budget approved at 500K", category: "decision", salience: 0.8, source_person: "Qusai", evidence_type: "reported", confidence: 0.9})\n' +
        '- Self-knowledge: qmemory_save({content: "User wants shorter responses", category: "self", salience: 0.8, evidence_type: "self"})\n' +
        '- Hypothesis: qmemory_save({content: "Osama might disagree with direction", category: "context", salience: 0.5, evidence_type: "inferred", confidence: 0.35})',
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
        source_person: Type.Optional(Type.String({
          description: "Who said/reported this? Person name (resolved to entity automatically)",
        })),
        evidence_type: Type.Optional(Type.String({
          description: '"observed" (saw it), "reported" (told), "inferred" (concluded), "self" (introspection)',
        })),
        confidence: Type.Optional(Type.Number({
          description: "How certain? 0.0-1.0. Use < 0.5 for hypotheses.",
          minimum: 0, maximum: 1,
        })),
        context_mood: Type.Optional(Type.String({
          description: "Situation: calm_decision, heated_discussion, brainstorm, correction, casual, urgent",
        })),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const result = await saveMemory(
          {
            content: params.content as string,
            category: params.category as import("../../config.js").MemoryCategory,
            salience: (params.salience as number) ?? 0.5,
            scope: (params.scope as string) ?? "global",
            source_person: params.source_person as string | undefined,
            evidence_type: params.evidence_type as string | undefined,
            confidence: params.confidence as number | undefined,
            context_mood: params.context_mood as string | undefined,
          },
          subagentRunner,
          embeddingConfig,
        );

        // Post-save: find nearby memories to nudge agent toward linking
        const response: Record<string, unknown> = { ...result };
        if (result.action === "ADD" && result.memory_id) {
          try {
            // Quick BM25 search for nearby content (reuse first 50 chars as query)
            const snippet = (params.content as string).slice(0, 80);
            const nearby = await searchMemories({
              query: snippet,
              limit: 3,
              min_salience: 0.0,
            });
            // Filter out the just-saved memory itself
            const savedId = String(result.memory_id);
            const others = nearby.filter((m) => String(m.id) !== savedId).slice(0, 2);
            if (others.length > 0) {
              response.nearby = others.map((m) => ({
                id: String(m.id),
                content: String(m.content).slice(0, 100),
                category: m.category,
              }));
              response["💡 connect"] =
                `Found ${others.length} related memory(s). Consider: ` +
                `qmemory_link({from_id: "${savedId}", to_id: "${String(others[0].id)}", type: "relates_to"})`;
            }
          } catch {
            // Non-fatal — don't block save on nearby search failure
          }
        }

        return {
          content: [
            { type: "text", text: JSON.stringify(response, null, 2) },
          ],
        };
      },
    },
    { name: "qmemory_save", optional: false },
  );
}

/**
 * Qmemory MCP Server
 *
 * FastMCP server that exposes Qmemory tools for Claude Code,
 * Claude.ai, and any MCP-compatible client.
 *
 * 4 tools that wrap the shared core functions:
 *   - qmemory_search  → search cross-session memory
 *   - qmemory_save    → save a fact with dedup pipeline
 *   - qmemory_correct → fix or delete a wrong memory
 *   - qmemory_link    → create a relationship between any two nodes
 *
 * All tools delegate to core/ functions — no inline SurrealQL here.
 * Transport: stdio (Claude Code) or httpStream (Claude.ai)
 */

import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";

// Core functions (shared logic — same code as OpenClaw entry)
import { searchMemories } from "../core/search.js";
import { saveMemory } from "../core/save.js";
import { correctMemory } from "../core/correct.js";
import { linkNodes } from "../core/link.js";
import type { MemoryCategory } from "../config.js";

// ---------------------------------------------------------------------------
// Create the MCP server instance
// ---------------------------------------------------------------------------

const server = new FastMCP({
  name: "Qmemory",
  version: "0.1.0",
  instructions:
    "Graph memory for AI agents. Save facts, search across sessions, create relationships between knowledge.",
});

// ---------------------------------------------------------------------------
// Tool 1: qmemory_search
// ---------------------------------------------------------------------------

server.addTool({
  name: "qmemory_search",
  description:
    "Search cross-session memory by meaning, category, or scope. Returns memories from ALL past conversations.",
  parameters: z.object({
    query: z.string().optional().describe("Search by meaning (full-text)"),
    categories: z
      .array(z.string())
      .optional()
      .describe(
        "Filter: style, preference, context, decision, idea, feedback, domain",
      ),
    scope: z
      .string()
      .optional()
      .describe("Filter: global, project:xxx, topic:xxx"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default 10)"),
  }),
  execute: async (args) => {
    const results = await searchMemories({
      query: args.query,
      categories: args.categories as MemoryCategory[] | undefined,
      scope: args.scope,
      limit: args.limit ?? 10,
    });

    if (results.length === 0) return "No memories found.";

    // Format: [id] [category, salience:X] content
    return results
      .map(
        (m) =>
          `[${m.id}] [${m.category}, salience:${m.salience}] ${m.content}`,
      )
      .join("\n");
  },
});

// ---------------------------------------------------------------------------
// Tool 2: qmemory_save
// ---------------------------------------------------------------------------

server.addTool({
  name: "qmemory_save",
  description:
    "Save a fact to cross-session memory. Runs dedup automatically (ADD/UPDATE/NOOP).",
  parameters: z.object({
    content: z.string().describe("The fact to remember (one clear statement)"),
    category: z
      .enum([
        "style",
        "preference",
        "context",
        "decision",
        "idea",
        "feedback",
        "domain",
      ])
      .describe("Memory category"),
    salience: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Importance 0.0-1.0 (default 0.5)"),
    scope: z
      .string()
      .optional()
      .describe("Scope: global, project:xxx, topic:xxx (default global)"),
  }),
  execute: async (args) => {
    // Delegate to core save function (includes rule-based dedup)
    // Note: no subagentRunner in MCP mode — uses rule-based fallback
    const result = await saveMemory({
      content: args.content,
      category: args.category,
      salience: args.salience,
      scope: args.scope,
    });

    if (result.action === "NOOP") {
      return `Already known — existing memory: ${result.memory_id}`;
    }

    return `${result.action}: ${result.memory_id} [${args.category}, salience:${args.salience ?? 0.5}]`;
  },
});

// ---------------------------------------------------------------------------
// Tool 3: qmemory_correct
// ---------------------------------------------------------------------------

server.addTool({
  name: "qmemory_correct",
  description:
    "Fix or delete a wrong memory. Use 'correct' to update content, 'delete' to soft-delete.",
  parameters: z.object({
    action: z
      .enum(["correct", "delete"])
      .describe("'correct' to update content, 'delete' to soft-delete"),
    memory_id: z
      .string()
      .describe("The memory ID to correct or delete (e.g. memory:mem1234abcd)"),
    new_content: z
      .string()
      .optional()
      .describe("New content (required when action is 'correct')"),
  }),
  execute: async (args) => {
    // Validate: correct requires new_content
    if (args.action === "correct" && !args.new_content) {
      throw new UserError("new_content is required when action is 'correct'.");
    }

    // Delegate to core correct function
    const result = await correctMemory({
      memory_id: args.memory_id,
      action: args.action,
      new_content: args.new_content,
    });

    if (!result.ok) {
      throw new UserError(
        `Failed to ${args.action} memory ${args.memory_id} — not found or already inactive.`,
      );
    }

    if (args.action === "delete") {
      return `Deleted (soft) ${args.memory_id}`;
    }

    return `Corrected: ${args.memory_id} → ${result.new_memory_id}`;
  },
});

// ---------------------------------------------------------------------------
// Tool 4: qmemory_link
// ---------------------------------------------------------------------------

server.addTool({
  name: "qmemory_link",
  description:
    "Create a relationship between any two things in memory. Type can be ANY relationship: supports, contradicts, manages, blocks, depends_on, caused_by — whatever fits.",
  parameters: z.object({
    from_id: z
      .string()
      .describe("Source node ID (e.g. memory:mem123, entity:ent456)"),
    to_id: z
      .string()
      .describe("Target node ID (e.g. memory:mem789, entity:ent012)"),
    type: z
      .string()
      .describe(
        "Relationship type — any string: supports, contradicts, blocks, depends_on, etc.",
      ),
    reason: z
      .string()
      .optional()
      .describe("Why this relationship exists"),
  }),
  execute: async (args) => {
    try {
      // Delegate to core link function (validates both nodes exist)
      const result = await linkNodes({
        from_id: args.from_id,
        to_id: args.to_id,
        type: args.type,
        reason: args.reason,
        created_by: "agent",
      });

      return `Linked: ${args.from_id} —[${args.type}]→ ${args.to_id} (${result.edge_id})`;
    } catch (error) {
      // linkNodes throws if a node doesn't exist
      throw new UserError(
        error instanceof Error ? error.message : "Failed to create link.",
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Default export (imported by cli.ts)
// ---------------------------------------------------------------------------

export default server;

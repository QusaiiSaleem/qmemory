/**
 * Graph Visualization HTTP Handler
 *
 * Serves the interactive graph viewer and its API endpoint.
 * Designed to work both as an OpenClaw HTTP route and standalone.
 *
 * Routes:
 *   GET /qmemory/graph        → Serve graph.html (the visualization page)
 *   GET /qmemory/api/graph    → Return JSON: { nodes: [...], edges: [...] }
 *
 * Query parameters for /qmemory/api/graph:
 *   category  — Filter memories by category
 *   scope     — Filter by scope (global, project:xxx, topic:xxx)
 *   from      — Filter by created_at >= date (ISO string)
 *   to        — Filter by created_at <= date (ISO string)
 */

import { readFileSync } from "fs";
import { query } from "../db/client.js";
import type { Memory, Entity, Session, Relates } from "../config.js";

// ---------------------------------------------------------------------------
// Cache the HTML file (read once at startup)
// ---------------------------------------------------------------------------

let graphHtml: string | null = null;

function getGraphHtml(): string {
  if (!graphHtml) {
    const htmlPath = new URL("./graph.html", import.meta.url);
    graphHtml = readFileSync(htmlPath, "utf-8");
  }
  return graphHtml;
}

// ---------------------------------------------------------------------------
// Node/Edge types for the API response
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  type: "memory" | "entity" | "session";
  label: string;
  // Memory-specific fields
  content?: string;
  category?: string;
  salience?: number;
  scope?: string;
  source_type?: string;
  created_at?: string;
  // Entity-specific fields
  entity_type?: string;
  aliases?: string[];
  // Session-specific fields
  channel?: string;
  chat_type?: string;
  last_active?: string;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  reason?: string;
  confidence?: number;
  created_by?: string;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// API: build graph data from SurrealDB
// ---------------------------------------------------------------------------

export async function buildGraphData(filters: {
  category?: string;
  scope?: string;
  from?: string;
  to?: string;
}): Promise<GraphResponse> {
  // Build WHERE clauses for memories
  const conditions: string[] = ["is_active = true"];
  const params: Record<string, unknown> = {};

  if (filters.category) {
    conditions.push("category = $category");
    params.category = filters.category;
  }
  if (filters.scope) {
    conditions.push("scope = $scope");
    params.scope = filters.scope;
  }
  if (filters.from) {
    conditions.push("created_at >= type::datetime($fromDate)");
    params.fromDate = filters.from;
  }
  if (filters.to) {
    conditions.push("created_at <= type::datetime($toDate)");
    params.toDate = filters.to;
  }

  const whereClause = conditions.join(" AND ");

  // Fetch memories, entities, sessions, and edges in parallel
  const [memories, entities, sessions, edges] = await Promise.all([
    query<Memory>(
      `SELECT * FROM memory WHERE ${whereClause} ORDER BY salience DESC LIMIT 200;`,
      params,
    ),
    query<Entity>("SELECT * FROM entity ORDER BY created_at DESC LIMIT 100;"),
    query<Session>("SELECT * FROM session ORDER BY last_active DESC LIMIT 50;"),
    query<Relates>("SELECT * FROM relates ORDER BY created_at DESC LIMIT 500;"),
  ]);

  // Transform to graph nodes
  const nodes: GraphNode[] = [];

  for (const m of memories ?? []) {
    nodes.push({
      id: String(m.id),
      type: "memory",
      label: m.content.length > 40 ? m.content.slice(0, 40) + "..." : m.content,
      content: m.content,
      category: m.category,
      salience: m.salience,
      scope: m.scope,
      source_type: m.source_type,
      created_at: m.created_at,
    });
  }

  for (const e of entities ?? []) {
    nodes.push({
      id: String(e.id),
      type: "entity",
      label: e.name,
      entity_type: e.type,
      aliases: e.aliases,
      created_at: e.created_at,
    });
  }

  for (const s of sessions ?? []) {
    nodes.push({
      id: String(s.id),
      type: "session",
      label: s.session_key,
      channel: s.channel,
      chat_type: s.chat_type,
      scope: s.scope,
      last_active: s.last_active,
      created_at: s.created_at,
    });
  }

  // Transform edges — only include edges whose both endpoints exist in nodes
  const nodeIds = new Set(nodes.map((n) => n.id));
  const graphEdges: GraphEdge[] = [];

  for (const rel of edges ?? []) {
    const fromId = String(rel.in);
    const toId = String(rel.out);
    if (nodeIds.has(fromId) && nodeIds.has(toId)) {
      graphEdges.push({
        id: String(rel.id),
        from: fromId,
        to: toId,
        type: rel.type,
        reason: rel.reason,
        confidence: rel.confidence,
        created_by: rel.created_by,
      });
    }
  }

  return { nodes, edges: graphEdges };
}

// ---------------------------------------------------------------------------
// HTTP handler (works with Node http.IncomingMessage / http.ServerResponse)
// ---------------------------------------------------------------------------

/**
 * Handle an HTTP request for the graph routes.
 * Returns true if the request was handled, false otherwise.
 *
 * This is designed to be called from OpenClaw's route handler
 * or from a standalone Express/Hono/Node HTTP server.
 */
export async function handleGraphRequest(
  url: URL,
  respond: (status: number, headers: Record<string, string>, body: string) => void,
): Promise<boolean> {
  const path = url.pathname;

  // GET /qmemory/graph → serve the HTML page
  if (path === "/qmemory/graph" || path === "/qmemory/graph/") {
    respond(200, { "Content-Type": "text/html; charset=utf-8" }, getGraphHtml());
    return true;
  }

  // GET /qmemory/api/graph → return graph JSON
  if (path === "/qmemory/api/graph" || path === "/qmemory/graph/api/graph") {
    const filters = {
      category: url.searchParams.get("category") || undefined,
      scope: url.searchParams.get("scope") || undefined,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
    };

    const data = await buildGraphData(filters);
    respond(
      200,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      JSON.stringify(data),
    );
    return true;
  }

  return false;
}

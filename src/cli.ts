#!/usr/bin/env node
/**
 * Qmemory CLI Entry Point
 *
 * Usage:
 *   qmemory              → Start MCP server (stdio transport, for Claude Code)
 *   qmemory serve         → Same as above
 *   qmemory serve-http    → Start MCP server (HTTP transport, for Claude.ai)
 *   qmemory serve-http 4000 → HTTP on custom port
 *   qmemory status        → Check SurrealDB connection + memory stats
 *   qmemory schema        → Apply the SurrealDB schema from qmemory.surql
 */

import { readFileSync } from "fs";
import { connect, isHealthy, disconnect, applySchema, query } from "./db/client.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { QmemoryConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Load config: start from defaults, override with environment variables
// ---------------------------------------------------------------------------

const config: QmemoryConfig = { ...DEFAULT_CONFIG };
if (process.env.QMEMORY_SURREALDB_URL) config.surrealdb_url = process.env.QMEMORY_SURREALDB_URL;
if (process.env.QMEMORY_SURREALDB_USER) config.surrealdb_user = process.env.QMEMORY_SURREALDB_USER;
if (process.env.QMEMORY_SURREALDB_PASS) config.surrealdb_pass = process.env.QMEMORY_SURREALDB_PASS;
if (process.env.QMEMORY_NAMESPACE) config.namespace = process.env.QMEMORY_NAMESPACE;
if (process.env.QMEMORY_DATABASE) config.database = process.env.QMEMORY_DATABASE;
if (process.env.QMEMORY_EMBEDDING_PROVIDER) {
  config.embedding_provider = process.env.QMEMORY_EMBEDDING_PROVIDER as "voyage" | "openai" | "none";
}
if (process.env.QMEMORY_EMBEDDING_API_KEY) config.embedding_api_key = process.env.QMEMORY_EMBEDDING_API_KEY;
if (process.env.QMEMORY_DEBUG === "true") config.debug = true;

// ---------------------------------------------------------------------------
// Parse command
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0] || "serve";

switch (command) {
  // -------------------------------------------------------------------------
  // serve (stdio) — default, for Claude Code
  // -------------------------------------------------------------------------
  case "serve": {
    await connect(config);
    const { default: server } = await import("./mcp/server.js");
    server.start({ transportType: "stdio" });
    break;
  }

  // -------------------------------------------------------------------------
  // serve-http — for Claude.ai and remote MCP clients
  // -------------------------------------------------------------------------
  case "serve-http": {
    const port = parseInt(args[1] || "3777", 10);
    await connect(config);
    const { default: httpServer } = await import("./mcp/server.js");
    httpServer.start({
      transportType: "httpStream",
      httpStream: { port },
    });
    console.log(`Qmemory MCP server running on http://localhost:${port}/mcp`);
    break;
  }

  // -------------------------------------------------------------------------
  // status — check connection + show stats
  // -------------------------------------------------------------------------
  case "status": {
    await connect(config);
    const healthy = await isHealthy();

    if (!healthy) {
      console.log("Qmemory: disconnected (SurrealDB unreachable)");
      process.exit(1);
    }

    // Query counts for each table
    const memories = await query<{ count: number }>("SELECT count() AS count FROM memory GROUP ALL;");
    const entities = await query<{ count: number }>("SELECT count() AS count FROM entity GROUP ALL;");
    const edges = await query<{ count: number }>("SELECT count() AS count FROM relates GROUP ALL;");
    const sessions = await query<{ count: number }>("SELECT count() AS count FROM session GROUP ALL;");

    const memCount = memories?.[0]?.count ?? 0;
    const entCount = entities?.[0]?.count ?? 0;
    const edgeCount = edges?.[0]?.count ?? 0;
    const sesCount = sessions?.[0]?.count ?? 0;

    console.log("Qmemory: connected");
    console.log(`  SurrealDB:  ${config.surrealdb_url}`);
    console.log(`  Namespace:  ${config.namespace}/${config.database}`);
    console.log(`  Memories:   ${memCount}`);
    console.log(`  Entities:   ${entCount}`);
    console.log(`  Edges:      ${edgeCount}`);
    console.log(`  Sessions:   ${sesCount}`);

    await disconnect();
    break;
  }

  // -------------------------------------------------------------------------
  // schema — apply the SurrealDB schema
  // -------------------------------------------------------------------------
  case "schema": {
    await connect(config);
    const schemaPath = new URL("../schema/qmemory.surql", import.meta.url);
    const schema = readFileSync(schemaPath, "utf-8");
    const success = await applySchema(schema);
    if (success) {
      console.log("Schema applied successfully.");
    } else {
      console.error("Failed to apply schema.");
      process.exit(1);
    }
    await disconnect();
    break;
  }

  // -------------------------------------------------------------------------
  // Unknown command — show usage
  // -------------------------------------------------------------------------
  default: {
    console.log("Qmemory — Graph memory for AI agents\n");
    console.log("Usage: qmemory [command]\n");
    console.log("Commands:");
    console.log("  serve              Start MCP server (stdio, for Claude Code)");
    console.log("  serve-http [port]  Start MCP server (HTTP, for Claude.ai, default port 3777)");
    console.log("  status             Check SurrealDB connection and show stats");
    console.log("  schema             Apply the SurrealDB schema");
    console.log("\nEnvironment variables:");
    console.log("  QMEMORY_SURREALDB_URL   SurrealDB URL (default: ws://localhost:8000)");
    console.log("  QMEMORY_SURREALDB_USER  SurrealDB user (default: root)");
    console.log("  QMEMORY_SURREALDB_PASS  SurrealDB password (default: root)");
    console.log("  QMEMORY_NAMESPACE       Namespace (default: qmemory)");
    console.log("  QMEMORY_DATABASE        Database (default: main)");
    console.log("  QMEMORY_DEBUG           Debug mode (default: false)");
  }
}

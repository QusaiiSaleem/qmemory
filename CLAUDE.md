# Qmemory

Graph memory context engine for OpenClaw (replaces LCM) + MCP server for Claude Code/Claude.ai. Powered by SurrealDB.

## Quick Start

```bash
npm install                                    # Install dependencies
npm run build                                  # Compile TypeScript → dist/
surreal start --user root --pass root file:~/.qmemory/data.db  # Start SurrealDB
npx tsx src/cli.ts schema                      # Apply database schema
npx tsx src/cli.ts status                      # Verify connection
```

## Development

```bash
# MCP server (for testing with Claude Code)
npx tsx src/cli.ts serve                       # stdio transport
npx tsx src/cli.ts serve-http 3777             # HTTP transport (Claude.ai)
npx fastmcp dev src/mcp/server.ts              # Interactive MCP inspector

# OpenClaw plugin (symlink dev mode)
openclaw plugins install -l /path/to/Qmemory
openclaw config set plugins.slots.contextEngine "qmemory"
openclaw config set tools.alsoAllow '["group:plugins"]'
openclaw gateway restart
openclaw plugins list | grep qmemory           # Verify loaded

# After code changes:
npm run build && pkill -f openclaw && sleep 2 && openclaw gateway start

# Clear jiti cache if gateway doesn't pick up new code:
rm -rf /var/folders/*/T/jiti && pkill -9 -f openclaw && openclaw gateway start

# Release (auto-publishes to npm via GitHub Actions):
npm version patch  # or minor/major
git push origin main
gh release create v$(node -p "require('./package.json').version") --generate-notes

# Debugging
openclaw logs --follow | grep qmemory          # Plugin logs
surreal sql -e http://localhost:8000 -u root -p root --namespace qmemory --database main
```

## Architecture

```
src/
├── core/           ← SHARED logic (recall, save, search, correct, link, extract, dedup, embeddings, migrate)
├── db/             ← SurrealDB connection + parameterized queries
├── openclaw/       ← ENTRY 1: Context engine plugin (replaces LCM) + 6 tools + linker service
├── mcp/            ← ENTRY 2: FastMCP server (4 tools for Claude Code/Claude.ai)
├── cli.ts          ← ENTRY 3: CLI (npx qmemory serve|serve-http|status|schema)
├── config.ts       ← All types, constants, formatMemories()
└── ui/             ← Graph viewer (vis.js, served at /qmemory/graph)
```

**Three entry points, one core.** OpenClaw plugin, MCP server, and CLI all call the same `core/` functions.

## Graph Schema (SurrealDB)

4 nodes: `session`, `message`, `memory`, `entity`
3 structural edges: `has_message`, `extracted_from`, `prev_version` (auto-created)
1 dynamic edge: `relates` (agent creates ANY relationship type)

Schema file: `schema/qmemory.surql`

## Key Patterns

- **All queries parameterized** — never string-interpolate SurrealQL (`$param` or `surql` template tag)
- **Graceful degradation** — if SurrealDB is down, `query()` returns `null`, functions return empty arrays
- **Soft-delete only** — `is_active = false`, never hard-delete. `prev_version` edge for audit trail
- **IDs use timestamps** — `generateId("mem")` → `mem1710864000000abc` (no dashes — SurrealDB safe)
- **LLM via subagents** — `api.runtime.subagent.run()` inside OpenClaw, no extra API keys
- **Embeddings via OpenClaw config** — `resolveEmbeddingConfig()` reads existing Voyage/OpenAI key from `api.config`
- **Token budget** — memory injection capped at 15% of context window, sorted by salience DESC
- **Session key parsing** — `parseSessionKey()` in `engine.ts` extracts topic/group/channel automatically

## OpenClaw Plugin Tools (6 tools)

| Tool | What It Does |
|------|-------------|
| `qmemory_search` | 4-tier recall: graph traversal → BM25 → vector → recent |
| `qmemory_save` | Save fact with LLM dedup (ADD/UPDATE/NOOP) |
| `qmemory_correct` | Fix or soft-delete a memory (version chain preserved) |
| `qmemory_link` | Create dynamic `relates` edge (any relationship type) |
| `qmemory_import` | Import a .md file into the graph (for migration) |
| `qmemory_person` | Create/find a person with linked identities across systems |

## Context Engine Methods

| Method | What It Does |
|--------|-------------|
| `bootstrap()` | Connect SurrealDB, apply schema, parse session key, create/load session |
| `ingest()` | Store message as node + `has_message` edge |
| `assemble()` | Return messages + inject cross-session memories as `systemPromptAddition` |
| `compact()` | Extract memories from old messages → graph nodes (not throwaway summaries) |
| `afterTurn()` | Pre-compaction flush at 70% + background fact extraction |

## Graph Viewer UI

Interactive visualization of the memory graph at `http://localhost:<gateway-port>/qmemory/graph`.
Shows all memories (nodes), entities, sessions, and relationship edges (relates).
API endpoint at `/qmemory/api/graph` returns JSON (`{ nodes, edges }`), supports filters: `?category=&scope=&from=&to=`.
Auth: `plugin` mode (no token needed on localhost).

## Background Services

- **Linker** (every 5 min): finds unlinked memories, asks subagent for relationships, creates `relates` edges
- **Reflect** (every 30 min): synthesizes insights across memories, resolves contradictions

## Memory Fields

| Field | Why |
|-------|-----|
| `salience` (0-1) | Importance weight — critical facts always recalled first |
| `valid_from/until` | Temporal validity — expired facts filtered out |
| `scope` | Visibility: `global`, `project:xxx`, `topic:xxx` |
| `confidence` | LLM confidence in the fact |

## Entity External References

Entities can reference external systems (email, tasks, Smartsheet):
- `external_source`: "hey", "apple-reminders", "smartsheet", "railway"
- `external_id`: reference ID in the source system
- `external_url`: direct URL to the resource

## Gotchas

- **Jiti caches compiled plugins** — if gateway doesn't pick up code changes after rebuild, clear `/var/folders/*/T/jiti` and restart
- **SurrealDB 3.0: NULL vs NONE** — optional fields (`option<string>`) reject `NULL` from JS SDK. Omit the field entirely instead of passing `null`/`undefined`
- **SurrealDB 3.0: `type::record()` not `type::thing()`** — `type::thing()` was removed in v3. Use `type::record("table", $id)` for parameterized record IDs
- **SurrealDB 3.0: `search::score()` returns 0** — BM25 matching via `@@` works but scoring is broken. Vector search (cosine) handles relevance ranking
- **Subagent API (OpenClaw)** — `api.runtime.subagent.run()` requires `{ sessionKey, message, idempotencyKey }`, returns `{ runId }`. Must then `waitForRun()` + `getSessionMessages()` + `deleteSession()`. The wrapper in `createSubagentRunner()` handles this
- **`tools.alsoAllow: ["group:plugins"]` MUST be in openclaw.json** — the `coding` profile filters out ALL plugin tools via `applyToolPolicyPipeline`. Without this, tools register silently but the agent never sees them
- **AgentTool interface requires `label` field** on every tool (e.g., `label: "Qmemory Search"`)
- **`openclaw plugins inspect` does not exist** — use `openclaw plugins list` instead
- SurrealDB must be running BEFORE OpenClaw gateway starts (or Qmemory runs in degraded mode)
- Schema is applied on every `bootstrap()` — safe (idempotent) but logs on first run
- `relates` edge accepts ANY node type as IN/OUT — validate both exist before creating
- OpenClaw passes `sessionKey` but may not pass `topicId` separately — use `parseSessionKey()`
- Embedding index must be enabled explicitly via `enableVectorIndex()` when embedding provider is set
- FastMCP uses Zod for schemas, OpenClaw uses TypeBox — core/ functions accept plain objects (framework-agnostic)
- The `qmemory_import` tool uses dynamic import to avoid loading `migrate.ts` unless needed
- OpenClaw logs: `/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log` (JSON format, grep `"1":"message"`)
- OpenClaw source: `/opt/homebrew/lib/node_modules/openclaw/dist/` for debugging internals

## Config

Plugin config in `openclaw.plugin.json`. Key settings:
- `context_threshold: 0.75` — compact at 75% context window
- `fresh_tail_count: 32` — protect recent messages from compaction
- `memory_budget_pct: 0.15` — max 15% of context for memory injection
- `embedding_provider: "auto"` — reads from OpenClaw's existing config
- `linker_interval_ms: 300000` — linker runs every 5 minutes
- `reflect_interval_ms: 1800000` — reflect runs every 30 minutes

## Dependencies

Only 3 runtime deps: `surrealdb` (official JS SDK) + `fastmcp` (MCP server framework) + `@sinclair/typebox` (OpenClaw tool schemas)

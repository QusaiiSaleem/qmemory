# Community Plugin Submission (v2)

## Plugin Entry (add to community plugins page)

```markdown
### Qmemory

Graph database infrastructure for agent awareness, powered by SurrealDB.
Implements the `ContextEngine` interface to give agents persistent,
cross-session intelligence — every fact, tool call, cron outcome, and
entity relationship is captured in a connected graph that the agent can
search and traverse across sessions, channels, and time.

- **npm:** `qmemory`
- **repo:** [github.com/QusaiiSaleem/qmemory](https://github.com/QusaiiSaleem/qmemory)
- **kind:** `context-engine`

```bash
openclaw plugins install qmemory
cd ~/.openclaw/extensions/qmemory && npm install --omit=dev
openclaw config set plugins.slots.contextEngine "qmemory"
openclaw config set tools.alsoAllow '["group:plugins"]'
```
```

## PR Title

Add Qmemory — graph context engine plugin (SurrealDB)

## PR Body

### Plugin Info

- **Name**: Qmemory
- **npm**: `qmemory` (v0.1.9)
- **GitHub**: https://github.com/QusaiiSaleem/qmemory
- **Install**: `openclaw plugins install qmemory`
- **License**: MIT
- **Kind**: `context-engine`
- **Dependencies**: `surrealdb` + `fastmcp` + `@sinclair/typebox`

### Why a context engine (not a memory plugin)

Qmemory implements the full `ContextEngine` interface because it needs to own the session lifecycle:

- **`bootstrap()`** — connect to SurrealDB, create/load session node, apply schema
- **`ingest()`** — store each message as a graph node with `has_message` edge
- **`assemble()`** — inject cross-session memories, tool ledger, scratchpad, and graph map into `systemPromptAddition`
- **`compact()`** — extract facts from old messages into the graph (compaction = memory creation), re-inject critical memories to prevent post-compaction amnesia
- **`afterTurn()`** — 4-stage graduated compaction (50%/70%/85%/95%), background fact extraction, scratchpad update
- **`prepareSubagentSpawn()`** — share relevant memories with child sessions
- **`ownsCompaction: true`** — disables OpenClaw's built-in compaction

A memory plugin (tool-only) can't do this — it has no access to session lifecycle, compaction, or context injection.

### What it captures (12 OpenClaw hooks)

| Hook | What it captures |
|------|-----------------|
| `after_tool_call` | Every tool call → `tool_call` table (survives compaction) |
| `tool_result_persist` | Compress large tool results before storage |
| `before_prompt_build` | Agent instructions via `appendSystemContext` (cached) |
| `agent_end` | Cron/heartbeat outcomes → memory (with delivery target) |
| `llm_output` | Token usage + model name → metrics |
| `subagent_spawned` | Parent→child session graph edge |
| `subagent_ended` | Child outcome, failures saved as memories |
| `subagent_delivery_target` | Where cron/subagent output is routed |
| `session_start` | Session lifecycle, "resumed from" awareness |
| `session_end` | Duration + message count |
| `message_received` | Sender identity → entity table |
| `message_sent` | Delivery target + failure tracking |

### What the agent sees (context injection)

Every turn, `assemble()` injects into `systemPromptAddition`:

1. **Session header** — channel, topic, scope, model name, memory count
2. **Tool call ledger** — recent tool calls (table format, survives compaction)
3. **Cross-session memories** — grouped by category, with IDs + scope + age
4. **Working memory** — scratchpad (task progress, findings, questions)
5. **Knowledge graph** — entities + relationships map

Plus `appendSystemContext` (cached, zero per-turn cost):
- How to use qmemory tools (with examples)
- How to read the injected context (IDs, scope tags, age)

### Graph schema (SurrealDB)

- 4 nodes: `session`, `message`, `memory`, `entity`
- 3 operational tables: `tool_call`, `scratchpad`, `metrics`
- 5 edge types: `has_message`, `prev_version`, `relates` (dynamic), `spawned`, `has_identity`
- Background services: Linker (5 min), Salience Decay (5 min), Reflect (30 min)

### Key design decisions

- **Parameterized queries only** — never string-interpolate SurrealQL
- **Graceful degradation** — if SurrealDB is down, all functions return empty (no crash)
- **Soft-delete only** — `is_active = false`, never hard-delete. Version chains via `prev_version`
- **Fire-and-forget hooks** — hooks never block the agent loop
- **Token budget** — memory injection capped at 15% of context window
- **`type::record("table", $id)` pattern** — SurrealDB JS SDK returns RecordId objects, not strings

### Also works standalone

Qmemory also runs as an MCP server for Claude Code (stdio) and Claude.ai (HTTP), independent of OpenClaw.

### Requirements

- SurrealDB 3.0+ (local)
- Node.js 22+

### Checklist

- [x] Published on npm (`qmemory`)
- [x] Source code on public GitHub
- [x] README with setup/usage docs
- [x] SKILL.md for agent integration
- [x] CLAUDE.md with developer reference
- [x] Issue tracker enabled
- [x] MIT licensed
- [x] Verified against current OpenClaw context-engine API
- [x] No "replaces LCM" framing

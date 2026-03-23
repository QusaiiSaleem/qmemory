# Qmemory

**Graph database infrastructure for AI agent awareness.** Captures everything that happens in OpenClaw — sessions, messages, tool calls, cron runs, subagent results, decisions, entities — as a connected graph in SurrealDB. The agent can traverse relationships to understand context across sessions, channels, and time.

**Core principle:** If it happened in OpenClaw, it should be in the graph. If it's in the graph, the agent should be able to find it. Every node is connected. Nothing is orphaned.

## Architecture Vision

Qmemory is NOT just a memory system — it's the agent's **situational awareness layer**. The graph captures:

```
┌─────────────────────────────────────────────────────────────────┐
│                    QMEMORY GRAPH                                │
│                                                                 │
│  session ──has_message──→ message                               │
│  session ──spawned──→ session (cron child, subagent child)      │
│  session ──has_run──→ background_run (cron/subagent outcomes)   │
│  message ←──extracted_from── memory                             │
│  memory ──relates──→ memory / entity (any relationship type)    │
│  entity ──relates──→ entity / memory                            │
│  tool_call → linked to session (operational log)                │
│  scratchpad → linked to session (working memory)                │
│  metrics → linked to session (tracking)                         │
│                                                                 │
│  The agent sees: self-model + session header + memories          │
│  (with evidence markers) + hypotheses + tool ledger             │
│  + scratchpad + graph map — injected via assemble()             │
└─────────────────────────────────────────────────────────────────┘
```

## What the agent sees (context injection order)

1. **Agent Self-Model** — self category memories injected FIRST (what the agent knows about itself)
2. **Session header** — channel, topic, scope, model name, memory count
3. **Background activity** — recent cron/heartbeat outcomes + active sessions list
4. **Tool call ledger** — recent tool calls (survives compaction)
5. **Cross-session memories** — grouped by category, with [IDs] + [scope] + (age) + evidence markers (source, confidence, contradictions)
6. **Hypotheses** — low-confidence memories (confidence < 0.5) listed separately
7. **Working memory** — scratchpad (task progress, findings, questions)
8. **Knowledge graph** — channels → topics → entities + relationships map
9. **Discovery Mode nudge** — aggressive extraction reminder (first 72h only)
10. **Tools guide** — memory tools reference (first message only)

## Auto-created graph structure

On every `bootstrap()`, the system automatically creates:
- **Channel entities** (e.g., "telegram") — type: "channel"
- **Topic entities** (e.g., "telegram/topic:7") — type: "topic"
- **Session→topic edges** (`belongs_to_topic`) — for topic sessions
- **Session→channel edges** (`belongs_to_channel`) — for DMs, crons, non-topic sessions
- **Topic→channel edges** (`part_of_channel`)

No agent action needed. The tree builds itself.

## OpenClaw hooks (12 registered)

| Hook | Status | What it captures |
|------|--------|-----------------|
| `after_tool_call` | DONE | Log tool calls → tool_call table (survives compaction) |
| `tool_result_persist` | DONE | Compress large tool results before storage |
| `before_prompt_build` | DONE | Append agent instructions via appendSystemContext (cached) |
| `agent_end` | DONE | Cron/heartbeat/subagent outcomes → memory (with delivery target) |
| `llm_output` | DONE | Token usage + model name → metrics + session header |
| `subagent_spawned` | DONE | Create session→spawned→session graph edge |
| `subagent_ended` | DONE | Capture child outcome, save failures as memories |
| `subagent_delivery_target` | DONE | Track where cron/subagent output is routed |
| `session_start` | DONE | Track session lifecycle, save "resumed from" as memory |
| `session_end` | DONE | Session duration + message count → metrics |
| `message_received` | DONE | Upsert sender as entity (agent sees who's talking) |
| `message_sent` | DONE | Track delivery target + failures |

## Graph edges — what's connected

| Edge | From → To | Created by | Status |
|------|-----------|-----------|--------|
| `has_message` | session → message | `ingest()` | DONE |
| `prev_version` | memory → memory | `saveMemory()` UPDATE | DONE |
| `relates` (any type) | memory ↔ memory/entity | Linker service (5 min active / 30 min idle) | DONE |
| `spawned` | session → session | `subagent_spawned` hook | DONE |
| `has_identity` | person → contact | `qmemory_person` tool | DONE |
| `extracted_from` | memory → message | — | NOT POSSIBLE — OpenClaw doesn't pass message IDs to compact/afterTurn |

## Known architectural limits

- **`extracted_from` edges**: Schema defines them but they can't be created. OpenClaw's messages array passed to `compact()`/`afterTurn()` doesn't include our SurrealDB message IDs. We'd need OpenClaw to pass message IDs or a content-hash mapping.
- **Telegram events** (edits, deletes, reactions, joins/leaves): OpenClaw doesn't expose these via hooks. Only `message_received` fires for new messages.
- **Diagnostic events** (heartbeat health, webhook stats, queue depth): Internal to OpenClaw, not hookable by plugins.
- **Group participant list**: OpenClaw doesn't expose Telegram group member API to plugins.

## Context injection

Two injection mechanisms:
- **`appendSystemContext`** (static, cached) — `AGENT_SYSTEM_CONTEXT` in `index.ts`, teaches the agent its tools, memory philosophy, and how to read injected context. No per-turn cost.
- **`systemPromptAddition`** (dynamic, per-turn) — built by `assemble()`, contains self-model, memories with evidence markers, tool ledger, scratchpad, graph map. See "What the agent sees" section above for injection order.

## Design principles

- **Everything is connected** — no orphan nodes. Linker runs every 30 min to find relationships
- **Agent can traverse** — IDs are visible so agent can reference, correct, link, delete
- **Survives compaction** — tool ledger, scratchpad, and memories persist when messages are dropped
- **SurrealDB record references** — always use `type::record("table", $id)` for FK fields, never plain strings (JS SDK returns RecordId objects, not strings)
- **Prompting best practices** — follow Anthropic's guidelines: clear/direct, XML structure, examples, context for motivation
- **Memory as evidence, not truth** — every memory has a source_person, confidence, and evidence_type. Contradictions are flagged, not auto-resolved.
- **Agent self-model** — the agent learns about itself via the "self" category. Self-knowledge is injected first in context.

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
├── openclaw/       ← ENTRY 1: Context engine plugin + 6 tools + linker service
├── mcp/            ← ENTRY 2: FastMCP server (4 tools for Claude Code/Claude.ai)
├── cli.ts          ← ENTRY 3: CLI (npx qmemory serve|serve-http|status|schema)
├── config.ts       ← All types, constants, formatMemories()
└── ui/             ← Graph viewer (vis.js, served at /qmemory/graph)
```

**Three entry points, one core.** OpenClaw plugin, MCP server, and CLI all call the same `core/` functions.

## Graph Schema (SurrealDB)

7 tables: `session`, `message`, `memory`, `entity`, `tool_call`, `scratchpad`, `metrics`
3 structural edges: `has_message`, `extracted_from`, `prev_version` (auto-created)
1 dynamic edge: `relates` (agent creates ANY relationship type, also used for `belongs_to_topic`, `belongs_to_channel`, `spawned`, `part_of_channel`)

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
| `qmemory_search` | 4-tier recall + cross-session tool_call history (use `include_tool_calls: true`) |
| `qmemory_save` | Save fact with evidence (source_person, confidence, evidence_type, context_mood) + LLM dedup |
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

All background tasks use **self-scheduling**: after each run, the task checks if it found work. Found work → run again sooner (burst mode). No work → back off (idle mode). Reflect is staggered by half-interval so they never compete for the subagent runner.

- **Linker** (5 min active / 30 min idle): finds unlinked memories, asks subagent for relationships, creates `relates` edges
- **Salience Decay** (piggybacks on Linker): 3-tier biological model — never-recalled memories decay ×0.90, stale-recalled ×0.98, cemented (5+ recalls) never drop below 0.5. Pure DB, no LLM cost
- **Reflect** (10 min active / 30 min idle, staggered): 5 jobs — patterns, contradictions (flagged, no auto-delete), compressions (merge old facts → principles), ghost entity detection, self-learnings

## Memory Fields

| Field | Why |
|-------|-----|
| `salience` (0-1) | Importance weight — critical facts always recalled first |
| `valid_from/until` | Temporal validity — expired facts filtered out |
| `scope` | Visibility: `global`, `project:xxx`, `topic:xxx` |
| `confidence` | LLM confidence in the fact |
| `source_person` | record<entity> FK — who said this fact |
| `evidence_type` | How learned: observed, reported, inferred, self |
| `recall_count` | Biological memory counter — incremented on recall |
| `last_recalled` | When this memory was last recalled |
| `context_mood` | Situational context: calm_decision, heated_discussion, brainstorm, correction, casual, urgent |

## Memory Categories

8 categories (must match `MEMORY_CATEGORIES` in `config.ts`):

| Category | Purpose |
|----------|---------|
| `self` | Agent's self-knowledge (soul): communication patterns, what works, what to avoid — injected FIRST |
| `style` | Communication preferences (language, tone, format) |
| `preference` | General user preferences |
| `context` | Facts about projects, orgs, situations |
| `decision` | Past decisions made, with rationale |
| `idea` | Future plans, suggestions, proposals |
| `feedback` | User corrections and error reports |
| `domain` | Sector/domain knowledge |

## Entity External References

Entities can reference external systems (email, tasks, Smartsheet):
- `external_source`: "hey", "apple-reminders", "smartsheet", "railway"
- `external_id`: reference ID in the source system
- `external_url`: direct URL to the resource

## Discovery Mode

The first 72 hours of a session context activates **Discovery Mode** — an aggressive extraction phase:

- Extract more entities, preferences, and identity facts than normal
- Prioritise `self` and `identity` category memories
- Lower confidence threshold for saving new facts (explore broadly)
- Flag stored as engine state (`discoveryMode: true`), passed to the extract prompt
- After 72h: one-time **identity summary** generated (user profile + agent soul document saved as `self` memories)
- After the summary is saved, Discovery Mode is permanently disabled for that context

Purpose: build a rich model of the user and the agent's own communication patterns early, while interactions are fresh and varied.

## Gotchas

- **Jiti caches compiled plugins** — if gateway doesn't pick up code changes after rebuild, clear `/var/folders/*/T/jiti` and restart
- **SurrealDB 3.0: NULL vs NONE** — optional fields (`option<string>`) reject `NULL` from JS SDK. Omit the field entirely instead of passing `null`/`undefined`
- **SurrealDB 3.0: `type::record()` not `type::thing()`** — `type::thing()` was removed in v3. Use `type::record("table", $id)` for parameterized record IDs
- **SurrealDB 3.0: `search::score()` returns 0** — BM25 matching via `@@` works but scoring is broken. Vector search (cosine) handles relevance ranking
- **Subagent API (OpenClaw)** — `api.runtime.subagent.run()` requires `{ sessionKey, message, idempotencyKey }`, returns `{ runId }`. Must then `waitForRun()` + `getSessionMessages()` + `deleteSession()`. The wrapper in `createSubagentRunner()` handles this
- **⚠️ Subagent model override is NOT POSSIBLE via plugin SDK** — Neither `SubagentRunParams` (no `model` field) nor the `subagent_spawning` hook (event has `childSessionKey` but no `modelOverride` field) support overriding the model. Subagents always inherit the parent session's primary model. `agents.defaults.subagents.model` only applies to the built-in `sessions_spawn` tool, NOT plugin-spawned subagents. **Current status:** Not a cost issue since primary model switched to Gemini (free). Would need OpenClaw to add `model` to `SubagentRunParams` for true fix. Related OpenClaw issues: #10963, #10883, #6671, #7554, #7330
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

## Subagent Model Override — NOT POSSIBLE (as of 2026-03-23)

**Problem:** Qmemory's background tasks (dedup, extract, link) run via `api.runtime.subagent.run()`. Subagents always inherit the parent session's primary model. There is no way to override this via the plugin SDK.

**What was tried and failed:**
1. **`model` param in `SubagentRunParams`** — field doesn't exist, silently ignored by JS
2. **`subagent_spawning` hook** — event uses `childSessionKey` (not `sessionKey`) and has no `modelOverride` field. Setting arbitrary properties has no effect.
3. **`agents.defaults.subagents.model` config** — only applies to the built-in `sessions_spawn` tool, not plugin-spawned subagents

**Current status: Not a cost issue.** Primary model is now Gemini (free via API key), so subagents also run on Gemini for free. The only remaining benefit of GLM-5 would be speed (smaller model = faster responses).

**True fix:** Would require OpenClaw to add `model` to `SubagentRunParams`. Related issues: #10963, #10883, #6671, #7554, #7330

**API gotchas learned along the way:**
- OpenClaw hooks use `api.on("hook_name", handler)`, NOT `api.hooks.register()` (which crashes)
- `subagent_spawning` event type: `{ childSessionKey, agentId, label?, mode, requester?, threadRequested }`

**Note:** The `model` param in `createSubagentRunner()` can stay for forward-compatibility (OpenClaw may add it to `SubagentRunParams` later), but the hook is the reliable mechanism today.

## Config

Plugin config in `openclaw.plugin.json`. Key settings:
- `context_threshold: 0.75` — compact at 75% context window
- `fresh_tail_count: 32` — protect recent messages from compaction
- `memory_budget_pct: 0.15` — max 15% of context for memory injection
- `embedding_provider: "auto"` — reads from OpenClaw's existing config
- `linker_interval_ms: 1800000` — linker idle interval (30 min). When active: 5 min
- `reflect_interval_ms: 1800000` — reflect idle interval (30 min). When active: 10 min. Staggered 15 min after linker
- `subagent_model: "zai/glm-5"` — intended model for background LLM tasks (dedup, extract, link). **⚠️ NOT ACTUALLY USED** — OpenClaw's plugin SDK has no way to override the subagent model. Subagents inherit the parent session's primary model. Config kept for forward-compatibility if OpenClaw adds `model` to `SubagentRunParams`
- `extraction_mode: "balanced"` — adaptive extraction preset:
  - `economy` — for Lite plans (80 prompts/5hr), minimal token usage, ~1-2 extractions/hour
  - `balanced` — for Pro plans (400 prompts/5hr), normal operation, ~3-5 extractions/hour (default)
  - `aggressive` — for Team/Unlimited plans, extract everything, no limits

## Publishing

- **npm:** published as `qmemory` — auto-publishes via GitHub Actions on Release
- **Community plugin:** PR submitted to `openclaw/openclaw` docs (PR #49959)
- **Never store npm tokens locally** — GitHub Actions uses `NPM_TOKEN` secret
- **To release:** `npm version patch && git push && gh release create v$(node -p "require('./package.json').version") --generate-notes`

## Dependencies

4 runtime deps: `surrealdb` (JS SDK) + `fastmcp` (MCP server) + `@sinclair/typebox` (OpenClaw tool schemas) + `zod` (MCP tool schemas)

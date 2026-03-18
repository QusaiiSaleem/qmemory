# 🧠 Qmemory

**Graph memory for AI agents — the agent that remembers everything, connects everything, and never forgets.**

[![npm version](https://img.shields.io/npm/v/qmemory)](https://www.npmjs.com/package/qmemory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![SurrealDB 3.0+](https://img.shields.io/badge/SurrealDB-3.0%2B-9b59b6)](https://surrealdb.com)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-context--engine-ff6b35)](https://github.com/openclaw)
[![MCP Compatible](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-00a67e)](https://modelcontextprotocol.io)

> **What it is:** A graph-based memory layer that gives AI agents persistent, cross-session intelligence. Every fact is a node. Every relationship is an edge. Nothing is forgotten.
>
> **What it replaces:** The default flat-file memory in OpenClaw (LCM), or the "no memory at all" problem in Claude Code and Claude.ai.
>
> **Three ways to use it:**
> 1. 🔌 **OpenClaw context engine** — deepest integration, replaces LCM entirely
> 2. 🖥️ **MCP server for Claude Code** — stdio transport, add to `~/.claude.json`
> 3. 🌐 **MCP server for Claude.ai** — HTTP transport, connect via remote MCP

---

## 📋 Table of Contents

- [The Problem](#-the-problem)
- [The Solution](#-the-solution)
- [What the Agent Sees](#-what-the-agent-sees)
- [How It Works](#-how-it-works)
- [Features](#-features)
- [Comparison with Other Solutions](#-comparison-with-other-solutions)
- [Installation](#-installation)
- [Configuration](#%EF%B8%8F-configuration)
- [Tools Reference](#-tools-reference)
- [Graph Viewer UI](#%EF%B8%8F-graph-viewer-ui)
- [Agent Memory Management](#-agent-memory-management)
- [For AI Agents — SKILL.md](#-for-ai-agents--skillmd)
- [Graph Schema](#-graph-schema)
- [Migration](#-migration-import-old-memories)
- [How Memory Updates](#-how-memory-updates)
- [External References](#-external-references)
- [Community Issues Solved](#-community-issues-solved)
- [Troubleshooting](#-troubleshooting)
- [Development](#-development)
- [Wiki / Reference Files](#-wiki--reference-files)
- [License](#-license)
- [Credits](#-credits)

---

## 😤 The Problem

Every AI agent session is an island. Your agent learns things in one conversation — decisions, preferences, project context — and then **forgets everything** the moment the session ends.

```
┌─────────────────────────────────────────────────────────────────────┐
│                  THE FILING CABINET WITH LOCKED DRAWERS             │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Topic 7  │  │ Topic 9  │  │  Cron    │  │ Subagent │           │
│  │          │  │          │  │  Job     │  │  Task    │           │
│  │ "Budget  │  │ "What    │  │          │  │          │           │
│  │  approved│  │  was the │  │ "Check   │  │ "Deploy  │           │
│  │  at 500K"│  │  budget?"│  │  Railway │  │  to      │           │
│  │          │  │  🤷 ???  │  │  status" │  │  prod"   │           │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘           │
│       🔒            🔒            🔒            🔒                │
│                                                                     │
│  Each drawer is LOCKED. Session 9 cannot see what Session 7 knew.  │
│  The cron job has no idea about the budget. The subagent is blind. │
│                                                                     │
│  ┌──────────┐  ┌──────────┐                                       │
│  │ Topic 12 │  │  DM      │  ← Even direct messages are isolated  │
│  │ "Railway │  │ "User    │                                        │
│  │  is on   │  │  prefers │                                        │
│  │  us-east" │  │  Arabic" │                                        │
│  └──────────┘  └──────────┘                                        │
│       🔒            🔒                                             │
│                                                                     │
│  6 sessions. 6 locked drawers. Zero shared knowledge.              │
└─────────────────────────────────────────────────────────────────────┘
```

**The result?** You repeat yourself. The agent asks the same questions. Decisions made in Topic 7 are invisible in Topic 9. Your cron jobs operate without context. Subagents start from scratch every time.

This is how **every** AI assistant works by default — including OpenClaw's built-in LCM (which uses flat markdown files with no cross-session recall).

---

## ✨ The Solution

Qmemory replaces the filing cabinet with a **connected graph**. Every fact, every decision, every preference becomes a node — and they're all connected through typed relationships.

```
┌─────────────────────────────────────────────────────────────────────┐
│              THE CONNECTED GRAPH — QMEMORY IN ACTION               │
│                                                                     │
│  ┌──────────┐         ┌──────────────────────┐       ┌──────────┐  │
│  │ Topic 7  │────────▶│   🧠 Qmemory Graph   │◀──────│ Topic 12 │  │
│  │ "Budget  │         │                      │       │ "Railway  │  │
│  │  = 500K" │         │   ┌──────────────┐   │       │ us-east"  │  │
│  └──────────┘         │   │ memory:m001  │   │       └──────────┘  │
│                       │   │ "Budget 500K │   │                     │
│  ┌──────────┐         │   │  by team lead"│  │       ┌──────────┐  │
│  │ Topic 9  │────────▶│   └──────┬───────┘   │◀──────│  Cron    │  │
│  │          │         │          │supports    │       │  Job     │  │
│  │ ✅ Knows │         │   ┌──────▼───────┐   │       └──────────┘  │
│  │ budget!  │         │   │ memory:m042  │   │                     │
│  └──────────┘         │   │ "Railway on  │   │       ┌──────────┐  │
│                       │   │  us-east-1"  │   │◀──────│ Subagent │  │
│  ┌──────────┐         │   └──────────────┘   │       │          │  │
│  │   DM     │────────▶│                      │       │ ✅ Knows │  │
│  │ "Prefers │         │   All nodes linked.  │       │ context! │  │
│  │  Arabic" │         │   All sessions see.  │       └──────────┘  │
│  └──────────┘         └──────────────────────┘                     │
│                                                                     │
│  Topic 9 asks about the budget → Qmemory recalls it from Topic 7  │
│  Subagent deploys → Qmemory tells it "Railway is on us-east-1"    │
│  Cron job runs → it knows the budget, the server, the preferences  │
└─────────────────────────────────────────────────────────────────────┘
```

**Every session sees every memory.** Sorted by importance. Filtered by relevance. Connected through relationships the agent itself creates.

---

## 👁️ What the Agent Sees

When Qmemory is active, it automatically injects relevant memories into the agent's system prompt **before every response**. Here's exactly what gets added:

```markdown
## Cross-Session Memory (Qmemory)
_5 memories recalled, sorted by importance_

- [decision!] Budget approved at 500K SAR by team lead — final, no renegotiation
  ↳ Related: email in HEY (hey:inv-2026-003), task in Reminders
- [context!] Railway deployment on us-east-1, SurrealDB port must be 8000
  ↳ Related: entity "Railway" (deployment), entity "SurrealDB" (system)
- [preference] User prefers Arabic-first (RTL) with Cairo font across all projects
- [context] Acme CRM has 3 active clients: Waqf Fund, SRCA, Tamheer
  ↳ Scope: project:r-crm
- [decision] Use Hotwire (not React) for all new frontends — DHH philosophy
  ↳ Expires: 2027-01-01
```

**Key details:**
- The `!` marker means salience ≥ 0.8 (critical facts — always recalled first)
- Memories are sorted by importance, not by date
- External references (emails, tasks) are linked, not duplicated
- Scope filtering means project-specific memories only appear in the right context
- Expired facts are automatically filtered out
- The injection respects a **token budget** (default 15% of context window) — it won't flood your prompt

---

## 🏗️ How It Works

### Three Entry Points, One Core

```
┌─────────────────────────────────────────────────────────────────┐
│                        ENTRY POINTS                             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   OpenClaw   │  │  Claude Code │  │  Claude.ai   │          │
│  │   Plugin     │  │  (stdio MCP) │  │  (HTTP MCP)  │          │
│  │              │  │              │  │              │          │
│  │ Context      │  │ 4 tools via  │  │ 4 tools via  │          │
│  │ engine +     │  │ FastMCP      │  │ FastMCP      │          │
│  │ 5 tools +    │  │              │  │ httpStream   │          │
│  │ linker +     │  │              │  │              │          │
│  │ graph UI     │  │              │  │              │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
│         ▼                 ▼                 ▼                   │
│  ┌──────────────────────────────────────────────────┐          │
│  │                SHARED CORE (src/core/)            │          │
│  │                                                    │          │
│  │  recall   search   save   correct   link          │          │
│  │  extract  dedup    embeddings   migrate            │          │
│  └──────────────────────┬─────────────────────────────┘          │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────┐          │
│  │              SurrealDB 3.0+                       │          │
│  │                                                    │          │
│  │  ┌─────┐  ┌─────────┐  ┌────────┐  ┌────────┐   │          │
│  │  │sess-│  │ message  │  │ memory │  │ entity │   │          │
│  │  │ion  │  │          │  │        │  │        │   │          │
│  │  └──┬──┘  └────┬─────┘  └───┬────┘  └───┬────┘   │          │
│  │     │          │            │            │        │          │
│  │  has_message  extracted_from  prev_version       │          │
│  │                    relates (dynamic — ANY type)    │          │
│  └──────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### The Graph Schema

Qmemory's brain is a graph with **4 node types** and **4 edge types**:

```
  ┌──────────┐                ┌──────────┐
  │ session  │──has_message──▶│ message  │
  │          │                │          │
  │ channel  │                │ role     │
  │ chat_type│                │ content  │
  │ scope    │                │ tokens   │
  └──────────┘                └─────┬────┘
                                    │
                           extracted_from
                                    │
  ┌──────────┐                ┌─────▼────┐
  │  entity  │◀──relates───▶ │  memory  │
  │          │   (dynamic)    │          │
  │ name     │                │ content  │
  │ type     │                │ category │
  │ aliases  │                │ salience │──prev_version──▶ (old memory)
  │ external │                │ scope    │
  │  _source │                │ validity │
  │  _id     │                │ active?  │
  │  _url    │                │ embedding│
  └──────────┘                └──────────┘

  4 nodes: session, message, memory, entity
  3 structural edges: has_message, extracted_from, prev_version (auto-created)
  1 dynamic edge: relates (agent creates ANY relationship type)
```

**The `relates` edge is special** — it accepts ANY relationship type as a string: `supports`, `contradicts`, `manages`, `blocks`, `depends_on`, `caused_by`, `reports_to`, or anything the agent decides fits. This means the graph grows organically based on your actual work, not a rigid predefined ontology.

---

## 🚀 Features

### Memory & Recall
- **4-tier hybrid recall** — graph traversal → BM25 full-text → vector similarity → recent fallback
- **Salience scoring** (0.0–1.0) — critical facts (`salience ≥ 0.8`) are always recalled first
- **7 memory categories** — `style`, `preference`, `context`, `decision`, `idea`, `feedback`, `domain`
- **Temporal validity** — facts can have `valid_from` and `valid_until` dates; expired facts auto-filtered
- **Memory scoping** — `global`, `project:xxx`, or `topic:xxx` — right memories in the right context

### Deduplication & Accuracy
- **LLM-driven dedup** — every new fact is checked against existing memories (ADD / UPDATE / NOOP)
- **Version chains** — corrections create a `prev_version` edge; originals are never deleted (soft-delete only)
- **Contradiction resolution** — the reflect service auto-detects conflicting facts and deactivates the outdated one

### Graph Intelligence
- **Dynamic relationships** — the agent creates ANY edge type between any two nodes (`supports`, `contradicts`, `blocks`, etc.)
- **Background linker** (every 5 min) — finds unlinked memories, asks the LLM to discover relationships, creates edges
- **Background reflect** (every 30 min) — synthesizes insights across memories, resolves contradictions (inspired by Hindsight)
- **Entity extraction** — people, projects, orgs, concepts, and systems become first-class graph nodes

### OpenClaw Deep Integration
- **Pre-compaction memory flush** — at 70% context usage, Qmemory extracts memories *before* compaction fires (fixes [OpenClaw #19488](https://github.com/openclaw/openclaw/issues/19488))
- **Post-compaction amnesia fix** — high-salience memories are re-injected into the summary after compaction
- **Subagent memory sharing** — when a subagent spawns, it receives relevant memories from the parent session
- **Token budget control** — memory injection capped at 15% of context window (configurable)

### External References
- **Linked entities** — emails (HEY), tasks (Apple Reminders), Smartsheet rows, Railway deployments, calendar events
- **External IDs and URLs** — each entity can reference its source system (`hey:12345`, `smartsheet:row:789`)

### Visualization & Tools
- **Graph viewer UI** — interactive vis.js visualization at `/qmemory/graph` (dark theme, Arabic-friendly)
- **Graph API** — JSON endpoint at `/qmemory/api/graph` with filters (category, scope, date range)
- **Migration tool** — import existing `MEMORY.md` and `memory/*.md` files from OpenClaw workspaces
- **CLI** — `qmemory status`, `qmemory schema`, `qmemory serve`, `qmemory serve-http`

---

## 📊 Comparison with Other Solutions

| Feature | **Qmemory** | OpenClaw Built-in (LCM) | LCM (Legacy) | Mem0 | LanceDB-pro | Hindsight |
|---|---|---|---|---|---|---|
| **Storage** | SurrealDB graph | Flat markdown files | Flat markdown | Managed cloud | LanceDB (vector) | Custom graph |
| **Cross-session recall** | ✅ 4-tier hybrid | ❌ Same-session only | ❌ Same-session only | ✅ Vector search | ✅ Vector search | ✅ Graph + vector |
| **Graph relationships** | ✅ Dynamic (any type) | ❌ None | ❌ None | ❌ None | ❌ None | ✅ Fixed types |
| **Deduplication** | ✅ LLM-driven | ❌ None | ❌ None | ✅ Rule-based | ❌ None | ✅ LLM-driven |
| **Salience scoring** | ✅ 0.0–1.0 | ❌ No ranking | ❌ No ranking | ❌ No scoring | ❌ No scoring | ✅ Importance |
| **Temporal validity** | ✅ valid_from/until | ❌ No expiry | ❌ No expiry | ❌ No expiry | ❌ No expiry | ✅ Time-aware |
| **Background linking** | ✅ Every 5 min | ❌ None | ❌ None | ❌ None | ❌ None | ✅ Periodic |
| **Reflection/synthesis** | ✅ Every 30 min | ❌ None | ❌ None | ❌ None | ❌ None | ✅ Periodic |
| **Version history** | ✅ prev_version chain | ❌ Overwrite | ❌ Overwrite | ❌ Overwrite | ❌ Overwrite | ✅ Versioned |
| **External references** | ✅ Email, tasks, etc. | ❌ None | ❌ None | ❌ None | ❌ None | ❌ None |
| **Self-hosted** | ✅ SurrealDB local | ✅ Local files | ✅ Local files | ❌ Cloud only | ✅ Local | ❌ Cloud only |
| **OpenClaw integration** | ✅ Context engine | ✅ Built-in | ✅ Built-in | ❌ MCP only | ❌ MCP only | ❌ Not compatible |
| **MCP support** | ✅ stdio + HTTP | ❌ None | ❌ None | ✅ stdio | ✅ stdio | ❌ None |
| **LongMemEval accuracy** | — (pending) | ~40% | ~40% | ~65% | ~60% | **91.4%** (highest) |
| **Dependencies** | 2 (`surrealdb`, `fastmcp`) | 0 (built-in) | 0 (built-in) | Managed service | 1 (`lancedb`) | Managed service |
| **License** | MIT | MIT | MIT | Proprietary | Apache 2.0 | Proprietary |
| **Price** | Free | Free | Free | $$$$ | Free | $$$$ |

**Why Qmemory over the others?**
- vs **LCM/Built-in**: Qmemory adds cross-session recall, graph relationships, salience, and temporal validity — LCM just writes flat files
- vs **Mem0**: Qmemory is self-hosted, graph-based, and integrates as a full context engine — Mem0 is cloud-only vector search
- vs **LanceDB-pro**: Qmemory has typed relationships and dedup — LanceDB is pure vector with no graph intelligence
- vs **Hindsight**: Comparable features, but Qmemory is open-source, self-hosted, and runs as an OpenClaw plugin — Hindsight is proprietary cloud

---

## 📦 Installation

### Prerequisites

- **Node.js 22+** — `node --version`
- **SurrealDB 3.0+** — [Install SurrealDB](https://surrealdb.com/install)

### Option 1: OpenClaw Plugin (Full Power) 🔌

This is the deepest integration. Qmemory replaces LCM entirely and manages the full session lifecycle.

**Step 1: Install SurrealDB 3.0+**

> **Important:** Qmemory requires SurrealDB **v3.0 or later**. Older versions (v2.x) have incompatible syntax for schemas, FULLTEXT indexes, and record IDs. Check your version with `surreal version`.

```bash
# macOS (installs latest v3)
brew install surrealdb/tap/surreal

# Linux (installs latest v3)
curl -sSf https://install.surrealdb.com | sh

# Verify version — must be 3.x
surreal version
# Expected: surreal 3.0.0 or higher

# Start the server (data persists to disk)
surreal start --user root --pass root file:~/.qmemory/data.db
```

**Step 2: Install the plugin**

```bash
# From npm (recommended)
npm install -g qmemory

# OR directly through OpenClaw
openclaw plugins install qmemory
```

**Step 3: Set Qmemory as your context engine**

```bash
openclaw config set plugins.slots.contextEngine "qmemory"
```

**Step 4: Enable plugin tools**

The `coding` tool profile only includes core tools by default. You must add `group:plugins` to make Qmemory's tools visible to the agent:

```bash
openclaw config set tools.alsoAllow '["group:plugins"]'
```

> **Without this step, Qmemory's 6 tools will not appear in the agent's tool list.** The plugin will load and inject memories, but the agent cannot save, search, correct, or link memories on its own.

**Step 5: (Optional) Configure the plugin**

```bash
# Set SurrealDB password (default: root)
openclaw config set plugins.config.qmemory.surrealdb_pass "your-password"

# Enable vector search (uses your existing OpenClaw embedding key)
openclaw config set plugins.config.qmemory.embedding_provider "auto"
```

**Step 6: Restart the gateway**

```bash
openclaw gateway restart
```

**Step 7: Verify**

```bash
openclaw plugins inspect qmemory

# Check the graph is working
qmemory status
```

You should see:

```
Qmemory: connected
  SurrealDB:  ws://localhost:8000
  Namespace:  qmemory/main
  Memories:   0
  Entities:   0
  Edges:      0
  Sessions:   0
```

> **Important:** SurrealDB must be running **before** the OpenClaw gateway starts. If SurrealDB is down when the gateway boots, Qmemory runs in degraded mode (no memory operations, but no crash).

---

### Option 2: Claude Code (MCP Server — stdio) 🖥️

Add Qmemory as an MCP server in your Claude Code configuration.

**Step 1: Install**

```bash
npm install -g qmemory
```

**Step 2: Start SurrealDB 3.0+**

```bash
# Install if needed (see Option 1 above for full instructions)
surreal version  # Must be 3.x
surreal start --user root --pass root file:~/.qmemory/data.db
```

**Step 3: Apply the schema**

```bash
qmemory schema
```

**Step 4: Add to Claude Code config**

Add this to your `~/.claude.json` (or your project's `.claude.json`):

```json
{
  "mcpServers": {
    "qmemory": {
      "command": "qmemory",
      "args": ["serve"],
      "env": {
        "QMEMORY_SURREALDB_URL": "ws://localhost:8000",
        "QMEMORY_SURREALDB_USER": "root",
        "QMEMORY_SURREALDB_PASS": "root"
      }
    }
  }
}
```

**Step 5: Restart Claude Code**

Claude Code will now have 4 tools: `qmemory_search`, `qmemory_save`, `qmemory_correct`, `qmemory_link`.

> **Note:** In Claude Code mode, you get 4 tools (no `qmemory_import`). Auto-injection of memories into the system prompt requires the OpenClaw plugin mode.

---

### Option 3: Claude.ai (MCP Server — HTTP) 🌐

Run Qmemory as an HTTP MCP server and connect it to Claude.ai's remote MCP feature.

**Step 1: Install and start**

```bash
npm install -g qmemory
surreal start --user root --pass root file:~/.qmemory/data.db
qmemory schema
```

**Step 2: Start the HTTP server**

```bash
# Default port: 3777
qmemory serve-http

# Custom port
qmemory serve-http 4000
```

You should see:

```
Qmemory MCP server running on http://localhost:3777/mcp
```

**Step 3: Connect from Claude.ai**

In Claude.ai settings, add a remote MCP server pointing to `http://localhost:3777/mcp` (or your public URL if deployed).

> **Tip:** For production, deploy Qmemory behind a reverse proxy with HTTPS. The MCP endpoint is at `/mcp`.

---

## ⚙️ Configuration

### OpenClaw Plugin Config

All options are set via `openclaw config set plugins.config.qmemory.<key> <value>`:

| Option | Type | Default | Description |
|---|---|---|---|
| `surrealdb_url` | string | `ws://localhost:8000` | SurrealDB connection URL |
| `surrealdb_user` | string | `root` | SurrealDB username |
| `surrealdb_pass` | string | `root` | SurrealDB password |
| `namespace` | string | `qmemory` | SurrealDB namespace |
| `database` | string | `main` | SurrealDB database name |
| `context_threshold` | number | `0.75` | Trigger compaction at this % of context window (0–1) |
| `fresh_tail_count` | integer | `32` | Number of recent messages protected from compaction |
| `memory_budget_pct` | number | `0.15` | Max % of context window for memory injection (0–1) |
| `embedding_provider` | string | `auto` | Embedding provider: `auto` (reuse OpenClaw's key), `voyage`, `openai`, `gemini`, or `none` (BM25 only) |
| `embedding_api_key` | string | — | Override API key for embeddings (leave empty to use OpenClaw's) |
| `embedding_model` | string | — | Override embedding model (leave empty to use OpenClaw's) |
| `embedding_dimension` | integer | `1024` | Embedding vector dimension |
| `linker_interval_ms` | integer | `300000` | Background linker interval (default: 5 min) |
| `reflect_interval_ms` | integer | `1800000` | Background reflection interval (default: 30 min) |
| `min_salience_recall` | number | `0.3` | Minimum salience to include in recall results |
| `debug` | boolean | `false` | Enable debug logging |

### Environment Variables (CLI / MCP mode)

When running as a standalone MCP server, configure via environment variables:

| Variable | Default | Description |
|---|---|---|
| `QMEMORY_SURREALDB_URL` | `ws://localhost:8000` | SurrealDB connection URL |
| `QMEMORY_SURREALDB_USER` | `root` | SurrealDB username |
| `QMEMORY_SURREALDB_PASS` | `root` | SurrealDB password |
| `QMEMORY_NAMESPACE` | `qmemory` | SurrealDB namespace |
| `QMEMORY_DATABASE` | `main` | SurrealDB database name |
| `QMEMORY_EMBEDDING_PROVIDER` | `none` | `voyage`, `openai`, or `none` |
| `QMEMORY_EMBEDDING_API_KEY` | — | API key for embedding provider |
| `QMEMORY_DEBUG` | `false` | Enable debug logging |

---

## 🔧 Tools Reference

Qmemory exposes **5 tools** in OpenClaw mode and **4 tools** in MCP mode.

### `qmemory_search`

Search cross-session memory by meaning, category, or scope.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | No | Search by meaning (BM25 full-text) |
| `categories` | string[] | No | Filter: `style`, `preference`, `context`, `decision`, `idea`, `feedback`, `domain` |
| `scope` | string | No | Filter: `global`, `project:xxx`, `topic:xxx` |
| `limit` | number | No | Max results, 1–50 (default: 10) |

**Example:**
```
qmemory_search({ query: "Railway deployment", categories: ["context", "decision"], limit: 5 })
```

**Returns:**
```
[mem001] [context, salience:0.9] Railway deployment on us-east-1, SurrealDB port must be 8000
[mem042] [decision, salience:0.8] Use Railway free tier for staging, upgrade for production
```

---

### `qmemory_save`

Save a fact to cross-session memory. Runs dedup automatically.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | The fact to remember (one clear statement) |
| `category` | string | Yes | `style`, `preference`, `context`, `decision`, `idea`, `feedback`, or `domain` |
| `salience` | number | No | Importance 0.0–1.0 (default: 0.5). Use 0.8+ for critical facts |
| `scope` | string | No | `global` (default), `project:xxx`, or `topic:xxx` |

**Example:**
```
qmemory_save({
  content: "Budget approved at 500K SAR by team lead — final decision",
  category: "decision",
  salience: 0.9,
  scope: "project:acme"
})
```

**Returns:** `ADD: memory:mem1710864000abc [decision, salience:0.9]`

If a similar memory already exists, the system may return `UPDATE` (merged) or `NOOP` (already known).

---

### `qmemory_correct`

Fix, update, delete, or unlink memories. 4 actions available.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `memory_id` | string | Yes | The memory ID (e.g., `memory:mem1234abcd`) |
| `action` | string | Yes | `correct`, `update`, `delete`, or `unlink` |
| `new_content` | string | Only for `correct` | The corrected content |
| `salience` | number | Only for `update` | New importance score (0.0–1.0) |
| `scope` | string | Only for `update` | New scope (`global`, `project:xxx`, `topic:xxx`) |
| `valid_until` | string | Only for `update` | Expiry date (ISO 8601) |
| `edge_id` | string | Only for `unlink` | The `relates` edge ID to remove |

**Examples:**
```
// Fix wrong content (creates version chain)
qmemory_correct({ memory_id: "memory:mem001", action: "correct", new_content: "Actually 600K not 500K" })

// Update metadata (in-place, no new version)
qmemory_correct({ memory_id: "memory:mem001", action: "update", salience: 1.0 })

// Soft-delete
qmemory_correct({ memory_id: "memory:mem001", action: "delete" })

// Remove a relationship edge
qmemory_correct({ memory_id: "memory:mem001", action: "unlink", edge_id: "relates:r789" })
```

**Returns:** `Corrected: memory:mem001 → memory:mem002` (for `correct` action)

See [Agent Memory Management](#-agent-memory-management) for detailed explanation of all 4 actions.

---

### `qmemory_link`

Create a relationship between any two nodes in the graph.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from_id` | string | Yes | Source node ID (e.g., `memory:mem123`, `entity:ent456`) |
| `to_id` | string | Yes | Target node ID |
| `type` | string | Yes | Any relationship: `supports`, `contradicts`, `blocks`, `depends_on`, `caused_by`, `manages`, etc. |
| `reason` | string | No | Why this relationship exists |

**Example:**
```
qmemory_link({
  from_id: "memory:mem001",
  to_id: "entity:ent_railway",
  type: "deployed_on",
  reason: "The application is hosted on Railway us-east-1"
})
```

**Returns:** `Linked: memory:mem001 —[deployed_on]→ entity:ent_railway (relates:r789)`

---

### `qmemory_import` *(OpenClaw only)*

Import a markdown file into the memory graph.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | Yes | Absolute path to the markdown file |

**Example:**
```
qmemory_import({ file_path: "~/.openclaw/workspace/memory/2026-03-14.md" })
```

**Returns:** `Imported: 12 facts extracted, 9 new memories created`

---

## 🖥️ Graph Viewer UI

Qmemory includes an interactive graph visualization that shows your entire memory network — every fact, entity, and relationship as a live, explorable graph.

**Access it at:** `http://localhost:<gateway-port>/qmemory/graph`

For the default OpenClaw setup: **http://127.0.0.1:18789/qmemory/graph**

The viewer shows:
- **Memory nodes** — facts with salience coloring (brighter = more important)
- **Entity nodes** — people, projects, systems
- **Relationship edges** — typed connections (supports, manages, blocks, etc.)
- **Filters** — filter by category, scope, or date range

**API endpoint:** `GET /qmemory/api/graph` returns JSON `{ nodes, edges }` with optional query params:
- `?category=context` — filter by memory category
- `?scope=global` — filter by scope
- `?from=2026-01-01&to=2026-03-18` — filter by date range

> No authentication needed on localhost. The graph viewer is read-only.

---

## 🧹 Agent Memory Management

Qmemory gives the agent (and you) full control over its memory — not just saving and searching, but **editing, updating, expiring, deleting, and unlinking** memories. The `qmemory_correct` tool supports **4 distinct actions**:

### 1. Correct — Fix wrong content (version chain)

When a fact is wrong, `correct` creates a **new version** while preserving the old one via a `prev_version` edge. Nothing is ever truly lost.

```
qmemory_correct({
  memory_id: "memory:mem001",
  action: "correct",
  new_content: "Budget approved at 600K SAR (revised up from 500K)"
})
```

**Result:** Old memory soft-deleted → new memory created → `prev_version` edge links them.

### 2. Update — Change metadata (no new version)

Update salience, scope, or expiry **without creating a new version**. Use this when the fact is right, but its importance or context changed.

```
// Make something critical
qmemory_correct({ memory_id: "memory:mem001", action: "update", salience: 1.0 })

// Set an expiry date
qmemory_correct({ memory_id: "memory:mem001", action: "update", valid_until: "2026-06-01T00:00:00Z" })

// Change scope from topic-specific to global
qmemory_correct({ memory_id: "memory:mem001", action: "update", scope: "global" })
```

### 3. Delete — Soft-delete a memory

Marks the memory as `is_active = false`. It stays in the graph (for audit) but no longer appears in recall results.

```
qmemory_correct({ memory_id: "memory:mem001", action: "delete" })
```

### 4. Unlink — Remove a relationship

Remove a `relates` edge between two nodes. The nodes themselves remain — only the connection is severed.

```
qmemory_correct({ memory_id: "memory:mem001", action: "unlink", edge_id: "relates:r789" })
```

### Summary Table

| Action | What Changes | Creates New Version? | Old Data Preserved? |
|---|---|---|---|
| `correct` | Content | Yes (new node + `prev_version` edge) | Yes (soft-deleted, linked) |
| `update` | Salience, scope, expiry | No (in-place edit) | No (overwritten) |
| `delete` | `is_active` → false | No | Yes (still in graph) |
| `unlink` | Removes edge | No | No (edge deleted) |

---

## 🤖 For AI Agents — SKILL.md

Qmemory ships with a **[SKILL.md](SKILL.md)** file — a comprehensive guide that teaches AI agents **when and how** to use Qmemory effectively. It covers:

- **When to save** — decision guide ("Would this be useful in a FUTURE conversation?")
- **Salience scoring** — what 0.3 vs 0.5 vs 0.8 vs 1.0 means with real examples
- **Category selection** — which of the 7 categories fits each type of information
- **When to link** — signals that indicate a relationship should be created
- **When to correct** — user feedback signals ("That's wrong", "That's not important anymore", "Forget that")
- **Freeform relationship types** — the agent can use any string as a relationship type
- **Background processes** — what happens automatically so the agent doesn't need to do it

### How to Use SKILL.md

Add a reference to SKILL.md in your agent's system prompt, SOUL.md, or configuration:

**For OpenClaw** — add to your agent's `SOUL.md`:
```markdown
## Memory

This agent uses Qmemory for cross-session graph memory.
See SKILL.md in the Qmemory plugin for the full memory management guide.
```

**For Claude Code** — add to your project's `.claude/CLAUDE.md`:
```markdown
## Memory

This project uses Qmemory (MCP server) for persistent memory.
When the user shares important facts, decisions, or preferences, save them with qmemory_save.
When you need past context, search with qmemory_search.
See the Qmemory SKILL.md for detailed usage guidelines.
```

The SKILL.md teaches the agent to be a responsible memory manager — saving important things, skipping trivial exchanges, and using the right category and salience for each fact.

---

## 🕸️ Graph Schema

The full SurrealDB schema lives in [`schema/qmemory.surql`](schema/qmemory.surql). Here's the visual overview:

```
┌─────────────────────────── NODES ───────────────────────────┐
│                                                             │
│  SESSION                MESSAGE               MEMORY        │
│  ┌──────────────┐      ┌──────────────┐      ┌───────────┐ │
│  │ session_key  │      │ role         │      │ content   │ │
│  │ channel      │      │ content      │      │ category  │ │
│  │ chat_type    │      │ tool_calls   │      │ salience  │ │
│  │ topic_id     │      │ tool_name    │      │ valid_from│ │
│  │ group_id     │      │ token_count  │      │ valid_until│ │
│  │ scope        │      │ created_at   │      │ scope     │ │
│  │ last_active  │      └──────────────┘      │ is_active │ │
│  └──────────────┘                            │ confidence│ │
│                                              │ source_type│ │
│  ENTITY                                      │ embedding │ │
│  ┌──────────────┐                            └───────────┘ │
│  │ name         │                                          │
│  │ type         │  Types: person, project, org, concept,   │
│  │ aliases[]    │  system, email, task, event, document,   │
│  │ external_id  │  smartsheet, deployment                  │
│  │ external_url │                                          │
│  │ external_src │                                          │
│  │ embedding    │                                          │
│  └──────────────┘                                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────── EDGES ───────────────────────────┐
│                                                             │
│  STRUCTURAL (auto-created by the system):                   │
│                                                             │
│    session ──[has_message]──▶ message                       │
│    memory  ──[extracted_from]──▶ message                    │
│    memory  ──[prev_version]──▶ memory  (version chain)     │
│                                                             │
│  DYNAMIC (created by agent, linker, reflect, or compact):   │
│                                                             │
│    (any) ──[relates]──▶ (any)                               │
│                                                             │
│    relates.type: ANY string                                 │
│      "supports", "contradicts", "elaborates",              │
│      "depends_on", "caused_by", "blocks",                  │
│      "manages", "reports_to", "deployed_on",               │
│      "synthesized_from", "follows", ...                    │
│                                                             │
│    relates.confidence: 0.0–1.0                              │
│    relates.created_by: "agent"|"linker"|"compact"|"reflect"│
│    relates.reason: optional explanation                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Indexes

- **BM25 full-text search** on `memory.content` (primary search method)
- **Standard indexes** on `is_active`, `category`, `salience`, `scope`
- **Vector index** (HNSW, optional) on `memory.embedding` when embeddings are enabled
- **Unique index** on `session.session_key`
- **Composite index** on `entity.external_source + external_id`

---

## 🔄 Migration (Import Old Memories)

Already have memory files from OpenClaw? Qmemory can import them.

### Import an entire workspace

```bash
# Via the agent (OpenClaw mode — uses LLM for smart extraction)
> Import all my memory files into Qmemory

# The agent will call qmemory_import for each file
```

### Import a single file

```
qmemory_import({ file_path: "/path/to/MEMORY.md" })
```

### How migration works

```
┌─────────────────────────────────────────────────────┐
│                 MIGRATION PIPELINE                   │
│                                                     │
│  ~/.openclaw/workspace/                             │
│    ├── MEMORY.md          ← Long-term curated       │
│    └── memory/                                      │
│        ├── 2026-03-01.md  ← Daily snapshot          │
│        ├── 2026-03-02.md                            │
│        └── 2026-03-14.md                            │
│                                                     │
│            │                                        │
│            ▼                                        │
│  ┌─────────────────────┐                            │
│  │   Smart Extract     │  (with LLM)               │
│  │   OR Simple Extract │  (without LLM — fallback) │
│  └─────────┬───────────┘                            │
│            │                                        │
│            ▼                                        │
│  ┌─────────────────────┐                            │
│  │   Dedup Pipeline    │  ADD / UPDATE / NOOP       │
│  └─────────┬───────────┘                            │
│            │                                        │
│            ▼                                        │
│  ┌─────────────────────┐                            │
│  │   Graph Nodes       │  + chronological edges     │
│  │   (memory, entity)  │  (file A → file B)         │
│  └─────────────────────┘                            │
└─────────────────────────────────────────────────────┘
```

**Two modes:**
1. **Smart import** (with LLM): Extracts structured facts, categories, salience scores, and entities using a subagent
2. **Simple import** (without LLM): Each non-empty line becomes a memory with heuristic categorization

Files are processed oldest → newest, with `follows` edges linking them chronologically.

---

## ⚡ How Memory Updates

Qmemory has **6 trigger points** where memories are created or updated:

```
┌────────────────────────────────────────────────────────────────────┐
│                   6 MEMORY UPDATE TRIGGERS                        │
│                                                                    │
│  ① afterTurn                                                      │
│     After every agent response, extract facts from the last       │
│     few messages. Runs in the background (non-blocking).          │
│                                                                    │
│  ② Pre-compaction flush (70% context)                             │
│     When context hits 70%, urgently extract memories              │
│     from older messages BEFORE compaction drops them.             │
│     Fixes OpenClaw #19488.                                        │
│                                                                    │
│  ③ compact()                                                      │
│     When context exceeds threshold (default 75%), extract         │
│     memories from old messages and drop them from context.        │
│     High-salience facts are re-injected (prevents amnesia).       │
│                                                                    │
│  ④ qmemory_save (agent tool)                                     │
│     The agent explicitly saves a fact (e.g., user says            │
│     "remember this"). Goes through full dedup pipeline.           │
│                                                                    │
│  ⑤ Background Linker (every 5 min)                                │
│     Finds unlinked memories, asks LLM for relationships,          │
│     creates `relates` edges. Makes the graph smarter over time.   │
│                                                                    │
│  ⑥ Background Reflect (every 30 min)                              │
│     Reviews recent memories, synthesizes insights,                │
│     resolves contradictions. Creates new "insight" memories       │
│     and deactivates outdated facts.                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 🔗 External References

Entities in Qmemory can reference external systems. This means your agent can connect memories to real-world objects without duplicating data.

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL REFERENCES                           │
│                                                                 │
│  ┌─────────────────┐      ┌─────────────────┐                  │
│  │ entity:ent001   │      │ memory:mem042   │                  │
│  │                 │      │ "Invoice sent   │                  │
│  │ name: "Invoice" │◀─────│  to team lead" │                  │
│  │ type: "email"   │      └─────────────────┘                  │
│  │ external_source:│                                           │
│  │   "hey"         │  ← Source system (HEY email)              │
│  │ external_id:    │                                           │
│  │   "hey:inv-003" │  ← ID in source system                   │
│  │ external_url:   │                                           │
│  │   "https://app. │  ← Direct link to the email              │
│  │    hey.com/..." │                                           │
│  └─────────────────┘                                           │
│                                                                 │
│  Supported sources:                                            │
│  ┌──────────────────────────────────────────┐                  │
│  │ hey             → HEY email              │                  │
│  │ apple-reminders → Apple Reminders tasks  │                  │
│  │ smartsheet      → Smartsheet rows        │                  │
│  │ railway         → Railway deployments    │                  │
│  │ calendar        → Calendar events        │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                 │
│  The agent doesn't copy email content into memory.             │
│  It creates a LINK: "This decision relates to that email."     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🐛 Community Issues Solved

Qmemory was built to fix real problems reported in the OpenClaw community:

| Issue | Problem | How Qmemory Fixes It |
|---|---|---|
| [#19488](https://github.com/openclaw/openclaw/issues/19488) | Pre-compaction flush never fires — memories lost during compaction | Pre-compaction flush at 70% context extracts facts before they're dropped |
| [#19148](https://github.com/openclaw/openclaw/issues/19148) | Post-compaction amnesia — agent forgets critical context after compaction | High-salience memories (≥0.8) are re-injected into the summary |
| [#18932](https://github.com/openclaw/openclaw/issues/18932) | No cross-session memory — each topic is isolated | Full graph-based recall across all sessions, topics, and channels |
| [#18744](https://github.com/openclaw/openclaw/issues/18744) | Memory duplicates pile up — same fact stored 20 times | LLM-driven dedup pipeline: ADD / UPDATE / NOOP on every save |
| [#18201](https://github.com/openclaw/openclaw/issues/18201) | No way to correct wrong memories | `qmemory_correct` with soft-delete + version chain |
| [#17956](https://github.com/openclaw/openclaw/issues/17956) | Subagents have no context from parent | `prepareSubagentSpawn()` shares relevant memories with child sessions |

---

## 🔍 Troubleshooting

### Agent can't see Qmemory tools

**Symptom:** Plugin loads (logs show "Qmemory plugin loaded") but agent lists only core tools (read, write, exec, etc.) — no `qmemory_*` tools.

**Cause:** OpenClaw's `tools.profile: "coding"` has a hardcoded allowlist of core tools. Plugin tools are filtered out unless explicitly allowed.

**Fix:**
```bash
openclaw config set tools.alsoAllow '["group:plugins"]'
openclaw gateway restart
```

This adds ALL plugin tools (not just Qmemory) to the agent's available tools. You only need to do this once.

---

### SurrealDB not running

**Symptom:** Plugin loads but no memories are saved or recalled. Logs show "Cannot connect to SurrealDB" or agent runs in "degraded mode."

**Fix:**
```bash
# Start SurrealDB
surreal start --user root --pass root file:~/.qmemory/data.db

# Verify
qmemory status

# (Optional) Auto-start on macOS login
bash scripts/setup-surrealdb-launchagent.sh
```

> SurrealDB must be running **before** the OpenClaw gateway starts. If you start SurrealDB after, restart the gateway: `openclaw gateway restart`

---

### Context engine not active

**Symptom:** Tools work but memories are not auto-injected into conversations. No compaction. No cross-session recall.

**Cause:** The context engine slot is not set to Qmemory.

**Fix:**
```bash
openclaw config set plugins.slots.contextEngine "qmemory"
openclaw gateway restart
```

---

### Wrong SurrealDB version

**Symptom:** Schema fails to apply, FULLTEXT index errors, `Cannot execute CREATE statement` errors, or `type::record` parse errors.

**Cause:** SurrealDB v2.x has incompatible syntax. Qmemory requires v3.0+.

**Fix:**
```bash
# Check version
surreal version
# If 2.x, upgrade:

# macOS
brew upgrade surrealdb/tap/surreal

# Linux
curl -sSf https://install.surrealdb.com | sh

# Verify
surreal version
# Must show: 3.0.0 or higher
```

---

### Schema not applied

**Symptom:** SurrealDB is running but queries fail with "table not found" errors.

**Fix:** The schema is auto-applied on the first session (`bootstrap()`). If you need to apply it manually:
```bash
qmemory schema
# or
npx tsx src/cli.ts schema
```

---

### Plugin not loaded

**Symptom:** No "Qmemory plugin loaded" message in logs.

**Fix:**
```bash
# Check plugin status
openclaw plugins list | grep qmemory

# Ensure it's enabled
openclaw config set plugins.entries.qmemory.enabled true

# Ensure it's in the allowlist
openclaw config set plugins.allow '["qmemory"]'

# Restart
openclaw gateway restart
```

---

### Tools registered but returning errors

**Symptom:** Agent sees `qmemory_*` tools but they fail with connection errors.

**Fix:** Check that SurrealDB is running and accessible:
```bash
qmemory status
# Should show: Qmemory: connected
```

If it shows "disconnected", restart SurrealDB and the gateway.

---

### Quick diagnostic checklist

```bash
# 1. Is SurrealDB running?
qmemory status

# 2. Is the plugin loaded?
openclaw plugins list | grep qmemory

# 3. Is the context engine set?
openclaw config get plugins.slots.contextEngine
# Should show: "qmemory"

# 4. Are plugin tools allowed?
openclaw config get tools.alsoAllow
# Should include: "group:plugins"

# 5. Check logs for errors
openclaw logs --follow | grep -i "qmemory\|surreal\|error"
```

---

## 🛠️ Development

### Setup

```bash
git clone https://github.com/QusaiiSaleem/qmemory.git
cd qmemory
npm install
npm run build
```

### Local development

```bash
# Start SurrealDB
surreal start --user root --pass root file:~/.qmemory/data.db

# Apply schema
npx tsx src/cli.ts schema

# Check status
npx tsx src/cli.ts status

# Run MCP server (stdio — for testing with Claude Code)
npx tsx src/cli.ts serve

# Run MCP server (HTTP — for testing with Claude.ai)
npx tsx src/cli.ts serve-http 3777

# Interactive MCP inspector (great for debugging tools)
npm run dev

# Link as OpenClaw plugin (dev mode — no npm publish needed)
openclaw plugins install -l /path/to/qmemory
openclaw config set plugins.slots.contextEngine "qmemory"
openclaw config set tools.alsoAllow '["group:plugins"]'
openclaw gateway restart
```

### Testing

```bash
npm test            # Run tests once
npm run test:watch  # Watch mode
```

### Debugging

```bash
# OpenClaw logs (filter for Qmemory)
openclaw logs --follow | grep qmemory

# Direct SurrealDB queries
surreal sql -e http://localhost:8000 -u root -p root \
  --namespace qmemory --database main
```

### Project structure

```
src/
├── core/               ← SHARED logic (used by all entry points)
│   ├── recall.ts       ← 4-tier hybrid recall pipeline
│   ├── search.ts       ← BM25 + vector + graph search
│   ├── save.ts         ← Save with dedup pipeline
│   ├── correct.ts      ← Fix or soft-delete memories
│   ├── link.ts         ← Create dynamic `relates` edges
│   ├── extract.ts      ← LLM-driven fact extraction
│   ├── dedup.ts        ← LLM-driven dedup (ADD/UPDATE/NOOP)
│   ├── embeddings.ts   ← Embedding generation + config resolution
│   └── migrate.ts      ← Import old memory files
├── db/
│   ├── client.ts       ← SurrealDB connection + parameterized queries
│   └── queries.ts      ← Reusable query helpers
├── openclaw/           ← ENTRY 1: Context engine plugin
│   ├── index.ts        ← Plugin registration (6 tools + engine + linker)
│   ├── engine.ts       ← Full context engine (bootstrap/ingest/assemble/compact)
│   └── linker.ts       ← Background services (link + reflect)
├── mcp/
│   └── server.ts       ← ENTRY 2: FastMCP server (4 tools, stdio + HTTP)
├── cli.ts              ← ENTRY 3: CLI (serve, serve-http, status, schema)
├── config.ts           ← Types, constants, formatMemories()
└── ui/
    ├── graph-handler.ts ← HTTP handler for graph viewer + API
    └── graph.html       ← vis.js interactive graph (dark theme)
```

### Dependencies

Only **3 runtime dependencies** — keeping it simple:

| Package | Why |
|---|---|
| `surrealdb` | Official SurrealDB JavaScript SDK |
| `fastmcp` | MCP server framework (stdio + HTTP transports) |
| `zod` | Schema validation for MCP tool parameters |

---

## ⛓️ Relationship Chains — The Power Feature

The `relates` edge connects **ANY node to ANY node**. The agent builds chains that map real-world workflows:

```
User says: "Ahmed needs the Q2 report by Thursday. Send it to his work email."

Agent builds this chain:

  Session (Topic 9)
    │ has_message
    ▼
  Message: "Ahmed needs the Q2 report by Thursday"
    │ extracted_from
    ▼
  Memory: "Ahmed needs Q2 report by Thursday"        (salience: 0.8)
    │ relates (assigned_to)
    ▼
  Entity: "Ahmed"                                     (type: person)
    │ has_identity
    ├──▶ Contact: WhatsApp 966501234567
    ├──▶ Contact: gmail ahmed@company.com             ← send here
    └──▶ Contact: Smartsheet user:12345
```

### More Real-World Chains

```
Decision Chain:
  memory:"Budget approved" → approved_by → entity:manager
                           → communicated_via → entity:approval_email
                           → depends_on → memory:"Board meeting March 5"

Incident Chain:
  memory:"Prod down 2 hours" → caused_by → memory:"Friday deploy broke auth"
                              → affected → entity:railway_prod
                              → resolved_by → entity:on_call_engineer

Task Chain:
  entity:hire_developer → depends_on → memory:"Budget approved"
                        → blocks → memory:"Need 2 devs for Q3"
                        → assigned_to → entity:hr_manager
```

### People with Multiple Identities

```
qmemory_person({
  name: "Ahmed",
  aliases: ["أحمد"],
  contacts: [
    { source: "whatsapp", id: "966501234567" },
    { source: "gmail", id: "ahmed@company.com" },
    { source: "telegram", id: "ahmed_k" },
    { source: "smartsheet", id: "user:12345" }
  ]
})
```

Later: `qmemory_person({ name: "Ahmed", action: "find" })` returns the person + ALL contacts + ALL linked memories from any session.

### Common Relationship Types

| Type | Use For |
|------|---------|
| `assigned_to` | Task → Person |
| `approved_by` | Decision → Person |
| `caused_by` | Incident → Root cause |
| `depends_on` | Task → Prerequisite |
| `blocks` | Blocker → Blocked item |
| `has_identity` | Person → Contact (auto) |
| `communicated_via` | Fact → Communication channel |
| `managed_by` | Project → Manager |
| `monitors` | Session → System |
| `solved_using` | Problem → Tool/Skill |

These are NOT fixed — use **any word** that describes the relationship.

---

## 📚 Wiki / Reference Files

| File | What It Is | When to Read |
|---|---|---|
| [**SKILL.md**](SKILL.md) | Agent guide — teaches AI agents when/how to save, search, link, correct, and manage memory | Setting up a new agent, customizing memory behavior |
| [**CLAUDE.md**](CLAUDE.md) | Developer reference — architecture, key patterns, gotchas, quick commands | Contributing to Qmemory, debugging, understanding the codebase |
| [**schema/qmemory.surql**](schema/qmemory.surql) | Full SurrealDB schema — all 4 node types, 4 edge types, indexes, analyzers | Understanding the data model, writing custom queries |
| [**openclaw.plugin.json**](openclaw.plugin.json) | Plugin manifest — all config options with types, defaults, and UI hints | Configuring the OpenClaw plugin, understanding available settings |
| [**package.json**](package.json) | npm package — scripts, dependencies, entry points | Installing, building, understanding the project structure |

---

## 📄 License

[MIT](LICENSE) — use it however you want.

---

## 🙏 Credits

Created by **[Qusai Abu Shanab](https://github.com/QusaiiSaleem)**.

Powered by **[SurrealDB](https://surrealdb.com)** — the multi-model database that makes graph + document + vector queries feel natural.

Built for the **[OpenClaw](https://github.com/openclaw)** community — the open-source AI agent platform.

MCP integration via **[FastMCP](https://github.com/punkpeye/fastmcp)** — the simplest way to build MCP servers.

---

<p align="center">
  <em>"The best memory is the one that connects, not just stores."</em>
</p>

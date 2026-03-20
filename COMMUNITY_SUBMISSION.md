# Community Plugin Submission

## Plugin Entry (add to community plugins page)

```markdown
* **Qmemory** — Graph memory context engine plugin powered by SurrealDB. Adds cross-session intelligence: 4-tier hybrid recall (graph + BM25 + vector + recent), LLM-driven dedup, salience scoring, temporal validity, dynamic relationship graphs, people/contact management, and interactive graph viewer. Also works as standalone MCP server for Claude Code and Claude.ai.
  npm: `qmemory`
  repo: `https://github.com/QusaiiSaleem/qmemory`
  install: `openclaw plugins install qmemory`
```

## PR Title

Add Qmemory — graph memory context engine (SurrealDB)

## PR Body

### Plugin Info

- **Name**: Qmemory
- **npm**: `qmemory`
- **GitHub**: https://github.com/QusaiiSaleem/qmemory
- **Install**: `openclaw plugins install qmemory`
- **License**: MIT
- **Kind**: `context-engine`

### What It Does

Qmemory is an OpenClaw context-engine plugin that gives agents persistent, cross-session graph memory powered by SurrealDB. It implements the full `ContextEngine` interface (`bootstrap`, `ingest`, `assemble`, `compact`, `afterTurn`) and addresses 6 gaps in session-scoped memory:

1. **Cross-session recall** — memories from Topic A appear in Topic B
2. **Automatic extraction** — facts extracted from every conversation (no manual MEMORY.md)
3. **Works in ALL contexts** — DMs, groups, topics, subagents, cron jobs
4. **Dynamic relationships** — agent creates any relationship type between any two nodes
5. **Salience scoring** — importance weights (0-1) ensure critical facts always recalled
6. **Temporal validity** — facts expire when they're no longer true

### Key Features

- 4-tier hybrid recall: graph traversal + BM25 + vector (Voyage/OpenAI) + recent
- LLM-driven dedup via OpenClaw subagents (no extra API keys)
- Background linker (5 min) + reflect/synthesis (30 min)
- People management with multi-identity contacts (WhatsApp, email, Smartsheet, etc.)
- Interactive graph viewer (vis.js, dark theme)
- Pre-compaction memory flush (fixes #19488)
- Post-compaction amnesia fix (re-injects critical rules)
- Migration tool for existing memory files
- Also works as standalone MCP server for Claude Code and Claude.ai

### Community Issues Addressed

- #19488 (memory flush broken)
- #19148 (post-compaction amnesia)
- #26949 (MEMORY.md token waste)
- #24832 (cross-project contamination)
- #28930 (no importance weighting)
- #38874 (single memory plugin slot)

### Requirements

- SurrealDB 3.0+ (local)
- Node.js 22+
- OpenClaw 2026.3.x+

### Checklist

- [x] Published on npmjs
- [x] Source code on public GitHub
- [x] README with setup/usage docs
- [x] SKILL.md for agent integration
- [x] Issue tracker enabled
- [x] MIT licensed

## Steps to Submit

1. First: `npm publish` (publish to npmjs)
2. Then: Open PR at https://github.com/openclaw/openclaw
   - Edit the community plugins documentation page
   - Add the plugin entry above
   - Include the PR body above

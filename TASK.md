# Qmemory Enhancement Task — Context Engineering Features

## Background
Qmemory is an OpenClaw context-engine plugin that provides graph-based memory for AI agents.
It uses SurrealDB for storage and integrates deeply with OpenClaw's plugin lifecycle.

Read the existing code thoroughly before making changes:
- `src/openclaw/engine.ts` — Context engine (bootstrap, ingest, assemble, compact, afterTurn)
- `src/openclaw/index.ts` — Plugin entry point (tool registration, hooks)
- `src/openclaw/linker.ts` — Background linker service
- `src/core/` — Core functions (search, save, dedup, extract, recall, correct, link, person)
- `src/config.ts` — Types and configuration
- `schema/qmemory.surql` — SurrealDB schema

## Key Constraint
OpenClaw provides hooks that we MUST use instead of reinventing:
- `after_tool_call` — fires after every tool call with {toolName, params, result, durationMs}
- `tool_result_persist` — can modify the message before it's written to transcript
- `before_tool_call` — fires before tool calls
- `afterTurn()` — engine lifecycle method, called after agent responds

Register hooks via `api.on('hook_name', handler)` in `src/openclaw/index.ts`.

## Features to Implement (each as a separate git commit)

### Commit 1: Schema additions for tool_call, scratchpad, metrics tables

Add to `schema/qmemory.surql`:

```surql
-- Tool call ledger
DEFINE TABLE IF NOT EXISTS tool_call SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS session      ON tool_call TYPE record<session>;
DEFINE FIELD IF NOT EXISTS tool_name    ON tool_call TYPE string;
DEFINE FIELD IF NOT EXISTS input_summary  ON tool_call TYPE string;
DEFINE FIELD IF NOT EXISTS output_summary ON tool_call TYPE string;
DEFINE FIELD IF NOT EXISTS duration_ms    ON tool_call TYPE option<int>;
DEFINE FIELD IF NOT EXISTS token_count    ON tool_call TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS created_at     ON tool_call TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_tool_call_session ON tool_call FIELDS session;
DEFINE INDEX IF NOT EXISTS idx_tool_call_name ON tool_call FIELDS tool_name;

-- Session scratchpad (working memory)
DEFINE TABLE IF NOT EXISTS scratchpad SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS session      ON scratchpad TYPE record<session>;
DEFINE FIELD IF NOT EXISTS task_progress ON scratchpad TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS key_findings  ON scratchpad TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS open_questions ON scratchpad TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS tool_summary  ON scratchpad TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS updated_at    ON scratchpad TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_scratchpad_session ON scratchpad FIELDS session UNIQUE;

-- Metrics tracking
DEFINE TABLE IF NOT EXISTS metrics SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS session      ON metrics TYPE record<session>;
DEFINE FIELD IF NOT EXISTS event_type   ON metrics TYPE string;
DEFINE FIELD IF NOT EXISTS event_data   ON metrics TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at   ON metrics TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_metrics_session ON metrics FIELDS session;
DEFINE INDEX IF NOT EXISTS idx_metrics_type ON metrics FIELDS event_type;
```

Also add TypeScript types to `src/config.ts`.

### Commit 2: Tool Ledger — capture and inject tool call history

**What:** Every tool call gets logged to the `tool_call` table. The ledger is injected into assemble() context.

**Implementation in `src/openclaw/index.ts`:**
Register an `after_tool_call` hook that:
1. Compresses `params` to a short input_summary (max 100 chars)
2. Compresses `result` to a short output_summary (max 200 chars) — extract key info only
3. Saves to `tool_call` table with the current session ID
4. Does NOT use subagentRunner for compression — use simple rule-based compression (extract first N chars, remove JSON noise, keep essential values)

**Implementation in `src/openclaw/engine.ts` assemble():**
1. Query last 20 tool calls for the current session
2. Format as a compact ledger:
```
## Recent Tool Calls
| Tool | Input | Output | Time |
|------|-------|--------|------|
| remindctl | today | 3 tasks due | 2s ago |
```
3. Inject BEFORE the memories section in systemPromptAddition
4. Budget: max 5% of memory budget for tool ledger

**Important:** The hook handler needs access to `currentSessionId` from the engine. 
Pass it via a shared state object or closure. The engine already tracks `currentSessionId`.

Create a new file `src/openclaw/hooks.ts` for all hook handlers to keep index.ts clean.

### Commit 3: Tool Result Compression — compress before persistence

**What:** Large tool results get compressed before entering the context window.

**Implementation in `src/openclaw/index.ts`:**
Register a `tool_result_persist` hook that:
1. Checks the message's tool result content size (estimated tokens)
2. If > 500 tokens, compress it:
   - For JSON results: extract top-level keys, first N items of arrays, drop metadata
   - For text results: take first 200 chars + last 100 chars with "..." in between
   - For error results: keep full error message (they're usually short)
3. Return the modified message
4. Log the compression ratio

**Rules:**
- NEVER compress qmemory_* tool results (our own tools)
- NEVER compress results < 500 tokens
- Add `[compressed from {original_tokens} tokens]` marker
- Keep the original tool_call_id intact

### Commit 4: Multi-stage compaction

**What:** Instead of one compaction trigger, use graduated stages.

**Modify `src/openclaw/engine.ts` afterTurn():**

```
const usageRatio = currentTokenCount / tokenBudget;

if (usageRatio > 0.95) {
  // STAGE 4: Emergency — full checkpoint
  // Extract ALL memories, clear everything, inject fresh state
  logger.warn("Emergency compaction at 95%+");
  // ... full extraction + minimal state re-injection
  
} else if (usageRatio > 0.85) {
  // STAGE 3: Heavy — compress scratchpad + clear old tool results
  logger.info("Heavy compaction at 85%+");
  // ... clear tool_call records older than 10 turns
  // ... compress scratchpad to essentials
  
} else if (usageRatio > 0.7) {
  // STAGE 2: Medium — existing pre-compaction flush
  // (already implemented)
  
} else if (usageRatio > 0.5) {
  // STAGE 1: Light — summarize old turns
  logger.debug("Light compaction at 50%+");
  // ... summarize turns older than 15
}
```

**Important:** The existing pre-compaction flush at 70% stays. We ADD stages around it.

Also modify `compact()` to be aware of stages — if called at 50% vs 95%, behave differently.

### Commit 5: Session Scratchpad — working memory

**What:** A per-session JSON record that tracks current task state.

**New file: `src/core/scratchpad.ts`:**
```typescript
export async function getScratchpad(sessionId: string): Promise<Scratchpad | null>
export async function updateScratchpad(sessionId: string, updates: Partial<Scratchpad>): Promise<void>
export async function clearScratchpad(sessionId: string): Promise<void>
```

**Modify `src/openclaw/engine.ts`:**

In `afterTurn()`:
1. If subagentRunner available, ask it to extract from the last assistant message:
   - Any task progress updates
   - Key findings or data points
   - Open questions
2. Upsert the scratchpad record
3. Only do this if the conversation has > 5 turns (skip trivial chats)

In `assemble()`:
1. Query the scratchpad for current session
2. If non-empty, inject as "Working Memory" section AFTER memories
3. Budget: max 3% of memory budget

### Commit 6: Metrics tracking

**What:** Track key performance metrics for analysis.

**New file: `src/core/metrics.ts`:**
```typescript
export async function trackEvent(sessionId: string, eventType: string, data?: string): Promise<void>
export async function getSessionMetrics(sessionId: string): Promise<MetricsSummary>
```

**Event types to track:**
- `recall_hit` — memory recall returned results (data: count)
- `recall_miss` — memory recall returned 0 results  
- `dedup_add` — new memory added
- `dedup_update` — existing memory updated
- `dedup_noop` — duplicate detected, skipped
- `tool_call` — tool was called (data: tool name)
- `compaction` — compaction triggered (data: stage number)
- `extraction` — facts extracted (data: count)

**Integration points:**
- In `src/core/save.ts` after dedup decision → track dedup_*
- In `src/openclaw/engine.ts` assemble() after recall → track recall_hit/miss
- In `src/openclaw/engine.ts` compact() → track compaction
- In hooks (after_tool_call) → track tool_call

**Keep it lightweight:** fire-and-forget, no awaiting in hot paths, catch and ignore errors.

## General Rules

1. **TypeScript strict** — no `any` types unless wrapping external API
2. **Each commit must build** — run `npx tsc --noEmit` after each change
3. **No new dependencies** — use what's already available
4. **Preserve existing behavior** — all changes are additive
5. **Error handling** — all new code must have try/catch, non-fatal failures
6. **Logging** — use the existing logger pattern (debug for routine, info for significant, warn for problems)
7. **Don't modify tool definitions** — existing tools stay exactly as they are
8. **Budget awareness** — all injections into assemble() respect token budgets
9. **Session isolation** — everything is scoped to currentSessionId
10. **Git commits** — one commit per feature, descriptive message:
    - `feat(schema): add tool_call, scratchpad, and metrics tables`
    - `feat(ledger): track and inject tool call history via after_tool_call hook`
    - `feat(compress): compress large tool results via tool_result_persist hook`
    - `feat(compaction): implement multi-stage graduated compaction`
    - `feat(scratchpad): add per-session working memory`
    - `feat(metrics): add lightweight event tracking`

## How to Test

After all changes, run:
```bash
npx tsc --noEmit  # Must pass
```

The plugin will be tested by restarting OpenClaw gateway and checking logs.

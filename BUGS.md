# Qmemory 0.1.3 — Bugs & Issues Found During Live Testing

## Environment
- OpenClaw gateway running on macOS (LaunchAgent)
- Plugin installed at: `~/.openclaw/extensions/qmemory/`
- SurrealDB at `ws://localhost:8000` (namespace: qmemory, database: main)
- Plugin version: 0.1.3 (built from ~/dev/Qmemory, copied to extensions)

## Bug 1: Hooks never fire (CRITICAL)

**Symptom:** `api.on("after_tool_call", ...)` and `api.on("tool_result_persist", ...)` are called during plugin registration, but the hooks never actually fire when tools are used.

**Evidence:**
- `tool_call` table in SurrealDB has 0 records after multiple tool calls
- No "Tool ledger:" log lines appear in gateway.log after tool usage
- No "Compressed" log lines for large tool results
- The "Hooks registered" info log (added explicitly) never appears in gateway.log

**Likely cause:** The plugin's `register()` function runs, but `api.on()` may not work as expected from within a context-engine plugin. Possible issues:
1. `api.on()` may need to be called in `activate()` instead of `register()`
2. The hook registration may be silently failing (no error thrown)
3. The hooks may fire but the handler crashes silently before logging

**How to diagnose:**
1. Add try/catch + `console.error()` around `api.on()` calls to see if they throw
2. Check if OpenClaw has a different hook registration path for context-engine plugins
3. Check if `register()` vs `activate()` matters for hook registration timing
4. Look at how other OpenClaw plugins register hooks (e.g., bundled plugins)

**Files:** `src/openclaw/index.ts` lines 146-149

---

## Bug 2: BM25 search receives `[object Object]` instead of text (FIXED in 0.1.3)

**Symptom:** In version 0.1.1, the `assemble()` method passes message objects to BM25 search, resulting in:
```
Search: BM25 query="[object Object] [object Object]..."
```

**Fix:** Added `extractText()` helper in engine.ts that properly extracts text from both string content and `{type: "text", text: "..."}` content block arrays.

**Status:** ✅ Fixed in 0.1.3 — confirmed in logs: `Search: BM25 query="test tool ledger"`

---

## Bug 3: Recall returns 0 memories after gateway restart

**Symptom:** After restarting the gateway, recall returns 0 memories:
```
Recall tier 1 (graph): 0 memories
Recall tier 4 (recent): 0 memories  
Recall merged: 0 unique memories
```

**Likely cause:** 
1. Schema re-application may be dropping and recreating tables (IF NOT EXISTS should prevent this — verify)
2. SurrealDB connection may be pointing to a different namespace/database after restart
3. The `surrealkv://` storage may have been corrupted during unclean shutdown

**How to diagnose:**
1. Query SurrealDB directly after restart: `SELECT count() FROM memory GROUP ALL`
2. Check if the data file exists: `~/.qmemory/data.db`
3. Check if SurrealDB process restarted with correct parameters

---

## Bug 4: `conversationContext` extraction from messages — type mismatch

**Symptom:** OpenClaw's `AgentMessage` has `content` as either `string` or `ContentBlock[]` (array of `{type: "text", text: "..."}` objects). The old code assumed string-only.

**Fix:** The `extractText()` helper handles both cases. BUT — the messages passed to `assemble()` come from OpenClaw's internal format which may vary by provider (Anthropic uses content blocks, OpenAI uses strings).

**Risk:** If a new provider format appears, extractText() may return empty strings silently.

**Recommendation:** Add a debug log when extractText returns empty for non-empty input.

---

## Bug 5: SharedEngineState not updating from engine to hooks

**Symptom (suspected):** The `sharedState.currentSessionId` may be null when hooks fire, because:
1. `bootstrap()` sets `currentSessionId` on the engine's closure variable
2. The hooks read from `sharedState.currentSessionId`
3. These are connected via the same object reference — BUT only if `engine.ts` writes to `sharedState.currentSessionId`, not to its own local `currentSessionId`

**How to verify:**
1. Check if `engine.ts` bootstrap() writes to `sharedState.currentSessionId` or to a local variable
2. Add logging at the start of the after_tool_call handler: `logger.info(\`Hook fired, sessionId: ${sharedState.currentSessionId}\`)`

**Files:** 
- `src/openclaw/engine.ts` — look for where `currentSessionId` is set
- `src/openclaw/hooks.ts` — reads `sharedState.currentSessionId`
- `src/openclaw/index.ts` — creates `sharedState` and passes to both

---

## Bug 6: Multiple `Disposing Qmemory engine` log entries

**Symptom:** Gateway log shows repeated "Disposing Qmemory engine" entries, suggesting the engine is being created and destroyed multiple times per session. This is unusual — engine should be created once and reused.

**Evidence:**
```
19:21:26.449 Disposing Qmemory engine
19:21:31.104 Disposing Qmemory engine  
19:21:33.441 Disposing Qmemory engine
```

**Possible cause:** Each agent run creates a new engine instance, or the gateway restart creates multiple competing instances.

---

## Priority Order

1. **Bug 1 (Hooks)** — blocks tool ledger + compression features entirely
2. **Bug 5 (SharedState)** — may be root cause of Bug 1
3. **Bug 3 (Recall 0)** — data loss after restart
4. **Bug 6 (Multiple dispose)** — indicates lifecycle issue
5. **Bug 4 (extractText)** — add safety logging

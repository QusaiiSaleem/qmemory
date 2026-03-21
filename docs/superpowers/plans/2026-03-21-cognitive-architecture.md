# Cognitive Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Qmemory from a fact store to a full cognitive architecture with evidence-based memory, agent self-model, biological salience decay, and discovery mode.

**Architecture:** Three mental models (World, User, Self) built on an evidence layer (source_person, confidence, evidence_type). Background services upgraded from 2 jobs to 5 (patterns, contradictions, compressions, ghost entities, self-learnings). Biological recall-based salience boosting replaces flat time decay.

**Tech Stack:** SurrealDB 3.0 (graph + fulltext + vector), TypeScript, OpenClaw plugin API, FastMCP (Zod schemas)

**Spec:** `docs/superpowers/specs/2026-03-21-cognitive-architecture-design.md`

---

## File Map

| File | Responsibility | Tasks |
|------|---------------|-------|
| `schema/qmemory.surql` | DB schema — new fields + indexes | 1 |
| `src/config.ts` | Types, categories, formatMemories() | **1, 2, 6** (touched 3 times) |
| `src/core/extract.ts` | Extract prompt + parsing | 2 |
| `src/core/dedup.ts` | Dedup prompt + signature | 3 |
| `src/core/save.ts` | Save with evidence fields — **2 CREATE paths** (ADD + UPDATE) | 4 |
| `src/openclaw/engine.ts` | assemble() + discovery mode + recall boost + **5 extract callers** | 5, 6 |
| `src/openclaw/linker.ts` | Reflect prompt (5 jobs) + smart decay + handlers | 7, 8, 11 |
| `src/openclaw/index.ts` | AGENT_SYSTEM_CONTEXT + tool descriptions + save params | 9 |
| `src/mcp/server.ts` | MCP save tool Zod schema + descriptions + **category enum** | 10 |
| `CLAUDE.md` | Documentation | 12 |

---

### Task 1: Schema — Add Evidence Fields to Memory Table

**Files:**
- Modify: `schema/qmemory.surql:52-76`
- Modify: `src/config.ts` (Memory interface, MEMORY_CATEGORIES)

- [ ] **Step 1: Add new fields to schema**

In `schema/qmemory.surql`, after the existing `linked` field definition, add:

```sql
DEFINE FIELD IF NOT EXISTS source_person  ON memory TYPE option<record<entity>>;
DEFINE FIELD IF NOT EXISTS evidence_type  ON memory TYPE string         DEFAULT "observed";
DEFINE FIELD IF NOT EXISTS recall_count   ON memory TYPE int            DEFAULT 0;
DEFINE FIELD IF NOT EXISTS last_recalled  ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS context_mood   ON memory TYPE option<string>;
```

After the existing indexes, add:

```sql
DEFINE INDEX IF NOT EXISTS idx_memory_evidence_type ON memory FIELDS evidence_type;
DEFINE INDEX IF NOT EXISTS idx_memory_recall_count  ON memory FIELDS recall_count;
DEFINE INDEX IF NOT EXISTS idx_memory_source_person ON memory FIELDS source_person;
```

- [ ] **Step 2: Update Memory interface in config.ts**

Add after `linked: boolean;`:

```typescript
source_person?: string;   // record<entity> FK — who said this
evidence_type: string;    // "observed" | "reported" | "inferred" | "self"
recall_count: number;     // Biological memory counter
last_recalled?: string;   // datetime of last recall
context_mood?: string;    // "calm_decision" | "heated_discussion" | "brainstorm" | "correction" | "casual" | "urgent"
```

- [ ] **Step 3: Add "self" to MEMORY_CATEGORIES**

Change the array to include `"self"` as the 8th category:

```typescript
export const MEMORY_CATEGORIES = [
  "style", "preference", "context", "decision",
  "idea", "feedback", "domain", "self",
] as const;
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compile. All existing code unaffected (new fields have defaults).

- [ ] **Step 5: Commit**

```bash
git add schema/qmemory.surql src/config.ts
git commit -m "feat: evidence layer schema — source_person, evidence_type, recall_count, context_mood, self category"
```

---

### Task 2: Extract Prompt — Rich Evidence Extraction + Self-Learning

**Files:**
- Modify: `src/core/extract.ts` (prompt rewrite + ExtractedFact interface + parseExtractedFacts)
- Modify: `src/config.ts` (ExtractedFact interface if defined here)

- [ ] **Step 1: Update ExtractedFact interface**

In `config.ts`, add new optional fields to `ExtractedFact`:

```typescript
export interface ExtractedFact {
  content: string;
  category: MemoryCategory;
  salience: number;
  scope: string;
  confidence?: number;
  source_person?: string;
  evidence_type?: string;
  context_mood?: string;
  entities?: Array<string | ExtractedEntityRef>;
}
```

- [ ] **Step 2: Rewrite the extraction prompt**

In `extract.ts`, replace the entire `prompt` string (lines 90-128) with the new prompt from the spec (Phase 2). The prompt must:
- Extract three knowledge types (world, user, self)
- Include source_person, confidence, evidence_type, context_mood in output schema
- Include SELF-LEARNING signals section
- Include `${discoveryModeSection}` placeholder (empty string for now)

- [ ] **Step 3: Add discoveryMode parameter**

Update `extractMemories()` signature:

```typescript
export async function extractMemories(
  messages: Message[],
  subagentRunner?: SubagentRunner,
  options?: { discoveryMode?: boolean },
): Promise<ExtractedFact[]>
```

Build the discovery mode section:

```typescript
const discoveryModeSection = options?.discoveryMode
  ? `DISCOVERY MODE — This is a new relationship. Extract AGGRESSIVELY:
- User's name, role, responsibilities, organization
- Projects they work on, tools they use daily
- Communication style (formal/casual, which language for what)
- People they mention and those people's roles/relationships
- Preferences about how the agent should behave
- Any corrections or feedback → save as category "self"
- Patterns in how they ask questions or give instructions

Use HIGHER salience than normal: 0.6+ for identity facts, 0.8+ for preferences.
Every piece of identity information matters in a new relationship.`
  : "";
```

- [ ] **Step 4: Update parseExtractedFacts()**

In the fact-building loop (around line 195), preserve the new fields:

```typescript
facts.push({
  content: String(item.content).trim(),
  category,
  salience,
  scope: typeof item.scope === "string" ? item.scope : "global",
  confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : undefined,
  source_person: typeof item.source_person === "string" ? item.source_person : undefined,
  evidence_type: typeof item.evidence_type === "string" ? item.evidence_type : undefined,
  context_mood: typeof item.context_mood === "string" ? item.context_mood : undefined,
  entities: Array.isArray(item.entities) ? item.entities : undefined,
});
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/core/extract.ts src/config.ts
git commit -m "feat: extract prompt rewrite — evidence fields, self-learning, discovery mode"
```

---

### Task 3: Dedup — Evidence-Aware Deduplication

**Files:**
- Modify: `src/core/dedup.ts` (prompt update + signature change)

- [ ] **Step 1: Update dedup() signature**

Add optional `context` parameter:

```typescript
export async function dedup(
  newFact: string,
  existingMemories: Memory[],
  subagentRunner?: SubagentRunner,
  context?: {
    category?: string;
    confidence?: number;
    source_person?: string;
    evidence_type?: string;
  },
): Promise<DedupDecision>
```

Also update the inner `llmDedup()` function signature:

```typescript
async function llmDedup(
  newFact: string,
  existingMemories: Memory[],
  subagentRunner: SubagentRunner,
  context?: { category?: string; confidence?: number; source_person?: string; evidence_type?: string },
): Promise<DedupDecision>
```

- [ ] **Step 2: Update LLM dedup prompt**

Add evidence-awareness rules to the prompt:

```
IMPORTANT RULES:
- A hypothesis (confidence < 0.5) should NEVER auto-replace a confirmed fact
- Two memories from DIFFERENT sources are not duplicates even if similar —
  they are corroborating evidence (use "supports" relationship)
- A "self" category memory is NEVER a duplicate of a "context" memory

NEW FACT:
"${newFact}" [category: ${context?.category ?? "unknown"}, confidence: ${context?.confidence ?? "0.8"}, source: ${context?.source_person ?? "unknown"}]
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile. Callers of `dedup()` unaffected (new param is optional).

- [ ] **Step 4: Commit**

```bash
git add src/core/dedup.ts
git commit -m "feat: evidence-aware dedup — hypothesis protection, multi-source corroboration"
```

---

### Task 4: Save — Evidence Fields + Source Person Resolution

**Files:**
- Modify: `src/core/save.ts` (SaveParams + source_person resolution + CREATE query)

- [ ] **Step 1: Update SaveParams interface**

Add new fields:

```typescript
export interface SaveParams {
  content: string;
  category: MemoryCategory;
  salience?: number;
  scope?: string;
  source_type?: string;
  sessionId?: string;
  source_person?: string;    // Person name — resolved to entity record link
  evidence_type?: string;    // "observed" | "reported" | "inferred" | "self"
  confidence?: number;       // 0.0-1.0
  context_mood?: string;     // Situational context
}
```

- [ ] **Step 2: Add source_person resolution logic**

Before the dedup call in `saveMemory()`, resolve the person name to an entity:

```typescript
let sourcePersonRef: string | undefined;
if (params.source_person) {
  const person = await query<{ id: string }>(
    `SELECT id FROM entity WHERE type = "person"
     AND (string::lowercase(name) = string::lowercase($name)
       OR $name IN aliases) LIMIT 1`,
    { name: params.source_person },
  );
  if (person?.[0]?.id) {
    sourcePersonRef = String(person[0].id);
  }
}
```

- [ ] **Step 3: Pass context to dedup()**

Update the dedup call to include evidence context:

```typescript
const decision = await dedup(params.content, candidates, subagentRunner, {
  category: params.category,
  confidence: params.confidence,
  source_person: params.source_person,
  evidence_type: params.evidence_type,
});
```

- [ ] **Step 4: Update BOTH CREATE queries to include evidence fields**

**IMPORTANT:** save.ts has TWO separate CREATE queries that both need updating:
- **UPDATE path** (~line 121-143): Creates new memory WITH `prev_version` field
- **ADD path** (~line 171-192): Creates brand new memory WITHOUT `prev_version`

Build the optional evidence fields once, then inject into BOTH queries:

```typescript
// Build evidence fields (shared by ADD and UPDATE paths)
const evidenceFields: string[] = [];
const evidenceParams: Record<string, unknown> = {};
if (sourcePersonRef) {
  evidenceFields.push("source_person: type::record($sourcePerson),");
  evidenceParams.sourcePerson = sourcePersonRef;
}
if (params.evidence_type) {
  evidenceFields.push("evidence_type: $evidenceType,");
  evidenceParams.evidenceType = params.evidence_type;
}
if (params.context_mood) {
  evidenceFields.push("context_mood: $contextMood,");
  evidenceParams.contextMood = params.context_mood;
}
if (params.confidence !== undefined) {
  evidenceParams.confidence = params.confidence; // Override default 0.8
}
```

In the UPDATE path CREATE query (~line 122), inject `${evidenceFields.join("\n")}` inside CONTENT and merge `evidenceParams` into the query params.

In the ADD path CREATE query (~line 172), inject the same `${evidenceFields.join("\n")}` and merge the same `evidenceParams`.

**Verification:** After editing, search save.ts for `CREATE type::record` — there should be exactly 2 occurrences, both containing the `${evidenceFields}` injection.

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/core/save.ts
git commit -m "feat: save with evidence — source_person resolution, confidence, evidence_type, context_mood"
```

---

### Task 5: Engine — Extract Caller Passes Evidence Fields

**Files:**
- Modify: `src/openclaw/engine.ts` (afterTurn + compact callers)

- [ ] **Step 1: Add isDiscoveryMode engine state**

In `createEngine()`, add alongside existing state variables:

```typescript
let isDiscoveryMode = false;
```

- [ ] **Step 2: Set discovery mode in bootstrap()**

After the existing memory count check, add:

```typescript
const firstMemoryResult = await query<{ created_at: string }>(
  "SELECT created_at FROM memory ORDER BY created_at ASC LIMIT 1",
);
const firstMemoryDate = firstMemoryResult?.[0]?.created_at;
isDiscoveryMode = !firstMemoryDate ||
  (Date.now() - new Date(firstMemoryDate).getTime()) < 72 * 60 * 60 * 1000;

if (isDiscoveryMode) {
  logger.info("Discovery Mode active — aggressive extraction enabled");
}
```

- [ ] **Step 3: Pass discoveryMode to extractMemories() — ALL 5 CALL SITES**

engine.ts calls `extractMemories()` in **5 places**. Update ALL of them:

1. `compact()` method (~line 887)
2. `afterTurn()` Stage 4 — emergency (~line 1043)
3. `afterTurn()` Stage 3 — heavy (~line 1108)
4. `afterTurn()` Stage 2 — medium (~line 1143)
5. `afterTurn()` Stage 1 — light (~line 1172)

For each, add the options parameter:

```typescript
const facts = await extractMemories(messagesToExtract, subagentRunner, {
  discoveryMode: isDiscoveryMode,
});
```

**Verification:** After editing, search engine.ts for `extractMemories(` — there should be exactly 5 occurrences, all with `{ discoveryMode: isDiscoveryMode }`.

- [ ] **Step 4: Pass evidence fields from extracted facts to saveMemory() — ALL 5 SAVE LOOPS**

Each of the 5 `extractMemories()` call sites is followed by a loop that calls `saveMemory()`. Update ALL 5 loops from:

```typescript
await saveMemory({ content, category, salience, scope, source_type: "conversation" }, ...);
```

To:

```typescript
await saveMemory({
  content: fact.content,
  category: fact.category,
  salience: fact.salience,
  scope: fact.scope,
  source_type: "conversation",
  source_person: fact.source_person,
  evidence_type: fact.evidence_type,
  confidence: fact.confidence,
  context_mood: fact.context_mood,
}, subagentRunner, embeddingConfig);
```

**Verification:** After editing, search engine.ts for `saveMemory({` — each occurrence inside extract loops should include `source_person`, `evidence_type`, `confidence`, `context_mood`.

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/openclaw/engine.ts
git commit -m "feat: engine passes evidence fields through extract→save pipeline + discovery mode detection"
```

---

### Task 6: Assemble — Self-Model First + Contradiction Markers + Recall Boost

**Files:**
- Modify: `src/openclaw/engine.ts` (assemble method)
- Modify: `src/config.ts` (formatMemories rewrite)

- [ ] **Step 1: Update RecalledMemory interface**

In `config.ts`, add to RecalledMemory:

```typescript
export interface RecalledMemory extends Memory {
  score?: number;
  source_session?: string;
  is_contradicted?: boolean;  // NEW — flagged by assemble()
}
```

- [ ] **Step 2: Fetch contradictions in assemble()**

After recall queries in `assemble()`, add:

```typescript
const recalledIds = allRecalled.map(m => String(m.id));
const contradictions = await query<{ in: string; out: string }>(
  `SELECT in, out FROM relates WHERE type = "contradicts"
   AND (in IN $ids OR out IN $ids)`,
  { ids: recalledIds },
);
const contradictedIds = new Set<string>();
for (const c of contradictions ?? []) {
  contradictedIds.add(String(c.in));
  contradictedIds.add(String(c.out));
}
const enriched = allRecalled.map(m => ({
  ...m,
  is_contradicted: contradictedIds.has(String(m.id)),
}));
```

- [ ] **Step 3: Add recall-based salience boost**

After recall deduplication, fire-and-forget boost:

```typescript
const finalIds = [...new Set(enriched.map(m => String(m.id)))];
if (finalIds.length > 0) {
  query(
    `UPDATE memory SET recall_count += 1, last_recalled = time::now(),
       salience = math::min(salience + 0.05, 1.0)
     WHERE id IN $ids`,
    { ids: finalIds },
  ).catch(() => {});
}
```

- [ ] **Step 4: Inject discovery mode nudge**

At the end of systemPromptAddition building, add:

```typescript
if (isDiscoveryMode) {
  sections.push(
    "",
    "### Discovery Mode Active",
    "You are in discovery mode (first 72 hours). Learn aggressively:",
    "- Save every person, project, preference you encounter",
    "- When corrected, save BOTH the correction AND what you learned about yourself",
    "- Prefer higher salience (0.6+) for identity facts",
  );
}
```

- [ ] **Step 5: Rewrite formatMemories()**

In `config.ts`, rewrite `formatMemories()` to:

1. Separate self-model memories (category === "self") into their own section at the top
2. Separate hypotheses (confidence defined and < 0.5) into their own section
3. Add evidence markers to each memory line:
   - Source person: `— Qusai reported` (when evidence_type is "reported")
   - Confidence: `⚑0.8` (when < 1.0)
   - Contradiction: `⚠︎` prefix (when is_contradicted)
   - Recall count: `4× recalled` (for self memories with recall_count > 1)

The function signature stays the same: `formatMemories(memories: RecalledMemory[], includeToolsGuide?: boolean): string`

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/openclaw/engine.ts src/config.ts
git commit -m "feat: assemble rewrite — self-model first, contradiction markers, recall boost, discovery nudge"
```

---

### Task 7: Reflect — 5-Job Background Thinking

**Files:**
- Modify: `src/openclaw/linker.ts` (reflect prompt + handler + smart decay)

- [ ] **Step 1: Rewrite the Reflect prompt**

Replace the Reflect prompt (currently ~20 lines) with the full 5-job prompt from the spec (Phase 3 — patterns, contradictions, compressions, ghost_entities, self_learnings).

- [ ] **Step 2: Update the Reflect response parser**

Update the `analysis` type:

```typescript
let analysis: {
  patterns: Array<{ content: string; based_on: string[]; category: string; salience: number }>;
  contradictions: Array<{ memory_a: string; memory_b: string; person_a?: string; person_b?: string; explanation: string }>;
  compressions: Array<{ merge_ids: string[]; into: string; category: string }>;
  ghost_entities: Array<{ name: string; type: string; mentioned_in: string[]; mentioned_count: number }>;
  self_learnings: Array<{ content: string; evidence: string; salience: number }>;
} = { patterns: [], contradictions: [], compressions: [], ghost_entities: [], self_learnings: [] };
```

- [ ] **Step 3: Handle patterns (save as reflect memories)**

```typescript
for (const pattern of analysis.patterns ?? []) {
  const result = await saveMemory({
    content: pattern.content,
    category: pattern.category as MemoryCategory,
    salience: pattern.salience ?? 0.7,
    scope: "global",
    source_type: "reflect",
    evidence_type: "inferred",
  }, subagentRunner);
  // Link pattern to source memories
  if (result?.memory_id) {
    for (const sourceId of pattern.based_on ?? []) {
      if (!validIds.includes(sourceId)) continue;
      await query(/* RELATE synthesized_from */);
    }
  }
}
```

- [ ] **Step 4: Handle contradictions (flag both, don't auto-delete)**

Replace the old auto-delete logic with:

```typescript
for (const c of analysis.contradictions ?? []) {
  if (!validIds.includes(c.memory_a) || !validIds.includes(c.memory_b)) continue;
  // Create contradicts edge (both memories stay active)
  await query(
    `LET $f = type::record($from); LET $t = type::record($to);
     RELATE $f->relates->$t CONTENT {
       type: "contradicts", reason: $reason,
       confidence: 0.8, created_by: "reflect", created_at: time::now()
     };`,
    { from: c.memory_b, to: c.memory_a, reason: c.explanation },
  );
  logger.info(`Reflect: flagged contradiction between ${c.memory_a} and ${c.memory_b}`);
}
```

- [ ] **Step 5: Handle compressions (merge old → principle)**

```typescript
for (const comp of analysis.compressions ?? []) {
  // Only compress original memories, not reflect outputs
  const validMergeIds = comp.merge_ids.filter(id =>
    validIds.includes(id) &&
    recentMemories.find(m => String(m.id) === id)?.source_type !== "reflect"
  );
  if (validMergeIds.length < 2) continue;

  // Create the principle memory
  const result = await saveMemory({
    content: comp.into,
    category: (comp.category || "self") as MemoryCategory,
    salience: 0.7,
    scope: "global",
    source_type: "reflect",
    evidence_type: "inferred",
  }, subagentRunner);

  // Soft-delete merged memories + link
  if (result?.memory_id) {
    for (const id of validMergeIds) {
      await query(`UPDATE type::record($id) SET is_active = false, updated_at = time::now()`, { id });
      await query(/* RELATE synthesized_from */);
    }
  }
}
```

- [ ] **Step 6: Handle ghost entities (UPSERT)**

```typescript
for (const ghost of analysis.ghost_entities ?? []) {
  await query(
    `UPSERT entity SET name = $name, type = $type,
       updated_at = time::now(), created_at = created_at ?? time::now()
     WHERE name = $name AND type = $type`,
    { name: ghost.name, type: ghost.type },
  );
  logger.info(`Reflect: created ghost entity "${ghost.name}" (${ghost.type})`);
}
```

- [ ] **Step 7: Handle self-learnings**

```typescript
for (const learning of analysis.self_learnings ?? []) {
  await saveMemory({
    content: learning.content,
    category: "self",
    salience: learning.salience ?? 0.7,
    scope: "global",
    source_type: "reflect",
    evidence_type: "self",
  }, subagentRunner);
}
```

- [ ] **Step 8: Rewrite smart salience decay**

Replace the existing `runSalienceDecay()` with the 3-tier biological decay from the spec:
- Tier 1: Never recalled + old (> 7d) → ×0.90
- Tier 2: Recalled but stale (last_recalled > 14d) → ×0.98
- Tier 3: Recalled 5+ times → never below 0.5 (cemented)

- [ ] **Step 9: Exclude reflect outputs from Reflect query**

Change the Reflect memory query to:

```sql
SELECT * FROM memory
WHERE is_active = true AND source_type != "reflect"
ORDER BY created_at DESC LIMIT 30
```

- [ ] **Step 10: Build and verify**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 11: Commit**

```bash
git add src/openclaw/linker.ts
git commit -m "feat: reflect 5-job brain — patterns, contradictions (no auto-delete), compressions, ghosts, soul learning"
```

---

### Task 8: Linker Prompt — Enhanced Relationship Types

**Files:**
- Modify: `src/openclaw/linker.ts` (linker prompt only)

- [ ] **Step 1: Update the Linker prompt**

Replace the Linker prompt with the enhanced version from spec Phase 8. Key additions:
- Expanded relationship types list
- Rules about multi-source corroboration
- Guidance on hypothesis-to-evidence linking

- [ ] **Step 2: Include source_person in memory list**

Change the unlinked/candidate memory formatting to include evidence fields:

```typescript
const unlinkedList = unlinked
  .map((m) => `  ${m.id}: "${m.content}" [${m.category}, ${m.evidence_type ?? "observed"}, source: ${m.source_person ?? "system"}]`)
  .join("\n");
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/openclaw/linker.ts
git commit -m "feat: linker prompt — enhanced relationship types, evidence-aware matching"
```

---

### Task 9: AGENT_SYSTEM_CONTEXT + Tool Descriptions Rewrite

> **Reference:** Follow Anthropic's tool design guidelines (https://www.anthropic.com/engineering/writing-tools-for-agents):
> clear names, detailed descriptions (WHY + WHEN TO USE + WHEN NOT TO USE), typed params with descriptions, usage examples, return docs.

**Files:**
- Modify: `src/openclaw/index.ts` (AGENT_SYSTEM_CONTEXT + all 6 tool descriptions + save tool params)

- [ ] **Step 1: Replace AGENT_SYSTEM_CONTEXT**

Replace the entire `AGENT_SYSTEM_CONTEXT` constant (lines 51-116) with the new version from spec Phase 7. This is the agent's "soul instruction" — cached, no per-turn cost.

- [ ] **Step 2: Rewrite qmemory_save tool description + add params**

Replace the description string with the new version from spec Phase 7 (qmemory_save section).

Add new TypeBox parameters:

```typescript
source_person: Type.Optional(Type.String({
  description: "Who said/reported this? Person name (resolved to entity automatically)"
})),
evidence_type: Type.Optional(Type.String({
  description: '"observed" (saw it), "reported" (told), "inferred" (concluded), "self" (introspection)'
})),
confidence: Type.Optional(Type.Number({
  description: "How certain? 0.0-1.0. Use < 0.5 for hypotheses.",
  minimum: 0, maximum: 1
})),
context_mood: Type.Optional(Type.String({
  description: "Situation: calm_decision, heated_discussion, brainstorm, correction, casual, urgent"
})),
```

Update the execute handler to pass new params through to `saveMemory()`.

- [ ] **Step 3: Rewrite remaining 5 tool descriptions**

Replace description strings for qmemory_search, qmemory_correct, qmemory_link, qmemory_person, qmemory_import with the new versions from spec Phase 7.

- [ ] **Step 4: Build and verify**

Run: `npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/openclaw/index.ts
git commit -m "feat: rewrite agent system context + all 6 tool descriptions for cognitive architecture"
```

---

### Task 10: MCP Server — Mirror Evidence Fields

**Files:**
- Modify: `src/mcp/server.ts` (save tool Zod schema + descriptions)

- [ ] **Step 1: Add evidence params to MCP save tool**

Add Zod parameters matching the OpenClaw TypeBox schema:

```typescript
source_person: z.string().optional().describe("Who said this?"),
evidence_type: z.enum(["observed", "reported", "inferred", "self"]).optional(),
confidence: z.number().min(0).max(1).optional().describe("How certain? 0-1"),
context_mood: z.string().optional().describe("Situational context"),
```

- [ ] **Step 2: Add "self" to category Zod enum**

The existing category enum in the MCP save tool does NOT include "self". Update:

```typescript
// OLD:
z.enum(["style", "preference", "context", "decision", "idea", "feedback", "domain"])
// NEW:
z.enum(["style", "preference", "context", "decision", "idea", "feedback", "domain", "self"])
```

Without this, MCP clients cannot save self-model memories — a core feature of the upgrade.

- [ ] **Step 3: Update MCP tool descriptions**

Update the description strings for all MCP tools to match the OpenClaw tool registration descriptions (not AGENT_SYSTEM_CONTEXT, which is OpenClaw-specific).

- [ ] **Step 4: Pass new params in execute handler**

In the MCP save tool execute handler, pass through to `saveMemory()`:

```typescript
source_person: params.source_person,
evidence_type: params.evidence_type,
confidence: params.confidence,
context_mood: params.context_mood,
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: MCP server gains evidence fields + self category — mirrors OpenClaw interface"
```

---

### Task 11: Discovery Mode — 72-Hour Identity Summary

**Files:**
- Modify: `src/openclaw/linker.ts` (one-time identity summary in Reflect)

- [ ] **Step 1: Add identity summary trigger to Reflect**

At the start of `runReflect()`, after the early returns, add:

```typescript
// One-time identity summary after discovery mode ends
const firstMemory = await query<{ created_at: string }>(
  "SELECT created_at FROM memory ORDER BY created_at ASC LIMIT 1",
);
const firstDate = firstMemory?.[0]?.created_at;
const hoursSinceFirst = firstDate
  ? (Date.now() - new Date(firstDate).getTime()) / 3_600_000
  : 0;

if (hoursSinceFirst >= 72 && hoursSinceFirst < 168) {
  // Check if summary already exists
  const existing = await query(
    `SELECT id FROM memory WHERE category = "self"
     AND content ~ "Identity Summary" AND is_active = true LIMIT 1`,
  );
  if (!existing?.length) {
    await runIdentitySummary();
  }
}
```

- [ ] **Step 2: Implement runIdentitySummary()**

```typescript
async function runIdentitySummary(): Promise<void> {
  if (!subagentRunner) return;
  const allMemories = await query<Memory>(
    "SELECT * FROM memory WHERE is_active = true ORDER BY salience DESC LIMIT 50",
  );
  if (!allMemories?.length) return;

  const memList = allMemories.map(m =>
    `  "${m.content}" [${m.category}, salience: ${m.salience}]`
  ).join("\n");

  const prompt = `You are summarizing what the agent has learned about its user and itself
during its first 72 hours. This will be presented to the user for validation.

MEMORIES:
${memList}

Return a JSON object:
{
  "user_summary": "A paragraph describing the user",
  "agent_soul": "A paragraph describing how the agent should behave",
  "confidence": 0.7,
  "gaps": ["Questions still unanswered"]
}`;

  const response = await subagentRunner(prompt);
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const result = JSON.parse(jsonMatch[0]);

    // Save user summary
    await saveMemory({
      content: `[Identity Summary — User] ${result.user_summary}`,
      category: "context",
      salience: 0.9,
      scope: "global",
      source_type: "reflect",
      evidence_type: "inferred",
      confidence: result.confidence ?? 0.7,
    }, subagentRunner);

    // Save agent soul
    await saveMemory({
      content: `[Identity Summary — Agent Soul] ${result.agent_soul}`,
      category: "self",
      salience: 0.95,
      scope: "global",
      source_type: "reflect",
      evidence_type: "self",
    }, subagentRunner);

    logger.info("Reflect: identity summary created after discovery mode");
  } catch (e) {
    logger.warn(`Reflect: identity summary parse failed: ${e}`);
  }
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/openclaw/linker.ts
git commit -m "feat: discovery mode 72h identity summary — user profile + agent soul"
```

---

### Task 12: Documentation + Version Bump + Release

**Files:**
- Modify: `CLAUDE.md`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Update CLAUDE.md**

Update these sections:
- **Memory Fields** table — add source_person, evidence_type, recall_count, last_recalled, context_mood
- **Memory Categories** — mention "self" category
- **Background Services** — Reflect now does 5 jobs
- **Design principles** — add "Memory as evidence, not truth" and "Agent self-model"
- **Context injection** — self-model section injected first

- [ ] **Step 2: Version bump**

```bash
npm version minor  # → 0.3.0
```

- [ ] **Step 3: Push and release**

```bash
git push origin main
git push origin v0.3.0
gh release create v0.3.0 --generate-notes
```

---

## Dependency Graph

```
Task 1 (schema)
  ↓
Task 2 (extract prompt) ← depends on Task 1 (ExtractedFact type)
  ↓
Task 3 (dedup) ← depends on Task 1 (evidence context)
  ↓
Task 4 (save) ← depends on Task 1 + 3 (new params, dedup context)
  ↓
Task 5 (engine extract caller) ← depends on Task 2 + 4 (passes evidence through)
  ↓
Task 6 (assemble rewrite) ← depends on Task 1 + 5 (formatMemories, recall boost)
  ↓
Task 7 (reflect 5-job) ← depends on Task 4 (saveMemory with evidence)
  ↓
Task 8 (linker prompt) ← depends on Task 1 (evidence fields in memory list)
  ↓
Task 9 (system context + tools) ← depends on Task 4 (save tool params)
  ↓
Task 10 (MCP server) ← depends on Task 4 (save params)
  ↓
Task 11 (discovery summary) ← depends on Task 7 (inside reflect)
  ↓
Task 12 (docs + release)
```

Tasks 9 and 10 can run in parallel. Tasks 7 and 8 can run in parallel.

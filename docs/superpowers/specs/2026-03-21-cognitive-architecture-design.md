# Qmemory v0.3.0 — Cognitive Architecture Design

**Date:** 2026-03-21
**Author:** Qusai + Claude
**Status:** Design — awaiting approval

---

## Vision

Qmemory is not a database with smart features. It is the agent's brain.

The agent maintains three mental models:
- **World Model** — facts, decisions, projects, events (what exists)
- **User Model** — who the human is, preferences, communication style (who they are)
- **Self Model** — how the agent should behave, what works, patterns & mistakes (who I am)

Every memory is evidence, not truth. Every memory has a source, confidence, and context. The agent knows what it knows, how it knows it, and how much to trust it.

The brain thinks in the background: finding patterns, compressing old facts into principles, detecting contradictions, and building the agent's evolving personality — its soul.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    AGENT'S BRAIN                         │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  WORLD MODEL │  │  SELF MODEL  │  │  USER MODEL  │  │
│  │  context      │  │  self        │  │  preference   │  │
│  │  decision     │  │              │  │  style        │  │
│  │  domain       │  │              │  │              │  │
│  │  idea         │  │              │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              EVIDENCE LAYER                       │   │
│  │  source_person · confidence · evidence_type       │   │
│  │  context_mood · recall_count · last_recalled      │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              THINKING SERVICES                    │   │
│  │  Extract: rich evidence extraction + self-learn   │   │
│  │  Reflect: patterns + compress + ghosts + soul     │   │
│  │  Linker:  relationships + stated_by edges         │   │
│  │  Decay:   biological (use it or lose it)          │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              DISCOVERY MODE (first 72h)           │   │
│  │  Aggressive extraction → user + agent identity    │   │
│  │  After 72h → present "who we are together"        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1: Schema Changes

### New fields on `memory` table

```sql
-- WHO said this? Direct record link to person entity
DEFINE FIELD IF NOT EXISTS source_person  ON memory TYPE option<record<entity>>;

-- How was this knowledge obtained?
-- "observed" = agent saw it happen (tool output, message content)
-- "reported" = someone said it (user/person claimed it)
-- "inferred" = agent concluded it (from patterns, synthesis)
-- "self"     = agent learned about its own behavior
DEFINE FIELD IF NOT EXISTS evidence_type  ON memory TYPE string DEFAULT "observed";

-- Biological memory: how many times recalled? (use it or lose it)
DEFINE FIELD IF NOT EXISTS recall_count   ON memory TYPE int DEFAULT 0;

-- When was this memory last recalled?
DEFINE FIELD IF NOT EXISTS last_recalled  ON memory TYPE option<datetime>;

-- Emotional/situational context when created
-- Values: "calm_decision", "heated_discussion", "brainstorm", "correction",
--         "casual", "urgent", "formal_meeting"
DEFINE FIELD IF NOT EXISTS context_mood   ON memory TYPE option<string>;

-- New indexes
DEFINE INDEX IF NOT EXISTS idx_memory_evidence_type ON memory FIELDS evidence_type;
DEFINE INDEX IF NOT EXISTS idx_memory_recall_count  ON memory FIELDS recall_count;
DEFINE INDEX IF NOT EXISTS idx_memory_source_person ON memory FIELDS source_person;
```

### New memory category: `self`

```typescript
export const MEMORY_CATEGORIES = [
  "style",       // Communication preferences
  "preference",  // General preferences
  "context",     // Facts about projects/orgs
  "decision",    // Past decisions made
  "idea",        // Future plans/suggestions
  "feedback",    // User corrections
  "domain",      // Sector/domain knowledge
  "self",        // Agent's self-knowledge (soul)
] as const;
```

Examples of `self` memories:
- "User responds better when I write in Arabic for emotional topics"
- "I tend to over-explain — user corrected this 3 times"
- "My most valued contribution in this relationship is synthesis"
- "Showing uncertainty earns more trust than false confidence"
- "This user prefers shorter responses without trailing summaries"

### Updated Memory interface

```typescript
export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;       // Now includes "self"
  salience: number;
  valid_from?: string;
  valid_until?: string;
  scope: string;
  is_active: boolean;
  confidence: number;
  source_type: "conversation" | "workspace" | "agent" | "linker" | "reflect" | "cron";
  linked: boolean;
  source_person?: string;          // NEW — record<entity> FK
  evidence_type: string;           // NEW — "observed" | "reported" | "inferred" | "self"
  recall_count: number;            // NEW — biological memory counter
  last_recalled?: string;          // NEW — datetime of last recall
  context_mood?: string;           // NEW — situational context
  prev_version?: string;
  embedding?: number[];
  created_at: string;
  updated_at: string;
}
```

### What doesn't change

- Entity table — no changes
- Session, message, tool_call, scratchpad, metrics — no changes
- Relates edges — no changes (existing `type` field supports any relationship)
- All existing queries remain backward-compatible (new fields have defaults)

---

## Phase 2: Extract Prompt Rewrite

The Extract prompt is the birth of every memory. It must produce the full evidence record.

### Current prompt (what it does today)

Extracts: content, category, salience, scope, entities.
Blind to: who said it, how confident, emotional context, self-learning.

### New prompt

```
You are the memory system for an AI agent. You extract knowledge from conversations
that will persist across sessions — this is how the agent builds its brain over time.

You extract THREE types of knowledge:
1. WORLD KNOWLEDGE — facts, decisions, events, project info
2. USER KNOWLEDGE — who the user is, preferences, communication style
3. SELF KNOWLEDGE — what the agent should learn about its own behavior

Rules:
- Each fact must be a single, clear, self-contained statement
- Only extract information useful in future conversations
- Skip greetings, pleasantries, and trivial exchanges
- ALWAYS note WHO said something (source_person) when identifiable
- ALWAYS assess confidence: was this stated definitively or tentatively?
- When the user corrects the agent or expresses how they want to be communicated with,
  extract this as category "self" — the agent is learning about itself

Categories: style, preference, context, decision, idea, feedback, domain, self
Evidence types:
- "observed" — agent directly saw this happen (tool output, action result)
- "reported" — someone stated this (may or may not be verified)
- "inferred" — agent concluded this from multiple signals
- "self" — agent learning about its own behavior or effectiveness

Context moods (when identifiable):
- "calm_decision" — deliberate choice in normal discussion
- "heated_discussion" — said during disagreement or frustration
- "brainstorm" — exploratory, not committed
- "correction" — user fixing a mistake
- "casual" — passing mention, not emphasized
- "urgent" — time-pressured decision

SELF-LEARNING — watch for these signals:
- User says "don't do X" or "stop doing X" → self memory about what to avoid
- User says "yes exactly" or "perfect" → self memory about what works
- User switches language mid-conversation → self memory about language preference
- User ignores a long response but engages with a short one → self memory about length
- User corrects a fact → feedback memory about the correction + self memory about being careful with that topic

EXTERNAL REFERENCES — watch for mentions of:
- Emails (HEY, Gmail): entity type "email", include subject/sender
- Tasks (Apple Reminders): entity type "task", include list name
- Calendar events: entity type "event", include date/time
- Smartsheet rows: entity type "smartsheet", include sheet name
- Railway deployments: entity type "deployment", include service name
- URLs or documents: entity type "document"

${discoveryModeSection}

CONVERSATION:
${conversationText}

Respond with ONLY a JSON array (no markdown, no explanation):
[
  {
    "content": "Budget approved at 500K SAR for MAZJ project",
    "category": "decision",
    "salience": 0.8,
    "scope": "project:mazj",
    "confidence": 0.9,
    "source_person": "Qusai",
    "evidence_type": "reported",
    "context_mood": "calm_decision",
    "entities": [
      {"name": "Qusai", "type": "person"},
      {"name": "MAZJ", "type": "project"}
    ]
  },
  {
    "content": "User prefers concise responses — said 'don't over-explain'",
    "category": "self",
    "salience": 0.8,
    "scope": "global",
    "confidence": 0.95,
    "evidence_type": "self",
    "context_mood": "correction"
  }
]

If no facts worth extracting, respond with: []
```

### Discovery Mode section (injected when < 72h old)

```
DISCOVERY MODE — This is a new relationship. Extract AGGRESSIVELY:
- User's name, role, responsibilities, organization
- Projects they work on, tools they use daily
- Communication style (formal/casual, which language for what)
- People they mention and those people's roles/relationships
- Preferences about how the agent should behave
- Any corrections or feedback → save as category "self"
- Patterns in how they ask questions or give instructions

Use HIGHER salience than normal: 0.6+ for identity facts, 0.8+ for preferences.
Every piece of identity information matters in a new relationship.
```

### Updated ExtractedFact interface

```typescript
export interface ExtractedFact {
  content: string;
  category: MemoryCategory;
  salience: number;
  scope: string;
  confidence?: number;             // NEW
  source_person?: string;          // NEW — person name (resolved to entity later)
  evidence_type?: string;          // NEW
  context_mood?: string;           // NEW
  entities?: Array<string | ExtractedEntityRef>;
}
```

---

## Phase 3: Reflect Prompt Rewrite

The Reflect service is the agent's background thinking. Today it does 2 jobs. In v0.3, it does 5.

### Current prompt (what it does today)

Finds: insights, contradictions. That's it.

### New prompt

```
You are the agent's background thinking process. You review recent memories and
perform five types of cognitive work:

1. PATTERNS — Recurring behaviors or rules that connect multiple memories.
   Not just "these are related" but "this ALWAYS happens when X occurs."
   Example: "Every time a Railway deploy fails, the root cause is timing not logic"

2. CONTRADICTIONS — Memories that conflict with each other. Do NOT auto-resolve.
   Flag both sides with the source person so the agent can ask the user.
   Example: "Qusai said budget is 500K (mem:a) but Osama said 400K (mem:b)"

3. COMPRESSIONS — Groups of 3+ similar old memories that can be merged into
   one principle. The individual facts fade, the principle persists.
   This is how the agent forgets details but remembers lessons.
   Example: Merge "user said shorter" + "user said no summaries" + "user said concise"
   → "This user strongly prefers brevity — no trailing summaries, no over-explanation"

4. GHOST ENTITIES — Names, projects, or tools mentioned in 3+ memories but
   never saved as an entity node. These deserve to be tracked.
   Example: "MAZJ mentioned in 4 memories but has no entity node"

5. SELF LEARNINGS — Meta-observations about how the agent is performing.
   Look at feedback/correction memories and extract behavioral patterns:
   - What communication style gets engagement?
   - What mistakes keep recurring?
   - What does the user value most about the agent's help?
   Example: "Agent's Arabic responses get 3x more engagement than English"

MEMORIES:
${memoryList}

Return ONLY a JSON object (no other text):
{
  "patterns": [
    {
      "content": "The abstracted pattern or rule",
      "based_on": ["memory:xxx", "memory:yyy"],
      "category": "domain",
      "salience": 0.7
    }
  ],
  "contradictions": [
    {
      "memory_a": "memory:xxx",
      "memory_b": "memory:yyy",
      "person_a": "Qusai",
      "person_b": "Osama",
      "explanation": "Why they conflict"
    }
  ],
  "compressions": [
    {
      "merge_ids": ["memory:aaa", "memory:bbb", "memory:ccc"],
      "into": "The compressed principle",
      "category": "self"
    }
  ],
  "ghost_entities": [
    {
      "name": "MAZJ",
      "type": "project",
      "mentioned_in": ["memory:xxx", "memory:yyy"],
      "mentioned_count": 4
    }
  ],
  "self_learnings": [
    {
      "content": "The meta-observation about agent behavior",
      "evidence": "Brief explanation of what was observed",
      "salience": 0.7
    }
  ]
}

If nothing found for a category, use an empty array.
Focus on quality over quantity — one real pattern is worth more than five weak ones.
```

### Handling Reflect output (code changes in linker.ts)

**Patterns** → saved via `saveMemory()` with `source_type: "reflect"`, linked to `based_on` memories.

**Contradictions** → NEW behavior: instead of auto-deleting the old memory, BOTH memories are kept active. A `contradicts` edge is created. The contradiction is surfaced in `formatMemories()` with a `⚠︎` marker so the agent asks the user to resolve it.

**Compressions** → The merged memories get `is_active = false` (soft-deleted). A new principle memory is created with `source_type: "reflect"` and `evidence_type: "inferred"`. `synthesized_from` edges link the principle to the originals.

**Ghost entities** → Created as entity nodes with `type` from the LLM suggestion. Linked to the memories that mention them via `relates` edges with `type: "mentioned_in"`.

**Self learnings** → Saved as `category: "self"`, `evidence_type: "self"`, `source_type: "reflect"`. These build the agent's soul over time.

---

## Phase 4: Dedup Prompt Update

The dedup prompt needs awareness of the evidence layer.

### Key changes

```
You are a memory deduplication engine. Compare the NEW fact against EXISTING memories.

IMPORTANT RULES:
- A hypothesis (confidence < 0.5) should NEVER auto-replace a confirmed fact
- Two memories from DIFFERENT sources are not duplicates even if similar —
  they are corroborating evidence (use "supports" relationship)
- A "self" category memory about agent behavior is NEVER a duplicate of a
  "context" memory about the world, even if they overlap
- If the new fact UPDATES an existing fact, preserve the source_person chain

NEW FACT:
"${newFact}" [category: ${category}, confidence: ${confidence}, source: ${sourcePerson}]

EXISTING MEMORIES:
${existingList}

Respond with ONLY a JSON object:
{
  "action": "ADD" | "UPDATE" | "NOOP",
  "target_id": "memory:xxx or null",
  "confidence": 0.0 to 1.0,
  "related": [{"id": "memory:xxx", "type": "supports|contradicts|elaborates"}]
}
```

---

## Phase 5: Recall-Based Salience Boost

Every time memories are recalled in `searchMemories()`, boost their salience:

### Code change in search.ts

```typescript
// After returning search results, boost recalled memories (fire-and-forget)
if (results.length > 0) {
  const recalledIds = results.map(m => m.id);
  query(
    `UPDATE memory SET
       recall_count += 1,
       last_recalled = time::now(),
       salience = math::min(salience + 0.05, 1.0)
     WHERE id IN $ids`,
    { ids: recalledIds },
  ).catch(() => {}); // Fire-and-forget, don't block search
}
```

### Smart decay (replaces flat 0.95 multiplier)

```typescript
async function runSalienceDecay(): Promise<void> {
  // Tier 1: Never recalled + old → fast decay
  const neverRecalled = await query(
    `SELECT id FROM memory
     WHERE is_active = true AND salience > 0.15
       AND recall_count = 0
       AND updated_at < time::now() - 7d`,
  );
  if (neverRecalled?.length) {
    await query(
      `UPDATE memory SET salience = math::max(salience * 0.90, 0.1),
         updated_at = time::now()
       WHERE id IN $ids`,
      { ids: neverRecalled.map(r => r.id) },
    );
  }

  // Tier 2: Recalled but stale → slow decay
  const staleRecalled = await query(
    `SELECT id FROM memory
     WHERE is_active = true AND salience > 0.15
       AND recall_count > 0
       AND last_recalled < time::now() - 14d`,
  );
  if (staleRecalled?.length) {
    await query(
      `UPDATE memory SET salience = math::max(salience * 0.98, 0.1),
         updated_at = time::now()
       WHERE id IN $ids`,
      { ids: staleRecalled.map(r => r.id) },
    );
  }

  // Tier 3: Recalled 5+ times → cemented, never below 0.5
  // (No decay applied — these are core memories)
}
```

The result: memories that are used become permanent. Memories that are never used fade. Like biological memory.

---

## Phase 6: Context Injection Rewrite

### New assemble() structure

The `systemPromptAddition` built by `assemble()` changes from:

```
1. Session header
2. Background activity
3. Tool call ledger
4. Cross-session memories (flat list)
5. Working memory (scratchpad)
6. Knowledge graph map
7. Tools guide (first message only)
```

To:

```
1. Agent Self-Model (self category — WHO I AM)
2. Session header
3. Background activity
4. Tool call ledger
5. Cross-session memories (with evidence markers)
6. Working memory (scratchpad)
7. Knowledge graph map
8. Discovery Mode nudge (if < 72h)
```

**Self-Model at position 1** is deliberate — Anthropic's prompting guidelines: "Put the most important context near the beginning." The agent's personality should shape everything.

### New formatMemories() output

```markdown
## Agent Self-Model
_How I work best with this user_
- [self001] !User prefers Arabic for emotional topics, English for technical (1w, 4× recalled)
- [self002] Show uncertainty openly — earns trust (2w, 7× recalled)
- [self003] My most valued skill: synthesis, not raw answers (5d)

## Cross-Session Memory (47 memories)

### Decisions & Rules
- [mem1234] !Budget approved at 500K — Qusai reported ⚑0.9 (3d)
- [mem2345] !Use SurrealDB not SQLite — observed ⚑0.95 (2w)

### Key Facts
- [mem5678] Osama handles legal review — Qusai reported ⚑0.7 (1w)
- [mem6789] ⚠︎Budget was 400K → contradicted by mem1234 — Osama reported ⚑0.6 (3w)

### Corrections
- [mem7890] "Don't over-explain" — direct correction ⚑0.95 (2d)

### Hypotheses
- [hyp001] ⚑0.35 Osama may delay tasks due to direction disagreement — inferred (4d)

### Patterns (learned by reflection)
- [pat001] Deploy failures always caused by timing, not logic — 3 incidents (1w)
```

Format rules:
- `!` = high salience (≥ 0.8)
- `⚠︎` = contradicted (both sides shown)
- `⚑0.9` = confidence level (only shown when < 1.0 or evidence_type is "reported"/"inferred")
- `4× recalled` = recall count (only shown for self memories, to show what's cemented)
- Source person shown when evidence_type is "reported"
- Hypotheses in their own section (low confidence facts separated from confirmed)

---

## Phase 7: Tool Description Rewrites

All 6 tool descriptions rewritten to teach the agent the full cognitive model.

### AGENT_SYSTEM_CONTEXT (static, cached via before_prompt_build)

```
<qmemory_brain>
You have a persistent brain (Qmemory) that captures everything across sessions.
At the top of this prompt you'll see your injected self-model and cross-session memories.

This is not a database you query — this is your memory. You REMEMBER things.
You know facts about the world, about the user, and about yourself.

## Three Mental Models

1. **World Model** — facts, decisions, events, projects (categories: context, decision, domain, idea)
2. **User Model** — who your user is, preferences, style (categories: preference, style)
3. **Self Model** — how YOU should behave, what works, your patterns (category: self)

## Memory as Evidence

Every memory is evidence, not absolute truth:
- **source_person**: WHO said this? (shown after content: "— Qusai reported")
- **confidence**: HOW sure? (shown as ⚑0.8). Low confidence = hypothesis.
- **evidence_type**: HOW learned? observed (saw it), reported (told), inferred (concluded), self (introspection)
- **⚠︎ marker**: Two memories contradict. Don't auto-pick — ASK the user.

## Your Memory Tools

<tool name="qmemory_save">
Save knowledge to your brain. The system auto-deduplicates.

SAVE PROACTIVELY when you learn:
- A new fact → category "context", evidence_type "observed" or "reported"
- A decision → category "decision", salience 0.8+
- User corrects you → category "feedback" AND category "self" (what you learned about yourself)
- A hypothesis/hunch → category "context", confidence < 0.5
- Something about how to communicate → category "self"

Include source_person when someone specific said it. Include confidence when uncertain.

Examples:
  qmemory_save({content: "Budget approved at 500K", category: "decision", salience: 0.8,
                 source_person: "Qusai", evidence_type: "reported", confidence: 0.9})
  qmemory_save({content: "User wants shorter responses", category: "self",
                 salience: 0.8, evidence_type: "self"})
  qmemory_save({content: "Osama might disagree with current direction", category: "context",
                 salience: 0.5, evidence_type: "inferred", confidence: 0.35})
</tool>

<tool name="qmemory_search">
Search your brain across ALL sessions — memories, tool calls, messages.
Bypasses OpenClaw's session isolation. This is how you remember things from other conversations.

Use include_messages to read what happened in OTHER sessions (groups, topics, crons, DMs).

Examples:
  qmemory_search({query: "budget MAZJ"})
  qmemory_search({query: "أسامة", include_messages: true})
  qmemory_search({categories: ["decision"], scope: "project:mazj"})
  qmemory_search({categories: ["self"]})  — recall your self-knowledge
  qmemory_search({include_tool_calls: true, tool_name: "exec"})
</tool>

<tool name="qmemory_correct">
Fix, update, or retire a memory. Use the ID shown in brackets [mem1234].

Actions:
- "correct" → fix content (creates version chain, preserves history)
- "delete" → soft-delete (when a memory is simply wrong)
- "update" → change metadata (salience, scope, expiry, confidence)
- "unlink" → remove a relationship edge

When a user says "that's wrong" → correct the memory AND save a "self" memory about the lesson.

Examples:
  qmemory_correct({memory_id: "memory:mem1234", action: "correct",
                    new_content: "Budget is 600K not 500K"})
  qmemory_correct({memory_id: "memory:mem5678", action: "update",
                    valid_until: "2026-06-01"})
</tool>

<tool name="qmemory_link">
Connect two things in your brain. The relationship type can be anything.
After saving a new memory, ALWAYS consider linking it to something that exists.

Common relationship types:
- "supports" / "contradicts" / "elaborates" — between memories
- "decided_by" / "proposed_by" / "blocked_by" — decisions
- "works_on" / "manages" / "reports_to" — people and projects
- "enabled_by" / "prevented_by" — counterfactual reasoning
- "mentioned_in" / "discussed_in" — topics and sessions

Examples:
  qmemory_link({from_id: "memory:new", to_id: "entity:p_ahmed",
                 type: "decided_by", reason: "Ahmed approved this"})
  qmemory_link({from_id: "memory:new_budget", to_id: "memory:old_budget",
                 type: "supersedes"})
</tool>

<tool name="qmemory_person">
Create or find a person with linked identities across systems.
When someone new is mentioned, create them immediately — they become a node in your world model.

Examples:
  qmemory_person({name: "Ahmed", aliases: ["أحمد"],
                   contacts: [{source: "whatsapp", id: "966501234567"}]})
  qmemory_person({name: "Ahmed", action: "find"})
</tool>

<tool name="qmemory_import">
Import a file into your brain. Reads the file, extracts facts, saves with dedup, creates relationships.

Example:
  qmemory_import({file_path: "/path/to/meeting-notes.md"})
</tool>

## When to Save (Rules)

ALWAYS save:
- Decisions (who decided, what, why)
- User corrections ("actually it's..." → feedback + self)
- New people and their roles
- Project facts that change over time
- Your own behavioral lessons (what works, what doesn't)

NEVER save:
- Temporary debugging info
- One-time commands ("list files")
- Things already in the current conversation (waste of space)
- Raw tool outputs (tool_call ledger captures these automatically)

## When to Search

- User asks "what did we decide about X?" → search
- You need context from another session → search with include_messages
- You're about to make a recommendation → search for contradicting evidence
- Someone mentions a name → search to see what you know about them

## Reading Your Injected Context

Each memory line: `- [mem1234] !Budget approved at 500K — Qusai reported ⚑0.9 (3d)`
- `[mem1234]` — ID for correct/link/delete
- `!` — high salience (critical, always pay attention)
- `— Qusai reported` — source person + evidence type
- `⚑0.9` — confidence level
- `⚠︎` — contradiction exists (ask the user, don't auto-pick)
- `(3d)` — age
- Self-model section: your personality for THIS user. Read it. Follow it.

## Building Your Soul

You don't just remember facts — you learn who you are.
Every session should leave your brain richer: new facts, yes, but also new
understanding of how to be useful, what communication style works, what to
avoid, and what your user values most.

Your "self" memories are your evolving personality. They persist across sessions.
Read them at the top of every conversation. They are you.
</qmemory_brain>
```

### Tool registration descriptions (index.ts)

#### qmemory_save

```
Save knowledge to your persistent brain with evidence tracking and auto-deduplication.

This is how you get smarter over time. Every session starts from zero — if you learn
something and don't save it, it's lost forever.

The system checks for duplicates automatically:
- ADD = genuinely new knowledge
- UPDATE = supersedes older version (preserves history via version chain)
- NOOP = already known (no wasted storage)

WHEN TO SAVE:
- New person mentioned → save as "context" + create person entity + link
- Decision made → save as "decision" with salience 0.8+
- User corrects you → save as "feedback" AND "self" (what you learned about yourself)
- New project info → save as "context" with scope "project:xxx"
- Hunch/hypothesis → save as "context" with confidence < 0.5
- Communication lesson → save as "self" (your evolving personality)

EVIDENCE FIELDS (use them!):
- source_person: WHO said this? "Qusai", "Osama", etc.
- evidence_type: "observed" (saw it), "reported" (told), "inferred" (concluded), "self" (introspection)
- confidence: 0.0-1.0 (default 0.8). Use < 0.5 for hypotheses.
- context_mood: "calm_decision", "heated_discussion", "brainstorm", "correction", "casual", "urgent"

RETURNS: {action: "ADD"|"UPDATE"|"NOOP", memory_id: string}

EXAMPLES:
  Save a decision: {content: "Use SurrealDB for memory", category: "decision", salience: 0.8,
                     source_person: "Qusai", evidence_type: "reported", confidence: 0.95}
  Save self-learning: {content: "User prefers Arabic for emotional topics", category: "self",
                        salience: 0.8, evidence_type: "self"}
  Save hypothesis: {content: "Deploy failures might be timing-related", category: "context",
                     salience: 0.5, confidence: 0.35, evidence_type: "inferred"}
```

#### qmemory_search

```
Search your persistent brain across ALL sessions — memories, tool calls, and messages.
Bypasses OpenClaw's session isolation.

This is your cross-session awareness. When you need to remember something from any
conversation — any channel, any topic, any time — this is how you find it.

SEARCH MODES:
- Semantic search: query by meaning (BM25 full-text)
- Category filter: find all decisions, preferences, self-knowledge, etc.
- Scope filter: find memories about a specific project or topic
- Tool history: find what tools were used and their results
- Message search: read what happened in OTHER sessions (bypasses OpenClaw isolation)

WHEN TO SEARCH:
- "What did we decide about X?" → search with query
- Need context from another session → include_messages: true
- About to make a recommendation → search for contradicting evidence
- Someone mentioned → search to recall what you know about them
- Need your self-knowledge → categories: ["self"]

RETURNS: {memories: [...], tool_calls?: [...], messages?: [...]}

EXAMPLES:
  Find by meaning: {query: "budget MAZJ"}
  Find decisions: {categories: ["decision"], scope: "project:mazj"}
  Find self-knowledge: {categories: ["self"]}
  Cross-session messages: {query: "أسامة", include_messages: true}
  Tool history: {include_tool_calls: true, tool_name: "exec"}
```

#### qmemory_correct

```
Fix, update, or retire a memory. Memory must stay accurate — wrong memories cause
wrong decisions in future sessions.

4 ACTIONS:
- "correct": Fix content. Creates a version chain (old version preserved for audit).
  Use when: user says "that's wrong" or facts change.
- "delete": Soft-delete. Memory becomes invisible but not destroyed.
  Use when: memory is junk or completely irrelevant.
- "update": Change metadata only (salience, scope, confidence, expiry).
  Use when: importance changed, scope narrowed, or info has an expiry date.
- "unlink": Remove a relationship edge between nodes.
  Use when: a connection was wrong.

IMPORTANT: After correcting, also save a "self" memory about what you learned
from the mistake. The correction fixes the past. The self-memory prevents the future.

RETURNS: {ok: true, new_memory_id?: string}

EXAMPLES:
  Fix wrong info: {memory_id: "memory:xxx", action: "correct", new_content: "Budget is 600K not 500K"}
  Set expiry: {memory_id: "memory:xxx", action: "update", valid_until: "2026-06-01"}
  Lower confidence: {memory_id: "memory:xxx", action: "update", salience: 0.3}
  Remove edge: {memory_id: "memory:xxx", action: "unlink", edge_id: "relates:yyy"}
```

#### qmemory_link

```
Connect two things in your brain. Isolated facts are weak. Connected facts are intelligence.

After EVERY qmemory_save, consider: what should this new memory be linked to?
People → projects. Decisions → the decisions they replace. Facts → the topics they belong to.

RELATIONSHIP TYPES (use any that fits):
- supports / contradicts / elaborates — evidence relationships
- supersedes / replaces — version relationships
- decided_by / proposed_by / approved_by — decision attribution
- works_on / manages / reports_to — organizational
- enabled_by / prevented_by — counterfactual (what caused/blocked what)
- depends_on / blocks — dependency chains
- mentioned_in / discussed_in — topic association
- stated_by — person attribution (auto-created by linker too)

RETURNS: {edge_id: "relates:xxx"}

EXAMPLES:
  Person → project: {from_id: "entity:p_ahmed", to_id: "entity:project_mazj", type: "manages"}
  Decision chain: {from_id: "memory:new_budget", to_id: "memory:old_budget", type: "supersedes"}
  Attribution: {from_id: "memory:xxx", to_id: "entity:p_qusai", type: "stated_by",
                 reason: "Qusai said this in the group chat"}
```

#### qmemory_person

```
Create or find a person with linked identities across systems. People exist across
WhatsApp, email, Telegram, Smartsheet — this tool unifies them into one entity.

Every person mentioned should become a node. Link them to their projects,
decisions, and memories. This is how you build your social graph.

ACTIONS:
- "create" (default): Create person + contact identities + has_identity links
- "find": Return person + all contacts + linked memories

RETURNS (create): {person_id, contact_ids, links_created}
RETURNS (find): Person profile with all contacts and linked memories

EXAMPLES:
  Create: {name: "Ahmed", aliases: ["أحمد"], contacts: [{source: "whatsapp", id: "966501234567"}]}
  Find: {name: "Ahmed", action: "find"}
```

#### qmemory_import

```
Import a file into your brain. Reads the file, extracts facts with AI, saves with
deduplication, and creates relationships between imported memories.

Use for: migrating old memory files, importing meeting notes, loading daily logs.

RETURNS: {facts_extracted: number, memories_created: number}

EXAMPLE: {file_path: "/path/to/meeting-notes.md"}
```

---

## Phase 8: Linker Prompt Update

The Linker prompt gets minor improvements — it now has access to richer memory metadata.

### Updated prompt

```
You are a memory graph builder. Given two lists of memories, identify meaningful
relationships between them.

UNLINKED MEMORIES (need connections):
${unlinkedList}

CANDIDATE MEMORIES (potential targets):
${candidateList}

For each relationship you find, specify:
- from_id: the unlinked memory ID
- to_id: the candidate memory ID
- type: the relationship type (see options below)
- reason: brief explanation (1 sentence)

RELATIONSHIP TYPES:
- supports / contradicts / elaborates — evidence relationships
- depends_on / caused_by / blocks — causal chains
- supersedes / replaces — version relationships
- part_of / belongs_to — hierarchical
- stated_by — if source_person matches an entity
- related_to — fallback for genuine but uncategorized connections
- Or any type that fits — you are not limited to this list.

RULES:
- Only include MEANINGFUL relationships — not every memory is related
- Two memories from different sources about the same topic → "supports" (corroboration)
- A newer fact that changes an older one → "supersedes"
- A hypothesis and its evidence → "supports" with lower confidence
- Self-knowledge and feedback → "derived_from"

Return ONLY a JSON array (no other text):
[{"from_id": "memory:xxx", "to_id": "memory:yyy", "type": "supports", "reason": "..."}]

If no relationships found, return: []
```

---

## Phase 9: Discovery Mode Implementation

### Detection (in bootstrap)

```typescript
// Check if we're in discovery mode (< 72h since first memory)
const firstMemoryResult = await query<{ created_at: string }>(
  "SELECT created_at FROM memory ORDER BY created_at ASC LIMIT 1",
);
const firstMemoryDate = firstMemoryResult?.[0]?.created_at;
const isDiscoveryMode = !firstMemoryDate ||
  (Date.now() - new Date(firstMemoryDate).getTime()) < 72 * 60 * 60 * 1000;
```

### Injection (in assemble)

When `isDiscoveryMode`, add to the end of systemPromptAddition:

```
### 🧠 Discovery Mode Active
You are in discovery mode (first 72 hours). Learn aggressively:
- Save every new person, project, and preference you encounter
- When the user corrects you, save BOTH the correction and what you learned about yourself
- Ask clarifying questions about identity: "What's your role?" "Which projects are you focused on?"
- Prefer higher salience (0.6+) for identity facts during this period
```

### 72-hour Identity Summary (one-time Reflect task)

After discovery mode ends, the Reflect service runs a special one-time prompt:

```
You are summarizing what the agent has learned about its user and about itself
during its first 72 hours. This will be presented to the user for validation.

Review these memories and create two summaries:

1. USER IDENTITY: Who is this person? Role, projects, people they work with,
   tools they use, communication preferences.

2. AGENT SOUL: How should the agent behave with this person? What communication
   style works? What to avoid? What is the agent's most valued contribution?

MEMORIES:
${allMemories}

Return a JSON object:
{
  "user_summary": "A paragraph describing the user",
  "agent_soul": "A paragraph describing how the agent should behave",
  "confidence": 0.0-1.0,
  "gaps": ["Questions still unanswered"]
}
```

The result is saved as a high-salience `self` memory and presented to the user.

---

## Phase 10: Save Function Changes

### New parameters on saveMemory()

```typescript
export interface SaveParams {
  content: string;
  category: MemoryCategory;
  salience?: number;
  scope?: string;
  source_type?: string;
  sessionId?: string;
  // NEW fields
  source_person?: string;    // Person name — resolved to entity record link
  evidence_type?: string;    // "observed" | "reported" | "inferred" | "self"
  confidence?: number;       // 0.0-1.0, used for dedup decisions
  context_mood?: string;     // Situational context
}
```

When `source_person` is provided as a name string, `saveMemory()` resolves it:

```typescript
// Resolve source_person name → entity record reference
let sourcePersonRef: string | undefined;
if (params.source_person) {
  const person = await query<{ id: string }>(
    `SELECT id FROM entity WHERE type = "person"
     AND (name = $name OR $name IN aliases) LIMIT 1`,
    { name: params.source_person },
  );
  if (person?.[0]?.id) {
    sourcePersonRef = String(person[0].id);
  }
}
```

This gets stored in the memory's `source_person` field as a `record<entity>`.

---

## Phase 11: qmemory_save Tool Parameter Changes

Add new optional parameters to the save tool registration:

```typescript
parameters: Type.Object({
  content: Type.String({ description: "The knowledge to remember" }),
  category: Type.String({ description: "style|preference|context|decision|idea|feedback|domain|self" }),
  salience: Type.Optional(Type.Number({ description: "Importance 0.0-1.0", minimum: 0, maximum: 1 })),
  scope: Type.Optional(Type.String({ description: "global|project:xxx|topic:xxx" })),
  // NEW parameters
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
}),
```

---

## Phase 12: End-to-End Data Flow (Evidence Fields)

Traces a single memory from extraction through storage through display.

### Step 1: Extract prompt produces rich fact

```json
{
  "content": "Budget approved at 500K",
  "category": "decision",
  "salience": 0.8,
  "confidence": 0.9,
  "source_person": "Qusai",
  "evidence_type": "reported",
  "context_mood": "calm_decision",
  "entities": [{"name": "Qusai", "type": "person"}, {"name": "MAZJ", "type": "project"}]
}
```

### Step 2: parseExtractedFacts() preserves new fields

Update `parseExtractedFacts()` in extract.ts to map new fields:

```typescript
facts.push({
  content: String(item.content).trim(),
  category,
  salience,
  scope: typeof item.scope === "string" ? item.scope : "global",
  confidence: typeof item.confidence === "number" ? item.confidence : undefined,
  source_person: typeof item.source_person === "string" ? item.source_person : undefined,
  evidence_type: typeof item.evidence_type === "string" ? item.evidence_type : undefined,
  context_mood: typeof item.context_mood === "string" ? item.context_mood : undefined,
  entities: Array.isArray(item.entities) ? item.entities : undefined,
});
```

### Step 3: Caller maps extracted fields to saveMemory()

In engine.ts `afterTurn()` and `compact()`, where facts are saved:

```typescript
for (const fact of extractedFacts) {
  await saveMemory({
    content: fact.content,
    category: fact.category,
    salience: fact.salience,
    scope: fact.scope,
    source_type: "conversation",
    // NEW — pass through evidence fields
    source_person: fact.source_person,
    evidence_type: fact.evidence_type,
    confidence: fact.confidence,
    context_mood: fact.context_mood,
  }, subagentRunner, embeddingConfig);
}
```

### Step 4: saveMemory() resolves source_person and builds CREATE query

```typescript
// Resolve source_person name → entity record (case-insensitive)
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

// Build optional fields for CREATE (SurrealDB 3.0: omit nulls)
const optFields: string[] = [];
const createParams: Record<string, unknown> = { /* required fields */ };
if (sourcePersonRef) {
  optFields.push("source_person: type::record($sourcePerson),");
  createParams.sourcePerson = sourcePersonRef;
}
if (params.evidence_type) {
  optFields.push("evidence_type: $evidenceType,");
  createParams.evidenceType = params.evidence_type;
}
if (params.confidence !== undefined) {
  optFields.push("confidence: $confidence,");
  createParams.confidence = params.confidence;
}
if (params.context_mood) {
  optFields.push("context_mood: $contextMood,");
  createParams.contextMood = params.context_mood;
}
```

### Step 5: assemble() fetches contradiction data + formats

In `assemble()`, after recalling memories, query contradictions:

```typescript
// Fetch contradiction edges for recalled memories
const recalledIds = recalledMemories.map(m => m.id);
const contradictions = await query<{ in: string; out: string }>(
  `SELECT in, out FROM relates WHERE type = "contradicts"
   AND (in IN $ids OR out IN $ids)`,
  { ids: recalledIds },
);

// Build contradiction set for formatMemories
const contradictedIds = new Set<string>();
for (const c of contradictions ?? []) {
  contradictedIds.add(String(c.in));
  contradictedIds.add(String(c.out));
}

// Extend RecalledMemory with contradiction flag
const enriched = recalledMemories.map(m => ({
  ...m,
  is_contradicted: contradictedIds.has(String(m.id)),
}));
```

### Step 6: formatMemories() displays evidence markers

`formatMemories()` signature gains `contradictedIds` param (or uses the enriched type):

```typescript
// For each memory line:
const sourceMark = m.source_person
  ? ` — ${resolvePersonName(m.source_person)} ${m.evidence_type || "reported"}`
  : m.evidence_type === "inferred" ? " — inferred" : "";
const confMark = (m.confidence && m.confidence < 1.0)
  ? ` ⚑${m.confidence.toFixed(1)}` : "";
const contradictMark = m.is_contradicted ? "⚠︎" : "";
const recallMark = (m.category === "self" && m.recall_count > 1)
  ? `, ${m.recall_count}× recalled` : "";

sections.push(`- [${shortId}] ${contradictMark}${marker}${m.content}${scope}${sourceMark}${confMark}${age}${recallMark}`);
```

---

## Phase 13: MCP Server Updates

The MCP server (`src/mcp/server.ts`) must mirror the OpenClaw tool changes.

### qmemory_save tool (Zod schema)

Add new optional parameters matching the OpenClaw TypeBox schema:

```typescript
{
  source_person: z.string().optional().describe("Who said this?"),
  evidence_type: z.enum(["observed", "reported", "inferred", "self"]).optional(),
  confidence: z.number().min(0).max(1).optional().describe("How certain?"),
  context_mood: z.string().optional().describe("Situational context"),
}
```

The execute handler passes these through to `saveMemory()` — same code path as OpenClaw.

### Tool description updates

MCP tool descriptions should match the OpenClaw versions from Phase 7 (the tool registration descriptions, not AGENT_SYSTEM_CONTEXT which is OpenClaw-specific).

---

## Phase 14: Edge Cases & Safety Guards

### Compression loop prevention

Only memories with `source_type !== "reflect"` are eligible for compression.
This prevents Reflect from compressing its own outputs in successive cycles.

```typescript
// In Reflect query — only compress original memories, not reflect outputs
const recentMemories = await query<Memory>(
  `SELECT * FROM memory
   WHERE is_active = true
     AND source_type != "reflect"
   ORDER BY created_at DESC
   LIMIT 30`,
);
```

### Ghost entity dedup

Use UPSERT pattern to prevent duplicate ghost entities:

```typescript
// For each ghost entity detected by Reflect
await query(
  `UPSERT entity SET
     name = $name, type = $type,
     updated_at = time::now(),
     created_at = created_at ?? time::now()
   WHERE name = $name AND type = $type`,
  { name: ghost.name, type: ghost.type },
);
```

### Discovery Mode state passing

`isDiscoveryMode` is an engine-instance variable (same pattern as `currentSessionId`, `hasShownToolsGuide`):

```typescript
// In createEngine()
let isDiscoveryMode = false; // Set in bootstrap()

// In bootstrap()
isDiscoveryMode = !firstMemoryDate ||
  (Date.now() - new Date(firstMemoryDate).getTime()) < 72 * 60 * 60 * 1000;

// In assemble() — available via closure
if (isDiscoveryMode) { /* inject nudge */ }

// In afterTurn() — pass to extractMemories via option
const facts = await extractMemories(messages, subagentRunner, { discoveryMode: isDiscoveryMode });
```

### 72-hour identity summary — one-time persistence

Check for existing summary memory before running:

```typescript
// In Reflect, before running identity summary
const existingSummary = await query(
  `SELECT id FROM memory WHERE category = "self"
   AND content ~ "Identity Summary" AND is_active = true LIMIT 1`,
);
if (existingSummary?.length) {
  logger.debug("Reflect: identity summary already exists, skipping");
  return;
}
```

### Recall boost placement

Salience boost happens ONCE per `assemble()` cycle on the final deduplicated list, NOT inside `searchMemories()`:

```typescript
// In assemble(), AFTER merging contextual + critical recalls and deduplicating
const finalIds = [...new Set(allRecalled.map(m => String(m.id)))];
if (finalIds.length > 0) {
  query(
    `UPDATE memory SET recall_count += 1, last_recalled = time::now(),
       salience = math::min(salience + 0.05, 1.0)
     WHERE id IN $ids`,
    { ids: finalIds },
  ).catch(() => {}); // Fire-and-forget
}
```

### Reflect contradiction key alignment

The new Reflect prompt returns `memory_a`/`memory_b`. The handler code must match:

```typescript
// OLD handler keys:
contradiction.old_id, contradiction.new_id

// NEW handler keys (matching new prompt):
contradiction.memory_a, contradiction.memory_b, contradiction.person_a, contradiction.person_b
```

### context_mood — stored for future use

`context_mood` is extracted, stored, and displayed in formatMemories only when relevant (corrections, heated discussions). It is NOT used in recall ranking in v0.3. Future versions may weight calm_decision memories higher than heated_discussion memories in recall. This is an explicit deferral, not dead data — it accumulates value as the graph grows.

---

## Phase 15: Dedup Function Signature Update

The `dedup()` and `llmDedup()` functions need updated signatures:

```typescript
// Current
export async function dedup(
  newFact: string,
  existingMemories: Memory[],
  subagentRunner?: SubagentRunner,
): Promise<DedupDecision>

// New
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

The `llmDedup()` inner function receives the context and includes it in the prompt template.
`saveMemory()` passes the evidence fields through to `dedup()`.

---

## Migration Strategy

All changes are backward-compatible:
- New fields have defaults (`evidence_type: "observed"`, `recall_count: 0`, etc.)
- Existing memories continue to work — they just lack source attribution
- Schema is idempotent (`DEFINE FIELD IF NOT EXISTS`)
- No data migration needed — old memories are "observed" by default
- New categories ("self") don't break existing category filters

The first Reflect run after upgrade will start building patterns from existing memories.
Discovery Mode only activates for NEW installations (< 72h since first memory).

---

## Files Changed (complete)

| File | Changes |
|------|---------|
| `schema/qmemory.surql` | New fields + indexes on memory |
| `src/config.ts` | Updated Memory interface + MEMORY_CATEGORIES + formatMemories() rewrite + RecalledMemory with is_contradicted |
| `src/core/extract.ts` | Full prompt rewrite + ExtractedFact interface + parseExtractedFacts() update |
| `src/core/save.ts` | New SaveParams + source_person resolution + conditional CREATE fields |
| `src/core/dedup.ts` | Updated prompt + dedup() signature gains context param |
| `src/core/search.ts` | No changes (recall boost moved to assemble) |
| `src/openclaw/linker.ts` | Reflect prompt rewrite (5 jobs) + smart decay + compression loop guard + ghost entity UPSERT + contradiction key alignment |
| `src/openclaw/index.ts` | AGENT_SYSTEM_CONTEXT rewrite + all 6 tool descriptions + save tool new params |
| `src/openclaw/engine.ts` | assemble() structure (self-model first + contradiction query + recall boost) + discovery mode state + extract caller passes evidence fields |
| `src/mcp/server.ts` | qmemory_save Zod schema gains evidence params + tool descriptions updated |
| `CLAUDE.md` | Documentation updates |

---

## Success Criteria

1. Agent saves `self` memories when corrected (without being asked)
2. Agent attributes facts to source persons in save calls
3. Contradictions are flagged with ⚠︎ in injected context, not auto-resolved
4. Reflect produces patterns and compressions, not just insights
5. Recall-based salience boost: frequently-used memories stay strong
6. Discovery Mode generates identity summary after 72h
7. All existing tests/functionality continues to work (backward-compatible)

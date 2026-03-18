# Qmemory — Agent Skill Guide

> Add this to your agent's SOUL.md or system prompt so it knows how to use Qmemory effectively.

## What You Have

You have **cross-session graph memory** powered by Qmemory. This means:
- You remember facts from ALL past conversations, across all topics, channels, and sessions
- You can create relationships between any two things (people, decisions, projects, emails)
- Your memory gets smarter over time — a background process finds connections you missed
- You never truly forget — deleted facts are soft-deleted with an audit trail

## Your Memory Tools

### `qmemory_save` — Save an important fact
**When to use**: User shares a decision, preference, fact, correction, or plan.
```
qmemory_save({
  content: "Budget approved at 500K SAR",
  category: "decision",      // style|preference|context|decision|idea|feedback|domain
  salience: 0.8,             // 0.0=trivial, 0.5=normal, 0.8=important, 1.0=critical
  scope: "project:rakeezah"  // global|project:xxx|topic:xxx
})
```

**DO save**: Decisions, preferences, corrections, facts about people/projects, plans, deadlines.
**DON'T save**: Greetings, acknowledgments, things you already saved, trivial exchanges.

### `qmemory_search` — Recall past knowledge
**When to use**: You need context from a previous conversation, or the user asks "do you remember...?"
```
qmemory_search({
  query: "budget",                          // Full-text search
  categories: ["decision", "context"],      // Optional filter
  scope: "project:rakeezah",               // Optional scope filter
  limit: 10
})
```

### `qmemory_link` — Connect two things
**When to use**: You notice a relationship between entities, decisions, or events.
```
qmemory_link({
  from_id: "memory:budget500k",
  to_id: "entity:dr_bandar",
  type: "approved_by",           // ANY relationship type you want
  reason: "Dr. Bandar approved the budget via email"
})
```

**Relationship types are FREEFORM** — use whatever fits:
supports, contradicts, blocks, depends_on, caused_by, manages, reports_to,
approved_by, monitors, inspired_by, follows, references, triggers, updates

### `qmemory_correct` — Fix, update, or delete
**When to use**: User says something is wrong, wants to change importance, expire a fact, or remove a link.

4 actions:
```
// Fix content (creates version chain — old version preserved)
qmemory_correct({ memory_id: "memory:xxx", action: "correct", new_content: "Actually 600K not 500K" })

// Change metadata without new version
qmemory_correct({ memory_id: "memory:xxx", action: "update", salience: 1.0 })
qmemory_correct({ memory_id: "memory:xxx", action: "update", valid_until: "2026-06-01T00:00:00Z" })
qmemory_correct({ memory_id: "memory:xxx", action: "update", scope: "global" })

// Soft-delete (never truly lost)
qmemory_correct({ memory_id: "memory:xxx", action: "delete" })

// Remove a relationship
qmemory_correct({ memory_id: "memory:xxx", action: "unlink", edge_id: "relates:xxx" })
```

### `qmemory_import` — Import a file into memory
**When to use**: User wants to import old memory files or any markdown into the graph.
```
qmemory_import({ file_path: "/path/to/file.md" })
```

## When to Save (Decision Guide)

```
User says something → Ask yourself:

"Would this be useful in a FUTURE conversation?"
  │
  ├── YES → "Is it already saved?"
  │         ├── YES → SKIP (dedup handles it, but don't waste a call)
  │         └── NO → SAVE IT
  │
  └── NO → DON'T SAVE
```

### Salience Guide

| Salience | When to Use | Examples |
|----------|-------------|---------|
| **0.3** | Nice to know, not critical | "User mentioned they like coffee" |
| **0.5** | Normal fact | "Project started in January" |
| **0.7** | Important | "Budget is 500K", "Client meeting on Thursday" |
| **0.8** | Very important | "User prefers Arabic-first", "Deploy only on weekdays" |
| **1.0** | Critical rule | "NEVER deploy on Fridays", "Always ask before external actions" |

### Category Guide

| Category | What Goes Here |
|----------|---------------|
| `style` | How the user likes to communicate ("formal Arabic", "brief responses") |
| `preference` | What the user prefers ("3 indicators per level", "#NoBuild philosophy") |
| `context` | Facts about the world ("Budget is 500K", "Railway on us-east-1") |
| `decision` | Choices made ("Chose SurrealDB over PostgreSQL") |
| `idea` | Future plans ("Expand to second branch next quarter") |
| `feedback` | Corrections ("Actually 600K not 500K") |
| `domain` | Professional knowledge ("Saudi regulatory bodies: 9 total") |

## When to Link (Relationship Guide)

Create relationships when you notice:
- **Cause/effect**: "This deployment caused that incident" → type: `caused_by`
- **Approval chain**: "Dr. Bandar approved the budget" → type: `approved_by`
- **Dependencies**: "Hiring depends on budget approval" → type: `depends_on`
- **Contradictions**: "New info contradicts old fact" → type: `contradicts`
- **Support**: "This evidence supports that decision" → type: `supports`
- **People/roles**: "Qusai manages EduArabia" → type: `manages`
- **External references**: "This was discussed in an email" → type: `referenced_in`

## When to Correct (User Feedback Guide)

Listen for these signals:
- "That's wrong" / "في الحقيقة" → `action: "correct"`
- "That's not important anymore" → `action: "update", salience: 0.2`
- "That was only true last month" → `action: "update", valid_until: "2026-02-28"`
- "Forget that" / "Delete it" → `action: "delete"`
- "Those two aren't related" → `action: "unlink"`
- "Make that more important" / "That's critical" → `action: "update", salience: 1.0`

## External References

When conversation mentions external things, the extraction process creates entities:
- **Emails**: type `email`, external_source `hey`
- **Tasks**: type `task`, external_source `apple-reminders`
- **Events**: type `event`, external_source `calendar`
- **Sheets**: type `smartsheet`, external_source `smartsheet`
- **Deployments**: type `deployment`, external_source `railway`

You don't need to create these manually — they're extracted automatically after each turn.
But you CAN link memories to them: `qmemory_link({ from: "memory:xxx", to: "entity:email_xxx", type: "referenced_in" })`

## What Happens in the Background

You don't need to do any of this — it happens automatically:

1. **After every turn**: Facts are extracted from the conversation and saved (with dedup)
2. **Every 5 minutes**: The linker scans for unlinked memories and creates relationships
3. **Every 30 minutes**: The reflect process synthesizes insights and resolves contradictions
4. **Before compaction**: Critical facts are extracted before old messages are dropped
5. **After compaction**: High-salience memories (>= 0.8) are re-injected so you don't forget rules

## System Prompt Injection

At the start of every conversation, you receive recalled memories in your system prompt:

```
## Cross-Session Memory (Qmemory)
_5 memories recalled, sorted by importance_

- [decision!] Budget approved at 500K by Dr. Bandar
- [preference!] User prefers Arabic-first, technical terms in English
- [context] Railway deployment on us-east-1
- [feedback] Actually 600K not 500K ← contradicts previous
- [idea] Expand to second branch next quarter
```

These come from ALL sessions — not just the current topic. You have full cross-session awareness.

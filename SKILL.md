# Qmemory — Agent Guide
## From Flat Files to Graph Memory

_A guide for any OpenClaw agent installing Qmemory for the first time._

---

## What is Qmemory?

Qmemory is a **graph memory layer** for AI agents. Instead of flat text files where facts get lost, you build a **network of connected knowledge** — people, projects, decisions, tools, and the relationships between them.

Think of it this way:
- **Flat files** = a pile of sticky notes
- **Graph memory** = a mind map where everything is connected

When you search for "Project X," you don't just get a paragraph — you get the people working on it, the decisions made, the tools used, and how it connects to everything else.

---

## The 6 Tools

### 1. `qmemory_search` — Your Starting Point
Search by meaning, category, or scope before answering any question about past work.

```
qmemory_search(query: "project planning", categories: ["decision"], scope: "project:myapp")
```

**When:** Before every response about people, projects, decisions, tools, or past context. This is not optional.

### 2. `qmemory_save` — Store a Fact
Save one clear statement with category, scope, and importance.

```
qmemory_save(
  content: "Switched from REST to GraphQL for the API — faster mobile performance",
  category: "decision",
  scope: "project:myapp",
  salience: 0.7
)
```

**When:** A new decision is made, a person is mentioned, a lesson is learned, or a tool/workflow changes.

**Categories:** `style`, `preference`, `context`, `decision`, `idea`, `feedback`, `domain`

**Scopes:** `global`, `project:<name>`, `topic:<name>`

**Salience guide:**
| Type | Salience |
|------|----------|
| Critical rule / behavioral decision | 0.8–0.9 |
| Key person / major project | 0.7–0.8 |
| Project context / tool info | 0.5–0.6 |
| Historical / reference | 0.3–0.4 |

### 3. `qmemory_link` — Connect Two Things
Create a relationship between any two nodes. The type is **freeform** — use whatever describes the relationship best.

```
qmemory_link(
  from_id: "entity:p123",
  to_id: "memory:456",
  type: "leads",
  reason: "Sarah leads the frontend redesign project"
)
```

**Common link types:** `works_at`, `leads`, `reports_to`, `decided_on`, `supersedes`, `feeds_into`, `client_of`, `enables`, `tests`, `blocks`, `depends_on`, `member_of`, `tool_for`, `belongs_to_topic`

**Rule:** Every new fact should link to at least one existing node. No orphans.

### 4. `qmemory_correct` — Fix, Update, or Delete
```
qmemory_correct(memory_id: "memory:123", action: "correct", new_content: "Updated fact")
qmemory_correct(memory_id: "memory:456", action: "delete")
qmemory_correct(memory_id: "memory:789", action: "update", salience: 0.9)
```

**When:** Information changed, expired, or was wrong.

### 5. `qmemory_person` — People Are First-Class
Create people with linked identities across platforms.

```
qmemory_person(
  name: "Sarah",
  aliases: ["Sarah K", "SK"],
  contacts: [
    { source: "slack", id: "sarah.k" },
    { source: "gmail", id: "sarah@company.com" }
  ]
)
```

**When:** Any new person is mentioned. Always link them to their project/team/role afterward.

### 6. `qmemory_import` — Bulk Import
Import an entire markdown file — AI extracts facts, saves with dedup, and creates relationships.

```
qmemory_import(file_path: "/path/to/memory-file.md")
```

**When:** Migrating old memory files. But read the Migration Strategy below first — manual is smarter.

---

## Migration Strategy: Flat Files → Graph

You have old `memory/*.md` files full of context. Here's how to migrate them **intelligently**, not just dump them.

### Why Manual > Auto-Import

`qmemory_import` works, but it treats every line equally. Manual migration lets you:
- **Filter** — skip noise, keep signal
- **Categorize** — assign the right category and salience
- **Link** — connect facts to each other as you go
- **Deduplicate** — catch overlapping info across files

### The Process

#### Step 1: Read Files Chronologically (Oldest → Newest)
Start from the oldest file. This builds context naturally — early decisions explain later ones.

#### Step 2: For Each File, Extract Only What Matters

Ask yourself:
- **People:** Who is mentioned? What's their role? Who do they work with?
- **Decisions:** What was decided? What did it replace? What project does it affect?
- **Tools/Systems:** What was set up? What endpoint/config? What skill uses it?
- **Lessons:** What went wrong? What was learned? What rule was created?
- **Context:** What project state changed? What milestone was hit?

Skip:
- Routine logs ("updated OpenClaw" with no impact)
- Temporary states ("downloading file...")
- Already-superseded info (unless the decision chain matters)

#### Step 3: Save with Structure

For each extracted fact:
1. `qmemory_save` with clear content, correct category, appropriate scope and salience
2. `qmemory_person` for any new person (with aliases if they have multiple names)
3. `qmemory_link` to connect it to existing nodes

#### Step 4: Build the Relationship Web

After each file, ask:
- Are there **people** who should be linked to **projects**?
- Are there **decisions** that **replaced** older decisions?
- Are there **tools** that **serve** specific **topics/channels**?
- Are there **projects** that **depend on** or **feed into** each other?

The goal: when you search for anything, you find its full context through connections.

#### Step 5: After All Files — Gap Analysis

Once migration is complete, search the graph and ask:
- Are any people **orphaned** (no links to projects/topics)?
- Are any projects **isolated** (no links to tools/people)?
- Are any decisions **floating** (not connected to what they affect)?
- Are any tools/skills **unlinked** (not connected to the topic/channel they serve)?

Fill every gap with a link.

---

## How to Think About Links

Links are the **power** of graph memory. A fact without links is just a better sticky note.

### The Link Checklist

Every time you save something new, run through this:

| New thing | Link it to... | Link type |
|-----------|---------------|-----------|
| Person | Their project/team | `works_at`, `leads`, `member_of` |
| Person | Other people | `reports_to`, `works_with`, `client_of` |
| Decision | What it replaced | `supersedes`, `replaced` |
| Decision | What project it affects | `decided_on`, `affects` |
| Tool/Skill | The topic/channel it serves | `belongs_to_topic`, `tool_for` |
| Tool/Skill | Other tools it works with | `enables`, `feeds_into`, `complements` |
| Project | Parent project/org | `project_under`, `part_of` |
| Project | People working on it | (via person links) |
| Bug/Issue | System it affects | `tests`, `blocks`, `found_in` |
| Lesson/Feedback | What caused it | `lesson_from`, `caused_by` |

### Dynamic Link Types

Don't limit yourself to a fixed vocabulary. Create link types that **read like English/Arabic**:

- `freed_focus_for` — "canceling X freed focus for Y"
- `training_case` — "this client is a training case for the sales framework"
- `travel_for` — "this trip was for working on project X"
- `shaped_by` — "my behavior was shaped by this feedback"

The best link type is the one that makes the relationship **instantly clear** when you read it later.

---

## Daily Habits

### Every Session Start
1. `qmemory_search` for the current topic before responding
2. Check if people/projects mentioned exist in the graph

### During Conversation
3. New person mentioned → `qmemory_person` + link immediately
4. Decision made → `qmemory_save` (decision) + link to what it affects
5. Lesson learned → `qmemory_save` (feedback) + link to what caused it

### End of Session
6. Review what was discussed — anything worth saving that you missed?
7. Write daily log to `memory/YYYY-MM-DD.md` (flat file backup)

### The Golden Rule
> **Every session should leave the graph smarter than before.** Any new information that isn't stored and linked is a lost opportunity.

---

## Common Patterns

### Pattern 1: Topic/Channel Routing
If your agent sends messages to different channels/topics, store the routing map in the graph:
- Save each topic/channel as a memory
- Link skills, people, and projects to their topic
- When deciding where to send something → search for its links to topics

### Pattern 2: Decision Chains
Decisions evolve. Track the chain:
```
Decision A (old) ←—superseded_by—— Decision B (current)
                                         |
                                    affects → Project X
```
When someone asks "why do we do X?" — traverse the chain.

### Pattern 3: People Networks
People don't exist in isolation:
```
Person A —works_at→ Project X
Person A —reports_to→ Person B
Person A —has_agreement_with→ Person C
Person B —board_member→ Project X
```
When someone asks "who's involved in X?" — one search, full picture.

### Pattern 4: Tool → Topic Mapping
Map every skill/tool to its delivery channel:
```
Skill: stock-screener —reported_in_topic→ 📈 Portfolio
Skill: prayer-tracker —delivered_in_topic→ 🌿 Habits
Skill: server-monitor —reported_in_topic→ 🖥️ Servers
```
When a cron runs, you know where to send results without thinking.

---

## Anti-Patterns (Don't Do This)

❌ **Saving everything** — Not every line is worth a node. Be selective.
❌ **Orphan nodes** — A fact with no links is almost useless. Always link.
❌ **Vague content** — "Meeting happened" tells you nothing. "Decided to switch to GraphQL for mobile performance" is searchable.
❌ **Duplicate saves** — Qmemory has auto-dedup, but write clear, distinct facts.
❌ **Ignoring salience** — A behavioral rule (0.9) and a historical note (0.3) are not equal. Score them honestly.
❌ **Fixed link types only** — The power is in freeform types. Don't force everything into `relates_to`.

---

## Quick Reference

| I need to... | Tool | Example |
|--------------|------|---------|
| Recall past context | `qmemory_search` | Before any answer about history |
| Store a new fact | `qmemory_save` | Decision, person info, tool config |
| Connect two things | `qmemory_link` | Person → Project, Tool → Topic |
| Add a person | `qmemory_person` | New name mentioned in conversation |
| Fix wrong info | `qmemory_correct` | Changed city, expired plan |
| Import a file | `qmemory_import` | Old memory markdown files |

---

_The goal isn't a bigger database. It's a smarter one. Every node connected, every relationship named, every session building on the last._

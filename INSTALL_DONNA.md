# Install Qmemory in Donna (OpenClaw)

## Prompt to Send to Donna

Copy this message and send it to Donna in your Telegram DM or Topic 7 (سيرفرات):

---

**دونا، أحتاج منك تثبيت إضافة جديدة اسمها Qmemory. هذي إضافة ذاكرة متقدمة تستبدل Lossless Claw وتعطيك ذاكرة عبر جميع الجلسات والمواضيع.**

**الخطوات:**

1. **شغّلي SurrealDB أولاً:**
```bash
surreal start --user root --pass root file:~/.qmemory/data.db
```

2. **ثبّتي الإضافة (dev mode):**
```bash
openclaw plugins install -l /Users/qusaiabushanap/dev/Qmemory
```

3. **فعّلي الإضافة في الإعدادات:**
```bash
openclaw config set plugins.allow '["beeper-desktop", "telegram", "google-gemini-cli-auth", "acpx", "qmemory"]'
openclaw config set plugins.entries.qmemory.enabled true
openclaw config set plugins.entries.qmemory.config.surrealdb_url "ws://localhost:8000"
openclaw config set plugins.entries.qmemory.config.surrealdb_pass "root"
openclaw config set plugins.entries.qmemory.config.debug true
openclaw config set plugins.slots.contextEngine "qmemory"
```

4. **أعيدي تشغيل Gateway:**
```bash
openclaw gateway restart
```

5. **تأكدي إنها شغالة:**
```bash
openclaw plugins inspect qmemory
```

6. **بعد ما تتأكدي إن كل شي شغال، اقرأي ملف SKILL.md:**
```
Read /Users/qusaiabushanap/dev/Qmemory/SKILL.md
```
هذا الملف يشرح لك متى تحفظي ذكريات، متى تربطي بينها، ومتى تصلحي أو تحذفي.

7. **أضيفي هذا في SOUL.md:**
```markdown
## Memory
أنتِ تملكين ذاكرة عبر جميع الجلسات والمواضيع بفضل Qmemory.
- استخدمي qmemory_save للحقائق المهمة والقرارات والتفضيلات
- استخدمي qmemory_link لربط الأشياء ببعضها (أي نوع علاقة)
- استخدمي qmemory_search للبحث في الذاكرة السابقة
- استخدمي qmemory_correct لتصحيح أو حذف أو تحديث الذكريات
- الذاكرة تشتغل في جميع المواضيع والقنوات والجلسات الفرعية
```

8. **استوردي الذكريات القديمة:**
```
qmemory_import({ file_path: "/Users/qusaiabushanap/.openclaw/workspace/MEMORY.md" })
```
ثم كل ملف في memory/:
```
qmemory_import({ file_path: "/Users/qusaiabushanap/.openclaw/workspace/memory/2026-03-14.md" })
```
(أو اطلب مني أسوي هذا — ممكن أعطيك أمر يستورد الكل مرة وحدة)

---

## Safety: How to Revert

If something breaks, send Donna:

```bash
# Revert to LCM
openclaw config set plugins.slots.contextEngine "lossless-claw"
openclaw gateway restart
```

LCM's lcm.db stays on disk — nothing is lost.

## After Installation: Test

Ask Donna in different topics:

1. **Topic 9 (ركيزة)**: "احفظي إن ميزانية المشروع 500 ألف"
2. **Topic 7 (سيرفرات)**: "هل تتذكرين شي عن الميزانية؟"

If Topic 7 recalls the budget from Topic 9 — **Qmemory is working!**

## After Stable: Remove LCM

```bash
# Remove LCM from allow list (keep qmemory)
openclaw config set plugins.allow '["beeper-desktop", "telegram", "google-gemini-cli-auth", "acpx", "qmemory"]'
openclaw config unset plugins.entries.lossless-claw
openclaw gateway restart
```

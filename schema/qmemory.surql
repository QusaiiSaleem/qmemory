-- ============================================================
-- Qmemory Schema — Graph Memory for AI Agents
-- SurrealDB 3.0+
--
-- 4 nodes: session, message, memory, entity
-- 3 structural edges: has_message, extracted_from, prev_version
-- 1 dynamic edge: relates (any relationship, any direction)
--
-- IDEMPOTENT: Safe to re-apply (IF NOT EXISTS on everything)
-- ============================================================

-- Schema version
DEFINE TABLE IF NOT EXISTS schema_version SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS version ON schema_version TYPE int;
DEFINE FIELD IF NOT EXISTS applied_at ON schema_version TYPE datetime DEFAULT time::now();

-- ============================================================
-- NODE: session
-- ============================================================

DEFINE TABLE IF NOT EXISTS session SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS session_key  ON session TYPE string;
DEFINE FIELD IF NOT EXISTS channel      ON session TYPE string;
DEFINE FIELD IF NOT EXISTS chat_type    ON session TYPE string;
DEFINE FIELD IF NOT EXISTS topic_id     ON session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS group_id     ON session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope        ON session TYPE string       DEFAULT "global";
DEFINE FIELD IF NOT EXISTS last_active  ON session TYPE datetime     DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS created_at   ON session TYPE datetime     DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_session_key ON session FIELDS session_key UNIQUE;

-- ============================================================
-- NODE: message
-- ============================================================

DEFINE TABLE IF NOT EXISTS message SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS session      ON message TYPE record<session>;
DEFINE FIELD IF NOT EXISTS role         ON message TYPE string;
DEFINE FIELD IF NOT EXISTS content      ON message TYPE string;
DEFINE FIELD IF NOT EXISTS tool_calls   ON message TYPE option<array>;
DEFINE FIELD IF NOT EXISTS tool_name    ON message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS token_count  ON message TYPE int           DEFAULT 0;
DEFINE FIELD IF NOT EXISTS created_at   ON message TYPE datetime      DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_message_session ON message FIELDS session;

-- ============================================================
-- NODE: memory
-- ============================================================

DEFINE TABLE IF NOT EXISTS memory SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS content      ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS category     ON memory TYPE string;
DEFINE FIELD IF NOT EXISTS salience     ON memory TYPE float          DEFAULT 0.5;
DEFINE FIELD IF NOT EXISTS valid_from   ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS valid_until  ON memory TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS scope        ON memory TYPE string         DEFAULT "global";
DEFINE FIELD IF NOT EXISTS is_active    ON memory TYPE bool           DEFAULT true;
DEFINE FIELD IF NOT EXISTS confidence   ON memory TYPE float          DEFAULT 0.8;
DEFINE FIELD IF NOT EXISTS source_type  ON memory TYPE string         DEFAULT "conversation";
DEFINE FIELD IF NOT EXISTS prev_version ON memory TYPE option<record<memory>>;
DEFINE FIELD IF NOT EXISTS embedding    ON memory TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS created_at   ON memory TYPE datetime       DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at   ON memory TYPE datetime       DEFAULT time::now();

-- BM25 full-text search — Arabic-safe analyzer (no ascii filter!)
DEFINE ANALYZER IF NOT EXISTS qmemory_analyzer TOKENIZERS blank, class FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS idx_memory_content ON memory FIELDS content FULLTEXT ANALYZER qmemory_analyzer;

DEFINE INDEX IF NOT EXISTS idx_memory_active    ON memory FIELDS is_active;
DEFINE INDEX IF NOT EXISTS idx_memory_category  ON memory FIELDS category;
DEFINE INDEX IF NOT EXISTS idx_memory_salience  ON memory FIELDS salience;
DEFINE INDEX IF NOT EXISTS idx_memory_scope     ON memory FIELDS scope;

-- ============================================================
-- NODE: entity
-- ============================================================

DEFINE TABLE IF NOT EXISTS entity SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name             ON entity TYPE string;
DEFINE FIELD IF NOT EXISTS type             ON entity TYPE string;
DEFINE FIELD IF NOT EXISTS aliases          ON entity TYPE array<string>  DEFAULT [];
DEFINE FIELD IF NOT EXISTS external_id      ON entity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS external_url     ON entity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS external_source  ON entity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS external_channel ON entity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS embedding        ON entity TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS created_at       ON entity TYPE datetime       DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at       ON entity TYPE datetime       DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_entity_name ON entity FIELDS name;
DEFINE INDEX IF NOT EXISTS idx_entity_type ON entity FIELDS type;
DEFINE INDEX IF NOT EXISTS idx_entity_external ON entity FIELDS external_source, external_id;

-- ============================================================
-- EDGE: has_message (structural)
-- ============================================================

DEFINE TABLE IF NOT EXISTS has_message SCHEMAFULL TYPE RELATION
    IN session OUT message;
DEFINE FIELD IF NOT EXISTS created_at ON has_message TYPE datetime DEFAULT time::now();

-- ============================================================
-- EDGE: extracted_from (structural)
-- ============================================================

DEFINE TABLE IF NOT EXISTS extracted_from SCHEMAFULL TYPE RELATION
    IN memory OUT message;
DEFINE FIELD IF NOT EXISTS created_at ON extracted_from TYPE datetime DEFAULT time::now();

-- ============================================================
-- EDGE: prev_version (structural)
-- ============================================================

DEFINE TABLE IF NOT EXISTS prev_version SCHEMAFULL TYPE RELATION
    IN memory OUT memory;

-- ============================================================
-- EDGE: relates (dynamic — agent creates any relationship)
-- ============================================================

DEFINE TABLE IF NOT EXISTS relates SCHEMAFULL TYPE RELATION
    IN session | message | memory | entity
    OUT session | message | memory | entity;

DEFINE FIELD IF NOT EXISTS type       ON relates TYPE string       DEFAULT "related";
DEFINE FIELD IF NOT EXISTS reason     ON relates TYPE option<string>;
DEFINE FIELD IF NOT EXISTS confidence ON relates TYPE float         DEFAULT 0.8;
DEFINE FIELD IF NOT EXISTS created_by ON relates TYPE string        DEFAULT "system";
DEFINE FIELD IF NOT EXISTS created_at ON relates TYPE datetime      DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_relates_type ON relates FIELDS type;
DEFINE INDEX IF NOT EXISTS idx_relates_created_by ON relates FIELDS created_by;

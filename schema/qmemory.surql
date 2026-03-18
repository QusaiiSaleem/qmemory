-- ============================================================
-- Qmemory Schema — Graph Memory for AI Agents
-- SurrealDB 3.0+
--
-- 4 nodes: session, message, memory, entity
-- 3 structural edges: has_message, extracted_from, prev_version
-- 1 dynamic edge: relates (any relationship, any direction)
-- ============================================================

-- Schema version (for migrations)
DEFINE TABLE schema_version SCHEMAFULL;
DEFINE FIELD version ON schema_version TYPE int;
DEFINE FIELD applied_at ON schema_version TYPE datetime DEFAULT time::now();

-- ============================================================
-- NODE: session
-- Represents a conversation context (topic, DM, cron, subagent)
-- ============================================================

DEFINE TABLE session SCHEMAFULL;
DEFINE FIELD session_key  ON session TYPE string;
DEFINE FIELD channel      ON session TYPE string;
DEFINE FIELD chat_type    ON session TYPE string;
DEFINE FIELD topic_id     ON session TYPE option<string>;
DEFINE FIELD group_id     ON session TYPE option<string>;
DEFINE FIELD scope        ON session TYPE string       DEFAULT "global";
DEFINE FIELD last_active  ON session TYPE datetime     DEFAULT time::now();
DEFINE FIELD created_at   ON session TYPE datetime     DEFAULT time::now();

DEFINE INDEX idx_session_key ON session FIELDS session_key UNIQUE;

-- ============================================================
-- NODE: message
-- Every message ingested from any session
-- ============================================================

DEFINE TABLE message SCHEMAFULL;
DEFINE FIELD session      ON message TYPE record<session>;
DEFINE FIELD role         ON message TYPE string;
DEFINE FIELD content      ON message TYPE string;
DEFINE FIELD tool_calls   ON message TYPE option<array>;
DEFINE FIELD tool_name    ON message TYPE option<string>;
DEFINE FIELD token_count  ON message TYPE int           DEFAULT 0;
DEFINE FIELD created_at   ON message TYPE datetime      DEFAULT time::now();

DEFINE INDEX idx_message_session ON message FIELDS session;

-- ============================================================
-- NODE: memory
-- Atomic facts — the brain of Qmemory
-- ============================================================

DEFINE TABLE memory SCHEMAFULL;
DEFINE FIELD content      ON memory TYPE string;
DEFINE FIELD category     ON memory TYPE string;
DEFINE FIELD salience     ON memory TYPE float          DEFAULT 0.5;
DEFINE FIELD valid_from   ON memory TYPE option<datetime>;
DEFINE FIELD valid_until  ON memory TYPE option<datetime>;
DEFINE FIELD scope        ON memory TYPE string         DEFAULT "global";
DEFINE FIELD is_active    ON memory TYPE bool           DEFAULT true;
DEFINE FIELD confidence   ON memory TYPE float          DEFAULT 0.8;
DEFINE FIELD source_type  ON memory TYPE string         DEFAULT "conversation";
DEFINE FIELD prev_version ON memory TYPE option<record<memory>>;
DEFINE FIELD embedding    ON memory TYPE option<array<float>>;
DEFINE FIELD created_at   ON memory TYPE datetime       DEFAULT time::now();
DEFINE FIELD updated_at   ON memory TYPE datetime       DEFAULT time::now();

-- BM25 full-text search (primary search method)
DEFINE ANALYZER qmemory_analyzer TOKENIZERS blank, class FILTERS lowercase, ascii;
DEFINE INDEX idx_memory_content ON memory FIELDS content FULLTEXT ANALYZER qmemory_analyzer;

-- Standard indexes for filtering
DEFINE INDEX idx_memory_active    ON memory FIELDS is_active;
DEFINE INDEX idx_memory_category  ON memory FIELDS category;
DEFINE INDEX idx_memory_salience  ON memory FIELDS salience;
DEFINE INDEX idx_memory_scope     ON memory FIELDS scope;

-- Vector index (optional — only used when embeddings are enabled)
-- DEFINE INDEX idx_memory_embedding ON memory FIELDS embedding
--     HNSW DIMENSION 1024 TYPE F32 DIST COSINE;

-- ============================================================
-- NODE: entity
-- People, projects, orgs, concepts, systems, contacts
--
-- MULTI-IDENTITY PATTERN:
-- A person entity links to multiple contact entities via `relates`:
--   entity:ahmed (type: "person")
--     → relates → entity:ahmed_wa (type: "contact") has_identity
--     → relates → entity:ahmed_email (type: "contact") has_identity
--     → relates → entity:ahmed_ss (type: "contact") has_identity
--
-- Entity types:
--   Core:     person, project, org, concept, system, topic
--   Contact:  contact (linked to a person via has_identity)
--   External: email, task, event, document, smartsheet, deployment, url
-- ============================================================

DEFINE TABLE entity SCHEMAFULL;
DEFINE FIELD name             ON entity TYPE string;
DEFINE FIELD type             ON entity TYPE string;
DEFINE FIELD aliases          ON entity TYPE array<string>  DEFAULT [];
-- Contact/external fields (used when type = "contact" or external types)
DEFINE FIELD external_id      ON entity TYPE option<string>;
-- Reference ID: "966501234567", "ahmed@example.com", "user:789"
DEFINE FIELD external_url     ON entity TYPE option<string>;
-- Direct URL: "https://wa.me/966501234567"
DEFINE FIELD external_source  ON entity TYPE option<string>;
-- Source system: "whatsapp", "telegram", "hey", "gmail", "apple-reminders",
-- "calendar", "smartsheet", "railway", "linkedin", "github"
DEFINE FIELD external_channel ON entity TYPE option<string>;
-- Channel-specific ID: WhatsApp phone, Telegram username, email address
DEFINE FIELD embedding        ON entity TYPE option<array<float>>;
DEFINE FIELD created_at       ON entity TYPE datetime       DEFAULT time::now();
DEFINE FIELD updated_at       ON entity TYPE datetime       DEFAULT time::now();

DEFINE INDEX idx_entity_name ON entity FIELDS name;
DEFINE INDEX idx_entity_type ON entity FIELDS type;
DEFINE INDEX idx_entity_external ON entity FIELDS external_source, external_id;

-- ============================================================
-- EDGE: has_message (structural)
-- session → message
-- ============================================================

DEFINE TABLE has_message SCHEMAFULL TYPE RELATION
    IN session OUT message;
DEFINE FIELD created_at ON has_message TYPE datetime DEFAULT time::now();

-- ============================================================
-- EDGE: extracted_from (structural)
-- memory → message (provenance: which message created this memory)
-- ============================================================

DEFINE TABLE extracted_from SCHEMAFULL TYPE RELATION
    IN memory OUT message;
DEFINE FIELD created_at ON extracted_from TYPE datetime DEFAULT time::now();

-- ============================================================
-- EDGE: prev_version (structural)
-- memory → memory (version chain: new points to old)
-- ============================================================

DEFINE TABLE prev_version SCHEMAFULL TYPE RELATION
    IN memory OUT memory;

-- ============================================================
-- EDGE: relates (dynamic — the agent creates any relationship)
-- ANY node → ANY node
-- ============================================================

DEFINE TABLE relates SCHEMAFULL TYPE RELATION
    IN session | message | memory | entity
    OUT session | message | memory | entity;

DEFINE FIELD type       ON relates TYPE string;
DEFINE FIELD reason     ON relates TYPE option<string>;
DEFINE FIELD confidence ON relates TYPE float          DEFAULT 0.8;
DEFINE FIELD created_by ON relates TYPE string;
DEFINE FIELD created_at ON relates TYPE datetime       DEFAULT time::now();

DEFINE INDEX idx_relates_type ON relates FIELDS type;
DEFINE INDEX idx_relates_created_by ON relates FIELDS created_by;

-- ============================================================
-- Set initial schema version
-- ============================================================

CREATE schema_version:v1 CONTENT {
    version: 1,
    applied_at: time::now()
};

/**
 * Save Memory with Deduplication
 *
 * When saving a new memory, we first check if it duplicates
 * or supersedes an existing one using the dedup pipeline:
 *
 *   1. BM25 search for similar existing memories (top 5)
 *   2. Run dedup() to get ADD / UPDATE / NOOP decision
 *   3. For ADD:    CREATE a new memory node
 *   4. For UPDATE: soft-delete old → CREATE new with prev_version link
 *   5. For NOOP:   skip (already known)
 *
 * Soft-delete = set is_active to false (never hard-delete).
 */

import { query, generateId } from "../db/client.js";
import { searchMemoriesBM25 } from "../db/queries.js";
import { dedup } from "./dedup.js";
import { generateEmbedding } from "./embeddings.js";
import type { EmbeddingConfig } from "./embeddings.js";
import { consoleLogger } from "../config.js";
import type {
  Memory,
  MemoryCategory,
  DedupAction,
  QmemoryLogger,
} from "../config.js";
import { trackEvent } from "./metrics.js";
import type { SubagentRunner } from "./dedup.js";

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setSaveLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SaveParams {
  content: string;
  category: MemoryCategory;
  salience?: number;
  scope?: string;
  source_type?: Memory["source_type"];
  /** Session ID for metrics tracking (optional, fire-and-forget) */
  sessionId?: string;
  /** Person name — resolved to entity record link */
  source_person?: string;
  /** How the fact was obtained: observed, reported, inferred, or self */
  evidence_type?: string;
  /** LLM confidence in the fact (0.0–1.0) */
  confidence?: number;
  /** Situational context (e.g. mood, setting) */
  context_mood?: string;
}

export interface SaveResult {
  action: DedupAction;
  memory_id: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Save a memory with deduplication.
 *
 * @param params          - The memory content, category, and optional metadata
 * @param subagentRunner  - Optional LLM function for smart dedup
 * @returns The action taken (ADD/UPDATE/NOOP) and the memory ID
 */
export async function saveMemory(
  params: SaveParams,
  subagentRunner?: SubagentRunner,
  embeddingConfig?: EmbeddingConfig,
): Promise<SaveResult> {
  const {
    content,
    category,
    salience = 0.5,
    scope = "global",
    source_type = "conversation",
  } = params;

  // --- Step 1: Search for similar existing memories ---
  const searchQ = searchMemoriesBM25(content, "any", 0.0, 5);
  const existing = await query<Memory>(searchQ.surql, searchQ.params);
  const candidates = existing ?? [];

  logger.debug(`Save: found ${candidates.length} candidates for dedup`);

  // --- Resolve source_person name → entity record reference (case-insensitive) ---
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

  // --- Step 2: Run dedup to decide what to do ---
  const decision = await dedup(content, candidates, subagentRunner, {
    category: params.category,
    confidence: params.confidence,
    source_person: params.source_person,
    evidence_type: params.evidence_type,
  });
  logger.info(`Save: dedup decision = ${decision.action} (confidence: ${decision.confidence})`);

  // --- Step 3: Execute the decision ---

  // Track dedup decision (fire-and-forget)
  if (params.sessionId) {
    const eventMap: Record<string, string> = { ADD: "dedup_add", UPDATE: "dedup_update", NOOP: "dedup_noop" };
    trackEvent(params.sessionId, eventMap[decision.action] ?? "dedup_add").catch(() => {});
  }

  if (decision.action === "NOOP") {
    // Already known — return the existing memory ID
    const existingId = decision.target_id ?? candidates[0]?.id ?? "";
    logger.debug(`Save: NOOP — memory already exists as ${existingId}`);
    return { action: "NOOP", memory_id: existingId };
  }

  // --- Build optional evidence fields (SurrealDB 3.0: omit nulls for option<> fields) ---
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

  if (decision.action === "UPDATE" && decision.target_id) {
    // Soft-delete the old memory
    await query(
      `UPDATE type::record($oldId) SET is_active = false, updated_at = time::now();`,
      { oldId: decision.target_id },
    );
    logger.debug(`Save: soft-deleted old memory ${decision.target_id}`);

    // Create the new memory with prev_version pointing to old
    const newId = generateId("memory:");
    await query(
      `CREATE type::record($newId) CONTENT {
        content: $content,
        category: $category,
        salience: $salience,
        scope: $scope,
        is_active: true,
        confidence: $confidence,
        source_type: $sourceType,
        ${evidenceFields.join("\n          ")}
        prev_version: type::record($prevVersion),
        created_at: time::now(),
        updated_at: time::now()
      };`,
      {
        newId,
        content,
        category,
        salience,
        scope,
        confidence: params.confidence ?? decision.confidence,
        sourceType: source_type,
        prevVersion: decision.target_id,
        ...evidenceParams,
      },
    );

    // Also create a prev_version edge for graph traversal
    await query(
      `LET $f = type::record($newId); LET $t = type::record($oldId); RELATE $f->prev_version->$t;`,
      { newId, oldId: decision.target_id },
    );

    logger.info(`Save: UPDATE — created ${newId} replacing ${decision.target_id}`);

    // Generate embedding for updated memory
    if (embeddingConfig && embeddingConfig.provider !== "none") {
      try {
        const embedding = await generateEmbedding(content, embeddingConfig);
        if (embedding) {
          await query(
            `UPDATE type::record($id) SET embedding = $embedding`,
            { id: newId, embedding },
          );
        }
      } catch { /* non-fatal */ }
    }

    return { action: "UPDATE", memory_id: newId };
  }

  // --- ADD: create a brand new memory ---
  const newId = generateId("memory:");
  await query(
    `CREATE type::record($newId) CONTENT {
      content: $content,
      category: $category,
      salience: $salience,
      scope: $scope,
      is_active: true,
      confidence: $confidence,
      source_type: $sourceType,
      ${evidenceFields.join("\n        ")}
      created_at: time::now(),
      updated_at: time::now()
    };`,
    {
      newId,
      content,
      category,
      salience,
      scope,
      confidence: params.confidence ?? 0.8,
      sourceType: source_type,
      ...evidenceParams,
    },
  );

  logger.info(`Save: ADD — created new memory ${newId}`);

  // Generate and store embedding (non-blocking — don't fail the save)
  if (embeddingConfig && embeddingConfig.provider !== "none") {
    try {
      const embedding = await generateEmbedding(content, embeddingConfig);
      if (embedding) {
        await query(
          `UPDATE type::record($id) SET embedding = $embedding`,
          { id: newId, embedding },
        );
        logger.debug(`Save: embedding stored for ${newId} (${embedding.length}d)`);
      }
    } catch (e) {
      logger.debug(`Save: embedding failed (non-fatal): ${e}`);
    }
  }

  return { action: "ADD", memory_id: newId };
}

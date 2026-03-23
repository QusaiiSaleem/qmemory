/**
 * Parameterized SurrealQL Queries
 *
 * All database queries live here as functions that return
 * { surql, params } objects. This keeps raw SurrealQL out
 * of the core logic and makes queries testable in isolation.
 *
 * Every query:
 * - Uses $param syntax (never string interpolation)
 * - Filters by is_active = true (soft-delete aware)
 * - Checks valid_until (NULL = still valid, or > now)
 * - Sorts by salience DESC (most important first)
 */

// ---------------------------------------------------------------------------
// Query result type (what every function returns)
// ---------------------------------------------------------------------------

export interface PreparedQuery {
  surql: string;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Memory queries
// ---------------------------------------------------------------------------

/** Find active memories filtered by scope with minimum salience */
export function findMemoriesByScope(
  scope: string,
  minSalience: number,
  limit: number,
): PreparedQuery {
  return {
    surql: `
      SELECT * FROM memory
      WHERE is_active = true
        AND scope = $scope
        AND salience >= $minSalience
        AND (valid_until IS NONE OR valid_until > time::now())
      ORDER BY salience DESC
      LIMIT $limit;
    `,
    params: { scope, minSalience, limit },
  };
}

/** BM25 full-text search on memory content, scoped and filtered */
export function searchMemoriesBM25(
  query: string,
  scope: string,
  minSalience: number,
  limit: number,
): PreparedQuery {
  return {
    surql: `
      SELECT * FROM memory
      WHERE content @@ $query
        AND is_active = true
        AND ($scope = "any" OR scope = $scope)
        AND salience >= $minSalience
        AND (valid_until IS NONE OR valid_until > time::now())
      ORDER BY salience DESC
      LIMIT $limit;
    `,
    params: { query, scope, minSalience, limit },
  };
}

/** Vector similarity search on memory embeddings (scope-aware) */
export function searchMemoriesVector(
  queryEmbedding: number[],
  limit: number,
  scope: string = "any",
): PreparedQuery {
  return {
    surql: `
      SELECT *, vector::similarity::cosine(embedding, $queryEmbedding) AS vec_score
      FROM memory
      WHERE is_active = true
        AND embedding IS NOT NONE
        AND ($scope = "any" OR scope = $scope OR scope = "global")
        AND (valid_until IS NONE OR valid_until > time::now())
      ORDER BY vec_score DESC
      LIMIT $limit
    `,
    params: { queryEmbedding, limit, scope },
  };
}

/** Find memories not yet processed by linker (uses indexed boolean) */
export function findUnlinkedMemories(limit: number): PreparedQuery {
  return {
    surql: `
      SELECT * FROM memory
      WHERE is_active = true
        AND linked = false
      ORDER BY created_at DESC
      LIMIT $limit;
    `,
    params: { limit },
  };
}

/** Find memories connected to a given memory via 'relates' edges (both directions) */
export function findRelatedMemories(memoryId: string): PreparedQuery {
  return {
    surql: `
      SELECT
        <-relates<-memory AS inbound,
        ->relates->memory AS outbound
      FROM type::record($memoryId);
    `,
    params: { memoryId },
  };
}

/**
 * Batch-fetch connection hints for multiple memory IDs.
 * Returns each memory's outgoing and incoming relates edges with target info.
 * Used by search to enrich top results with "Connection Hints".
 *
 * NOTE: SurrealDB doesn't support parameterized record ID lists in SELECT FROM,
 * so we build the ID list as a string. The IDs come from our own DB (not user input).
 */
export function getConnectionHints(memoryIds: string[]): PreparedQuery {
  // Build comma-separated list: memory:`id1`, memory:`id2`, ...
  const idList = memoryIds.map((id) => {
    const bare = id.startsWith("memory:") ? id.slice(7) : id;
    return `memory:\`${bare}\``;
  }).join(", ");

  return {
    surql: `
      SELECT
        id,
        ->relates.{type, reason, out, confidence} AS outgoing,
        <-relates.{type, reason, in, confidence} AS incoming
      FROM ${idList}
    `,
    params: {},
  };
}

/**
 * Resolve node IDs to their display names.
 * Works for both entities (name field) and memories (content snippet).
 */
export function resolveNodeNames(nodeIds: string[]): PreparedQuery {
  const idList = nodeIds.map((id) => {
    const [table, bare] = id.includes(":") ? id.split(":", 2) : ["memory", id];
    return `${table}:\`${bare}\``;
  }).join(", ");

  return {
    surql: `SELECT id, name, type FROM entity WHERE id IN [${idList}];
            SELECT id, string::slice(content, 0, 80) AS snippet, category FROM memory WHERE id IN [${idList}];`,
    params: {},
  };
}

/** Get or create a session by session_key using UPSERT (leverages unique index) */
export function findOrCreateSession(
  sessionKey: string,
  channel: string,
  chatType: string,
): PreparedQuery {
  return {
    surql: `
      UPSERT session SET
        session_key = $sessionKey,
        channel = $channel,
        chat_type = $chatType,
        scope = "global",
        last_active = time::now(),
        created_at = created_at ?? time::now()
      WHERE session_key = $sessionKey;
    `,
    params: { sessionKey, channel, chatType },
  };
}

/** Find an entity by exact name match */
export function findEntityByName(name: string): PreparedQuery {
  return {
    surql: `
      SELECT * FROM entity
      WHERE name = $name
         OR $name IN aliases
      LIMIT 1;
    `,
    params: { name },
  };
}

/** Get the most recent active memories (fallback tier, scope-aware) */
export function getRecentMemories(limit: number, scope: string = "any"): PreparedQuery {
  return {
    surql: `
      SELECT * FROM memory
      WHERE is_active = true
        AND ($scope = "any" OR scope = $scope OR scope = "global")
        AND (valid_until IS NONE OR valid_until > time::now())
      ORDER BY created_at DESC
      LIMIT $limit;
    `,
    params: { limit, scope },
  };
}

/**
 * Get the full graph picture for the agent.
 * Returns entities + their connections + orphan count + stats.
 * This is the "world map" the agent sees at session start.
 */
export function getGraphEntities(): PreparedQuery {
  return {
    surql: `
      SELECT
        id, name, type, aliases, external_source, external_id,
        count(->relates) AS outgoing,
        count(<-relates) AS incoming,
        count(->relates) + count(<-relates) AS total_links
      FROM entity
      ORDER BY total_links DESC
      LIMIT 50
    `,
    params: {},
  };
}

export function getGraphEdges(): PreparedQuery {
  return {
    surql: `
      SELECT
        in AS from_node,
        out AS to_node,
        type,
        reason,
        created_by,
        created_at
      FROM relates
      ORDER BY created_at DESC
      LIMIT 100
    `,
    params: {},
  };
}

export function getGraphStats(): PreparedQuery {
  return {
    surql: `
      SELECT count() AS total FROM memory WHERE is_active = true GROUP ALL
    `,
    params: {},
  };
}

/**
 * Get memories for a specific scope, valid at a given time,
 * above a minimum salience threshold.
 */
export function getMemoriesForScope(
  scope: string,
  validAt: string,
  minSalience: number,
  limit: number,
): PreparedQuery {
  return {
    surql: `
      SELECT * FROM memory
      WHERE is_active = true
        AND ($scope = "any" OR scope = $scope)
        AND salience >= $minSalience
        AND (valid_from IS NONE OR valid_from <= type::datetime($validAt))
        AND (valid_until IS NONE OR valid_until > type::datetime($validAt))
      ORDER BY salience DESC
      LIMIT $limit;
    `,
    params: { scope, validAt, minSalience, limit },
  };
}

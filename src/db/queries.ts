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

/** Find memories with zero outgoing 'relates' edges (for linker) */
export function findUnlinkedMemories(limit: number): PreparedQuery {
  return {
    surql: `
      SELECT * FROM memory
      WHERE is_active = true
        AND count(->relates) = 0
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

/** Get or create a session by session_key (upsert pattern) */
export function findOrCreateSession(
  sessionKey: string,
  channel: string,
  chatType: string,
): PreparedQuery {
  return {
    surql: `
      LET $existing = (SELECT * FROM session WHERE session_key = $sessionKey LIMIT 1);
      IF array::len($existing) > 0 {
        UPDATE $existing[0].id SET last_active = time::now();
        RETURN $existing[0];
      } ELSE {
        CREATE session CONTENT {
          session_key: $sessionKey,
          channel: $channel,
          chat_type: $chatType,
          scope: "global",
          last_active: time::now(),
          created_at: time::now()
        };
      };
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

/** Get the most recent active memories (fallback tier) */
export function getRecentMemories(limit: number): PreparedQuery {
  return {
    surql: `
      SELECT * FROM memory
      WHERE is_active = true
        AND (valid_until IS NONE OR valid_until > time::now())
      ORDER BY created_at DESC
      LIMIT $limit;
    `,
    params: { limit },
  };
}

/**
 * Get the full graph picture for the agent.
 * Returns entities + their connections + orphan count + stats.
 * This is the "world map" the agent sees at session start.
 */
export function getGraphSummary(): PreparedQuery {
  return {
    surql: `
      -- 1. All entities with their relationship counts
      SELECT
        id, name, type, aliases, external_source, external_id,
        count(->relates) AS outgoing,
        count(<-relates) AS incoming
      FROM entity
      ORDER BY (outgoing + incoming) DESC
      LIMIT 30;

      -- 2. All relationship edges (up to 100)
      SELECT
        in AS from,
        out AS to,
        type,
        reason,
        created_by
      FROM relates
      ORDER BY created_at DESC
      LIMIT 100;

      -- 3. Orphan memories (no relationships — need linking)
      SELECT count() AS count FROM memory
      WHERE is_active = true
        AND count(->relates) = 0
        AND count(<-relates) = 0
      GROUP ALL;

      -- 4. Total stats
      SELECT
        (SELECT count() FROM memory WHERE is_active = true GROUP ALL)[0].count AS memories,
        (SELECT count() FROM entity GROUP ALL)[0].count AS entities,
        (SELECT count() FROM relates GROUP ALL)[0].count AS edges,
        (SELECT count() FROM session GROUP ALL)[0].count AS sessions;
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

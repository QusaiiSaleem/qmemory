/**
 * Dynamic Relationship Linking
 *
 * Creates 'relates' edges between any two nodes in the graph.
 * The agent can link memories, entities, sessions — anything.
 *
 * The relationship type is freeform: "supports", "contradicts",
 * "manages", "blocks", "depends_on", etc.
 *
 * Both nodes must exist before an edge can be created.
 */

import { query, generateId } from "../db/client.js";
import { consoleLogger } from "../config.js";
import type { QmemoryLogger } from "../config.js";

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

let logger: QmemoryLogger = consoleLogger;

/** Allow callers to inject a custom logger */
export function setLinkLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinkParams {
  from_id: string;
  to_id: string;
  type: string;
  reason?: string;
  created_by?: "agent" | "linker" | "compact" | "reflect";
}

export interface LinkResult {
  edge_id: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Create a 'relates' edge between two nodes.
 *
 * @param params - The source ID, target ID, relationship type, and optional metadata
 * @returns The ID of the newly created edge
 * @throws If either node does not exist
 */
export async function linkNodes(params: LinkParams): Promise<LinkResult> {
  const {
    from_id,
    to_id,
    type,
    reason,
    created_by = "agent",
  } = params;

  // --- Validate both nodes exist ---
  const fromExists = await query(
    `SELECT id FROM type::record($nodeId) LIMIT 1;`,
    { nodeId: from_id },
  );
  if (!fromExists || fromExists.length === 0) {
    logger.warn(`Link: source node ${from_id} not found`);
    throw new Error(`Source node not found: ${from_id}`);
  }

  const toExists = await query(
    `SELECT id FROM type::record($nodeId) LIMIT 1;`,
    { nodeId: to_id },
  );
  if (!toExists || toExists.length === 0) {
    logger.warn(`Link: target node ${to_id} not found`);
    throw new Error(`Target node not found: ${to_id}`);
  }

  // --- Create the relates edge ---
  const edgeId = generateId("relates:");
  await query(
    `RELATE type::record($fromId)->relates->type::record($toId) CONTENT {
      type: $relType,
      reason: $reason,
      confidence: 0.8,
      created_by: $createdBy,
      created_at: time::now()
    };`,
    {
      fromId: from_id,
      toId: to_id,
      relType: type,
      reason: reason ?? null,
      createdBy: created_by,
    },
  );

  logger.info(`Link: created ${from_id} —[${type}]→ ${to_id}`);
  return { edge_id: edgeId };
}

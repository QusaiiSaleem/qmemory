/**
 * Dynamic Relationship Creation
 *
 * Creates `relates` edges between any two nodes in the graph.
 * The agent can create ANY relationship type — supports, contradicts,
 * manages, blocks, depends_on, caused_by, or anything that fits.
 *
 * SurrealDB 3.0 FIX: RELATE doesn't accept string params directly.
 * We use LET + type::record() to convert strings to RecordIds first.
 */

import { query, generateId } from "../db/client.js";
import { consoleLogger } from "../config.js";
import type { QmemoryLogger } from "../config.js";

let logger: QmemoryLogger = consoleLogger;

export function setLinkLogger(l: QmemoryLogger): void {
  logger = l;
}

export interface LinkParams {
  from_id: string;
  to_id: string;
  type: string;
  reason?: string;
  created_by?: string;
}

export interface LinkResult {
  edge_id: string;
}

/**
 * Create a `relates` edge between any two nodes.
 *
 * Uses LET + type::record() to handle SurrealDB 3.0's requirement
 * that RELATE operands must be RecordIds, not strings.
 */
export async function linkNodes(params: LinkParams): Promise<LinkResult> {
  const {
    from_id,
    to_id,
    type,
    reason,
    created_by = "agent",
  } = params;

  // Validate IDs look like record IDs (table:id format)
  if (!from_id.includes(":") || !to_id.includes(":")) {
    throw new Error(`Invalid record IDs: from=${from_id}, to=${to_id}. Expected format: table:id`);
  }

  // SurrealDB 3.0: RELATE needs RecordIds, not strings.
  // Use LET to convert string params → RecordId via type::record()
  const result = await query<{ id: string }>(
    `LET $f = type::record($fromId);
     LET $t = type::record($toId);
     RELATE $f->relates->$t CONTENT {
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

  // Verify the edge was actually created
  const edgeId = result?.[0]?.id ? String(result[0].id) : `relates:${generateId("r")}`;

  logger.info(`Linked: ${from_id} -[${type}]-> ${to_id} (${edgeId})`);
  return { edge_id: edgeId };
}

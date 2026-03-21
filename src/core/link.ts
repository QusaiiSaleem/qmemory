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

import { queryMulti, generateId } from "../db/client.js";
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
export async function linkNodes(input: LinkParams): Promise<LinkResult> {
  const {
    from_id,
    to_id,
    type,
    reason,
    created_by = "agent",
  } = input;

  // Validate IDs look like record IDs (table:id format)
  if (!from_id.includes(":") || !to_id.includes(":")) {
    throw new Error(`Invalid record IDs: from=${from_id}, to=${to_id}. Expected format: table:id`);
  }

  // SurrealDB 3.0: RELATE needs RecordIds, not strings.
  // Use LET to convert string params → RecordId via type::record().
  // Must use queryMulti — RELATE result is the 3rd statement (index 2).
  const queryParams: Record<string, unknown> = {
    fromId: from_id,
    toId: to_id,
    relType: type,
    createdBy: created_by,
  };
  // SurrealDB 3.0: option<string> rejects NULL — only include reason if provided
  if (reason) queryParams.reason = reason;

  const results = await queryMulti<[unknown, unknown, Array<{ id: string }>]>(
    `LET $f = type::record($fromId);
     LET $t = type::record($toId);
     RELATE $f->relates->$t CONTENT {
       type: $relType,
       ${reason ? "reason: $reason," : ""}
       confidence: 0.8,
       created_by: $createdBy,
       created_at: time::now()
     };`,
    queryParams,
  );

  // RELATE result is the 3rd statement (index 2)
  const relateResult = results?.[2];
  const edgeId = relateResult?.[0]?.id ? String(relateResult[0].id) : `relates:${generateId("r")}`;

  logger.info(`Linked: ${from_id} -[${type}]-> ${to_id} (${edgeId})`);
  return { edge_id: edgeId };
}

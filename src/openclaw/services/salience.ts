/**
 * Salience Decay — old memories gradually lose importance
 *
 * Piggybacks on linker schedule (pure DB, no LLM cost).
 * 3-tier biological model:
 *   Tier 1: Never recalled + old → fast decay (x0.90)
 *   Tier 2: Recalled but stale (last_recalled > 14d) → slow decay (x0.98)
 *   Tier 3: Recalled 5+ times → cemented, never below 0.5 (no decay applied)
 */

import { query } from "../../db/client.js";
import type { QmemoryLogger } from "../../config.js";

export async function runSalienceDecay(logger: QmemoryLogger): Promise<void> {
  try {
    // Tier 1: Never recalled + old → fast decay (×0.90)
    const neverRecalled = await query<{ id: string }>(
      `SELECT id FROM memory
       WHERE is_active = true AND salience > 0.15
         AND recall_count = 0
         AND updated_at < time::now() - 7d`,
    );
    if (neverRecalled?.length) {
      await query(
        `UPDATE memory SET salience = math::max(salience * 0.90, 0.1),
           updated_at = time::now()
         WHERE id IN $ids`,
        { ids: neverRecalled.map(r => r.id) },
      );
      logger.info(`Salience decay: ${neverRecalled.length} never-recalled memories decayed (×0.90)`);
    }

    // Tier 2: Recalled but stale (last_recalled > 14d) → slow decay (×0.98)
    const staleRecalled = await query<{ id: string }>(
      `SELECT id FROM memory
       WHERE is_active = true AND salience > 0.15
         AND recall_count > 0
         AND last_recalled < time::now() - 14d`,
    );
    if (staleRecalled?.length) {
      await query(
        `UPDATE memory SET salience = math::max(salience * 0.98, 0.1),
           updated_at = time::now()
         WHERE id IN $ids`,
        { ids: staleRecalled.map(r => r.id) },
      );
      logger.info(`Salience decay: ${staleRecalled.length} stale-recalled memories decayed (×0.98)`);
    }

    // Tier 3: Recalled 5+ times → cemented, never below 0.5 (no decay applied)
  } catch (error) {
    logger.debug(`Salience decay failed: ${error}`);
  }
}

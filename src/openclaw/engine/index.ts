/**
 * Qmemory Context Engine — Factory
 *
 * Implements the full OpenClaw ContextEngine interface.
 * Delegates to sub-modules: bootstrap, assemble, compact, session.
 */

import {
  setLogger,
} from "../../db/client.js";
import { recall } from "../../core/recall.js";
import { formatMemories } from "../../config.js";
import { setScratchpadLogger } from "../../core/scratchpad.js";
import { setMetricsLogger } from "../../core/metrics.js";
import type { QmemoryConfig, QmemoryLogger } from "../../config.js";
import type { EmbeddingConfig } from "../../core/embeddings.js";
import type { SubagentRunner } from "../index.js";
import type { SharedEngineState } from "../hooks.js";
import { bootstrap } from "./bootstrap.js";
import { assemble, type AssembleState } from "./assemble.js";
import { compact, afterTurn } from "./compact.js";
import { ingestMessage, setSessionLogger } from "./session.js";

// ---------------------------------------------------------------------------
// Engine factory — returns the ContextEngine object
// ---------------------------------------------------------------------------

export function createEngine(
  config: QmemoryConfig,
  logger: QmemoryLogger,
  subagentRunner?: SubagentRunner,
  _openclawConfig?: Record<string, unknown>,
  embeddingConfig?: EmbeddingConfig,
  sharedState?: SharedEngineState,
) {
  // Track the current session for this engine instance
  let currentSessionId: string | null = null;
  let currentSessionKey: string | null = null;
  let isDiscoveryMode = false;

  // Assemble state (graph map cache, tools guide flag)
  const assembleState: AssembleState = {
    graphMapCache: null,
    graphMapCacheTime: 0,
    hasShownToolsGuide: false,
  };

  // Set the logger on the DB client, core modules, and session module
  setLogger(logger);
  setScratchpadLogger(logger);
  setMetricsLogger(logger);
  setSessionLogger(logger);

  function invalidateGraphCache() {
    assembleState.graphMapCache = null;
  }

  return {
    // ----- Engine metadata -----
    info: {
      id: "qmemory",
      name: "Qmemory",
      version: "0.1.0",
      // We own compaction — OpenClaw won't run its built-in compaction
      ownsCompaction: true,
    },

    // -----------------------------------------------------------------
    // bootstrap() — Called once when a session starts
    // -----------------------------------------------------------------
    async bootstrap(params: {
      sessionId: string;
      sessionKey?: string;
      channel?: string;
      chatType?: string;
      topicId?: string;
      groupId?: string;
      scope?: string;
    }) {
      const result = await bootstrap(
        params, config, logger, subagentRunner,
        _openclawConfig, embeddingConfig, sharedState,
      );

      if (result.bootstrapped) {
        currentSessionId = result.currentSessionId ?? null;
        currentSessionKey = result.currentSessionKey ?? null;
        isDiscoveryMode = result.isDiscoveryMode ?? false;
        assembleState.hasShownToolsGuide = false; // Reset for new session
      }

      return { bootstrapped: result.bootstrapped };
    },

    // -----------------------------------------------------------------
    // ingest() — Called for each new message
    // -----------------------------------------------------------------
    async ingest(params: {
      role: string;
      content: string;
      toolCalls?: unknown[];
      toolName?: string;
    }) {
      if (!currentSessionId) {
        logger.warn("ingest() called before bootstrap — skipping");
        return { ingested: false };
      }

      return ingestMessage(params, currentSessionId, logger);
    },

    // -----------------------------------------------------------------
    // assemble() — Called before sending context to the LLM
    // -----------------------------------------------------------------
    async assemble(params: {
      messages: unknown[];
      tokenBudget: number;
      sessionKey?: string;
    }) {
      return assemble(
        params, config, logger,
        currentSessionId, currentSessionKey,
        isDiscoveryMode, sharedState, assembleState,
      );
    },

    // -----------------------------------------------------------------
    // compact() — Called when context window exceeds threshold
    // -----------------------------------------------------------------
    async compact(params: {
      messages: unknown[];
      tokenBudget: number;
      currentTokenCount: number;
    }) {
      return compact(
        params, config, logger,
        subagentRunner, embeddingConfig,
        currentSessionId, isDiscoveryMode,
        invalidateGraphCache,
      );
    },

    // -----------------------------------------------------------------
    // afterTurn() — Called after the agent responds (async, non-blocking)
    // -----------------------------------------------------------------
    async afterTurn(params: {
      messages: unknown[];
      tokenBudget?: number;
      currentTokenCount?: number;
    }) {
      return afterTurn(
        params, config, logger,
        subagentRunner, embeddingConfig,
        currentSessionId, currentSessionKey,
        isDiscoveryMode, invalidateGraphCache,
      );
    },

    // -----------------------------------------------------------------
    // prepareSubagentSpawn() — Called when a subagent is about to start
    // -----------------------------------------------------------------
    async prepareSubagentSpawn(params: {
      parentSessionKey: string;
      childSessionKey: string;
      task?: string;
    }) {
      let context = "";

      if (params.task) {
        try {
          const relevant = await recall({
            query: params.task,
            limit: 10,
            token_budget: 2000,
          });

          if (relevant.length > 0) {
            context = formatMemories(relevant);
            logger.debug(
              `Sharing ${relevant.length} memories with child session`,
            );
          }
        } catch (error) {
          logger.warn(`Failed to prepare subagent context: ${error}`);
        }
      }

      return { context };
    },

    // -----------------------------------------------------------------
    // onSubagentEnded() — Called when a subagent finishes
    // -----------------------------------------------------------------
    async onSubagentEnded(params: {
      childSessionKey: string;
      reason: string;
      output?: string;
    }) {
      logger.debug(
        `Subagent ended: ${params.childSessionKey} (${params.reason})`,
      );
    },

    // -----------------------------------------------------------------
    // dispose() — Called when an agent run ends
    // -----------------------------------------------------------------
    async dispose() {
      logger.debug("Engine dispose (connection kept alive)");
    },
  };
}

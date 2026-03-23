/**
 * Qmemory — OpenClaw Plugin Entry Point
 *
 * Registers Qmemory as a context-engine plugin,
 * plus 6 agent tools, a background linker service,
 * and an HTTP route for the graph viewer.
 *
 * This is the "deepest" integration — full context engine
 * that owns bootstrap, ingest, assemble, compact, and afterTurn.
 */

import { createEngine } from "./engine.js";
import { createLinkerService } from "./linker.js";
import { resolveEmbeddingConfig, setEmbeddingLogger } from "../core/embeddings.js";
import { handleGraphRequest } from "../ui/graph-handler.js";
import { registerAllTools } from "./tools/index.js";
import { AGENT_SYSTEM_CONTEXT } from "./tools/system-context.js";
import {
  createAfterToolCallHandler,
  createToolResultPersistHandler,
  createAgentEndHandler,
  createLlmOutputHandler,
  createSubagentSpawnedHandler,
  createSubagentEndedHandler,
  createSubagentDeliveryTargetHandler,
  createSessionStartHandler,
  createSessionEndHandler,
  createMessageReceivedHandler,
  createMessageSentHandler,
} from "./hooks.js";
import type { SharedEngineState } from "./hooks.js";
import type {
  QmemoryConfig,
  QmemoryLogger,
} from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Subagent runner type — wraps OpenClaw's subagent API into a simple function
// ---------------------------------------------------------------------------

export type SubagentRunner = (task: string) => Promise<string>;

let subagentCounter = 0;

function createSubagentRunner(api: any, model: string): SubagentRunner {
  return async (task: string): Promise<string> => {
    // Generate a unique session key for this subagent run
    const sessionKey = `qmemory:subagent:${Date.now()}-${++subagentCounter}`;

    try {
      // 1. Start the subagent run (use configured model for background tasks)
      const { runId } = await api.runtime.subagent.run({
        sessionKey,
        message: task,
        idempotencyKey: `qmem-${Date.now()}-${subagentCounter}`,
        lane: "subagent",
        model,  // Use configurable model (default: zai/glm-5)
      });

      // 2. Wait for it to complete (15s timeout)
      const waitResult = await api.runtime.subagent.waitForRun({
        runId,
        timeoutMs: 15000,
      });

      if (waitResult.status !== "ok") {
        return "";
      }

      // 3. Read the assistant's response
      const { messages } = await api.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 10,
      });

      // Extract text from the last assistant message
      const assistantMsgs = messages.filter(
        (m: any) => m.role === "assistant",
      );
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      const text = lastMsg?.content
        ?.filter((c: any) => c.type === "text")
        ?.map((c: any) => c.text)
        ?.join("") ?? "";

      // 4. Cleanup
      await api.runtime.subagent.deleteSession({
        sessionKey,
        deleteTranscript: true,
      }).catch(() => {});

      return text;
    } catch (error) {
      return "";
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin entry — OpenClaw calls this function on load
// ---------------------------------------------------------------------------

export default function register(api: any): void {
  // 1. Merge user config with defaults
  const userConfig = api.getPluginConfig?.() ?? {};
  const config: QmemoryConfig = { ...DEFAULT_CONFIG, ...userConfig };

  // 2. Use OpenClaw's logger (falls back to console in standalone)
  const logger: QmemoryLogger = api.logger ?? {
    debug: (msg: string) => console.debug(`[qmemory] ${msg}`),
    info: (msg: string) => console.log(`[qmemory] ${msg}`),
    warn: (msg: string) => console.warn(`[qmemory] ${msg}`),
    error: (msg: string) => console.error(`[qmemory] ${msg}`),
  };

  // 3. Create the subagent runner (for LLM operations: dedup, extract, link)
  //    Note: subagents inherit the parent session's model. OpenClaw's plugin SDK has no way
  //    to override the model — neither SubagentRunParams nor subagent_spawning hook support it.
  //    This is acceptable now that the primary model is Gemini (free via API key).
  const subagentRunner = createSubagentRunner(api, config.subagent_model);

  // 4. Resolve embedding config from OpenClaw's EXISTING settings (no extra API key!)
  const openclawConfig = api.config as Record<string, unknown> | undefined;

  // 4b. Resolve embedding config (used by save tool for vector generation)
  setEmbeddingLogger(logger);
  const embeddingConfig = resolveEmbeddingConfig(config, openclawConfig);

  // 5. SurrealDB connection is handled by bootstrap() in engine.ts
  //    (removed pre-flight IIFE that caused a duplicate connection race condition)

  // 6. Check tools.alsoAllow config — warn if plugin tools will be hidden
  const toolsConfig = (openclawConfig as any)?.tools;
  const alsoAllow: string[] = toolsConfig?.alsoAllow ?? [];
  const hasPluginGroup = alsoAllow.some(
    (entry: string) => entry === "group:plugins" || entry === "qmemory",
  );
  if (!hasPluginGroup && toolsConfig?.profile) {
    logger.warn(
      `tools.profile="${toolsConfig.profile}" is set but tools.alsoAllow does not include "group:plugins". ` +
      `Qmemory tools will NOT be visible to the agent. ` +
      `Fix: openclaw config set tools.alsoAllow '["group:plugins"]'`,
    );
  }

  // 7. Shared state — lets hooks access the engine's current session
  const sharedState: SharedEngineState = { currentSessionId: null, lastDeliveryTarget: null, currentModel: null };

  // 8. Register the context engine
  const engine = createEngine(config, logger, subagentRunner, openclawConfig, embeddingConfig, sharedState);
  api.registerContextEngine("qmemory", () => engine);

  logger.info("Context engine registered");

  // 9. Register lifecycle hooks
  try {
    api.on("after_tool_call", createAfterToolCallHandler(logger, sharedState));
    logger.info("Hook registered: after_tool_call");
  } catch (hookErr) {
    logger.error(`Failed to register after_tool_call hook: ${hookErr}`);
  }
  try {
    api.on("tool_result_persist", createToolResultPersistHandler(logger));
    logger.info("Hook registered: tool_result_persist");
  } catch (hookErr) {
    logger.error(`Failed to register tool_result_persist hook: ${hookErr}`);
  }

  // 10. Agent instructions — static prompt appended to system prompt (cached, no per-turn cost)
  try {
    api.on("before_prompt_build", () => ({
      appendSystemContext: AGENT_SYSTEM_CONTEXT,
    }));
    logger.info("Hook registered: before_prompt_build");
  } catch (hookErr) {
    logger.error(`Failed to register before_prompt_build hook: ${hookErr}`);
  }

  // 11. Lifecycle hooks — capture everything into the graph
  const lifecycleHooks: Array<[string, (...args: any[]) => any]> = [
    ["agent_end", createAgentEndHandler(logger, sharedState)],
    ["llm_output", createLlmOutputHandler(logger, sharedState)],
    ["subagent_spawned", createSubagentSpawnedHandler(logger, sharedState)],
    ["subagent_ended", createSubagentEndedHandler(logger, sharedState)],
    ["subagent_delivery_target", createSubagentDeliveryTargetHandler(logger, sharedState)],
    ["session_start", createSessionStartHandler(logger, sharedState)],
    ["session_end", createSessionEndHandler(logger, sharedState)],
    ["message_received", createMessageReceivedHandler(logger)],
    ["message_sent", createMessageSentHandler(logger, sharedState)],
  ];
  for (const [name, handler] of lifecycleHooks) {
    try {
      api.on(name as any, handler);
      logger.info(`Hook registered: ${name}`);
    } catch (hookErr) {
      logger.error(`Failed to register ${name} hook: ${hookErr}`);
    }
  }

  // ----- TOOLS -----
  registerAllTools(api, logger, subagentRunner, embeddingConfig);

  // ----- SERVICE: Background Linker -----
  const linkerService = createLinkerService(config, logger, subagentRunner);
  api.registerService(linkerService);

  logger.info("Linker service registered");

  // ----- HTTP ROUTE: Graph Viewer -----

  api.registerHttpRoute({
    path: "/qmemory",
    auth: "plugin",
    match: "prefix",
    handler: async (req: any, res: any) => {
      const host = req.headers.host ?? "localhost";
      const protocol = req.headers["x-forwarded-proto"] ?? "http";
      const url = new URL(req.url ?? "/", `${protocol}://${host}`);
      const handled = await handleGraphRequest(url, (status, headers, body) => {
        res.writeHead(status, headers);
        res.end(body);
      });
      if (!handled) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    },
  });

  logger.info("Qmemory plugin loaded (context engine + 6 tools + linker + graph route)");
}

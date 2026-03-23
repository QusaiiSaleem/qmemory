/**
 * Qmemory Hook Handlers — Barrel Re-export
 *
 * All OpenClaw lifecycle hooks registered via api.on().
 * Separated into sub-modules by domain.
 */

// ---------------------------------------------------------------------------
// Shared state — engine updates this, hooks read it
// ---------------------------------------------------------------------------

export interface SharedEngineState {
  currentSessionId: string | null;
  /** Last known delivery target — set by message_sent hook, read by agent_end */
  lastDeliveryTarget: string | null;
  /** Current model name — set by llm_output hook, shown in session header */
  currentModel: string | null;
}

// Re-export all hook handlers
export {
  createAfterToolCallHandler,
  createToolResultPersistHandler,
} from "./tool-call.js";

export {
  createAgentEndHandler,
  createLlmOutputHandler,
  createSessionStartHandler,
  createSessionEndHandler,
} from "./lifecycle.js";

export {
  createSubagentSpawnedHandler,
  createSubagentEndedHandler,
  createSubagentDeliveryTargetHandler,
} from "./subagent.js";

export {
  createMessageReceivedHandler,
  createMessageSentHandler,
} from "./message.js";

/**
 * Hooks barrel re-export — redirects to hooks/index.ts
 *
 * Keeps existing imports from "./hooks.js" working.
 */

export type { SharedEngineState } from "./hooks/index.js";
export {
  createAfterToolCallHandler,
  createToolResultPersistHandler,
  createAgentEndHandler,
  createLlmOutputHandler,
  createSessionStartHandler,
  createSessionEndHandler,
  createSubagentSpawnedHandler,
  createSubagentEndedHandler,
  createSubagentDeliveryTargetHandler,
  createMessageReceivedHandler,
  createMessageSentHandler,
} from "./hooks/index.js";

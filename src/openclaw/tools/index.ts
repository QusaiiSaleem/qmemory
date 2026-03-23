/**
 * Tool registration barrel
 *
 * Registers all 6 Qmemory tools with the OpenClaw API.
 */

import { registerSearchTool } from "./search.js";
import { registerSaveTool } from "./save.js";
import { registerCorrectTool } from "./correct.js";
import { registerLinkTool } from "./link.js";
import { registerPersonTool, registerImportTool } from "./person.js";
import type { EmbeddingConfig } from "../../core/embeddings.js";
import type { QmemoryLogger } from "../../config.js";
import type { SubagentRunner } from "../index.js";

export function registerAllTools(
  api: any,
  logger: QmemoryLogger,
  subagentRunner: SubagentRunner,
  embeddingConfig?: EmbeddingConfig,
): void {
  registerSearchTool(api);
  registerSaveTool(api, subagentRunner, embeddingConfig);
  registerCorrectTool(api);
  registerLinkTool(api);
  registerImportTool(api, logger, subagentRunner);
  registerPersonTool(api, logger);
}

/**
 * Embedding Generation (Optional — Layer 4)
 *
 * Generates vector embeddings for memory content.
 * Supports: Voyage AI, OpenAI, Gemini (via native fetch).
 *
 * KEY DESIGN: When running inside OpenClaw, reads the EXISTING
 * embedding config from api.config — no duplicate API key needed.
 * When running standalone (MCP), falls back to env vars or Qmemory config.
 *
 * If no provider is available, returns null — BM25 handles everything.
 */

import { query } from "../db/client.js";
import { consoleLogger } from "../config.js";
import type { QmemoryConfig, QmemoryLogger } from "../config.js";

let logger: QmemoryLogger = consoleLogger;

export function setEmbeddingLogger(l: QmemoryLogger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Resolved embedding config (from OpenClaw or Qmemory or env)
// ---------------------------------------------------------------------------

export interface EmbeddingConfig {
  provider: "voyage" | "openai" | "gemini" | "none";
  apiKey: string;
  model: string;
  dimension: number;
}

/**
 * Resolve embedding config from available sources.
 * Priority: OpenClaw config → Qmemory config → env vars → "none"
 */
export function resolveEmbeddingConfig(
  qmemoryConfig: QmemoryConfig,
  openclawConfig?: Record<string, unknown>,
): EmbeddingConfig {
  // 1. Try OpenClaw's existing config (no extra key needed!)
  if (openclawConfig) {
    const memSearch = getNestedValue(openclawConfig, "agents.defaults.memorySearch") as Record<string, unknown> | undefined;
    if (memSearch) {
      const provider = memSearch.provider as string;
      const model = memSearch.model as string;
      const remote = memSearch.remote as Record<string, unknown> | undefined;
      const apiKey = remote?.apiKey as string;

      if (provider && provider !== "disabled" && apiKey) {
        const mapped = mapProvider(provider);
        if (mapped !== "none") {
          logger.info(`Using OpenClaw's embedding provider: ${mapped} (${model})`);
          return {
            provider: mapped,
            apiKey,
            model: model || defaultModel(mapped),
            dimension: (memSearch.dimension as number) || qmemoryConfig.embedding_dimension,
          };
        }
      }
    }
  }

  // 2. Try Qmemory's own config
  if (qmemoryConfig.embedding_provider !== "none" && qmemoryConfig.embedding_api_key) {
    return {
      provider: qmemoryConfig.embedding_provider,
      apiKey: qmemoryConfig.embedding_api_key,
      model: qmemoryConfig.embedding_model,
      dimension: qmemoryConfig.embedding_dimension,
    };
  }

  // 3. Try environment variables
  const envKey = process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  if (envKey) {
    const provider = process.env.VOYAGE_API_KEY ? "voyage"
      : process.env.OPENAI_API_KEY ? "openai"
      : "gemini";
    logger.info(`Using embedding provider from env: ${provider}`);
    return {
      provider: provider as "voyage" | "openai" | "gemini",
      apiKey: envKey,
      model: defaultModel(provider),
      dimension: qmemoryConfig.embedding_dimension,
    };
  }

  // 4. No embeddings available — BM25 only
  return { provider: "none", apiKey: "", model: "", dimension: 0 };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a vector embedding for the given text.
 * Returns null if no provider available (graceful degradation).
 */
export async function generateEmbedding(
  text: string,
  embeddingConfig: EmbeddingConfig,
): Promise<number[] | null> {
  if (embeddingConfig.provider === "none") return null;

  try {
    switch (embeddingConfig.provider) {
      case "voyage":
        return await callEmbeddingApi(
          "https://api.voyageai.com/v1/embeddings",
          embeddingConfig,
          text,
          { input_type: "document" },
        );
      case "openai":
        return await callEmbeddingApi(
          "https://api.openai.com/v1/embeddings",
          embeddingConfig,
          text,
        );
      case "gemini":
        return await callGeminiEmbedding(embeddingConfig, text);
      default:
        return null;
    }
  } catch (error) {
    logger.error(`Embedding failed (${embeddingConfig.provider}): ${error}`);
    return null;
  }
}

/**
 * Enable the HNSW vector index on memory.embedding.
 * Safe to call multiple times — SurrealDB handles idempotency.
 */
export async function enableVectorIndex(dimension: number): Promise<void> {
  logger.info(`Enabling HNSW vector index (dimension: ${dimension})...`);
  const result = await query(
    `DEFINE INDEX idx_memory_embedding ON memory FIELDS embedding HNSW DIMENSION ${dimension} TYPE F32 DIST COSINE;`,
  );
  if (result !== null) {
    logger.info("Vector index enabled on memory.embedding");
  }
}

/**
 * Backfill embeddings for all memories that don't have them.
 * Runs in background — non-blocking, rate-limited to avoid API throttling.
 */
export async function backfillEmbeddings(
  embeddingConfig: EmbeddingConfig,
): Promise<{ processed: number; failed: number }> {
  if (embeddingConfig.provider === "none") return { processed: 0, failed: 0 };

  const missing = await query<{ id: string; content: string }>(
    "SELECT id, content FROM memory WHERE is_active = true AND embedding IS NONE LIMIT 100",
  );

  if (!missing || missing.length === 0) return { processed: 0, failed: 0 };

  logger.info(`Backfilling embeddings for ${missing.length} memories...`);
  let processed = 0;
  let failed = 0;

  for (const mem of missing) {
    try {
      const embedding = await generateEmbedding(mem.content, embeddingConfig);
      if (embedding) {
        await query(
          "UPDATE $id SET embedding = $embedding",
          { id: String(mem.id), embedding },
        );
        processed++;
      } else {
        failed++;
      }
      // Rate limit: 100ms between calls to avoid API throttling
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      failed++;
    }
  }

  logger.info(`Backfill complete: ${processed} embedded, ${failed} failed`);
  return { processed, failed };
}

// ---------------------------------------------------------------------------
// Provider implementations (unified pattern)
// ---------------------------------------------------------------------------

/** Shared pattern for OpenAI-compatible embedding APIs (Voyage, OpenAI) */
async function callEmbeddingApi(
  url: string,
  config: EmbeddingConfig,
  text: string,
  extra?: Record<string, unknown>,
): Promise<number[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
      ...extra,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${config.provider} API ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0].embedding;
}

/** Gemini uses a different API shape */
async function callGeminiEmbedding(
  config: EmbeddingConfig,
  text: string,
): Promise<number[]> {
  const model = config.model || "text-embedding-004";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${config.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    embedding: { values: number[] };
  };
  return data.embedding.values;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map OpenClaw provider names to our provider enum */
function mapProvider(provider: string): "voyage" | "openai" | "gemini" | "none" {
  if (provider.includes("voyage")) return "voyage";
  if (provider.includes("openai")) return "openai";
  if (provider.includes("gemini")) return "gemini";
  return "none";
}

/** Default model per provider */
function defaultModel(provider: string): string {
  switch (provider) {
    case "voyage": return "voyage-3";
    case "openai": return "text-embedding-3-small";
    case "gemini": return "text-embedding-004";
    default: return "";
  }
}

/** Safely access nested config values like "agents.defaults.memorySearch" */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (current, key) => (current && typeof current === "object") ? (current as Record<string, unknown>)[key] : undefined,
    obj,
  );
}

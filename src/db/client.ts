/**
 * SurrealDB Connection Manager
 *
 * Single connection instance shared across all Qmemory modules.
 * Uses the official SurrealDB JS SDK v2 (WebSocket transport).
 *
 * Reconnection is handled by the SDK's built-in exponential-backoff
 * mechanism — no custom reconnect logic needed.
 */

import { Surreal } from "surrealdb";
import type { QmemoryConfig, QmemoryLogger } from "../config.js";
import { consoleLogger } from "../config.js";

let db: Surreal | null = null;
let logger: QmemoryLogger = consoleLogger;
let currentConfig: QmemoryConfig | null = null;

/** Set the logger (called by OpenClaw plugin or standalone) */
export function setLogger(l: QmemoryLogger): void {
  logger = l;
}

/** Get the active database connection (or null if unavailable) */
export function getDb(): Surreal | null {
  return db;
}

/**
 * Connect to SurrealDB.
 * Called once at bootstrap — reuses connection for all subsequent calls.
 * SDK v2 handles reconnection automatically via built-in exponential backoff.
 */
export async function connect(config: QmemoryConfig): Promise<Surreal | null> {
  if (db) return db;
  currentConfig = config;

  try {
    const newDb = new Surreal();

    await newDb.connect(config.surrealdb_url, {
      namespace: config.namespace,
      database: config.database,
      authentication: {
        username: config.surrealdb_user,
        password: config.surrealdb_pass,
      },
      // SDK v2 built-in reconnection with exponential backoff.
      // Replaces ~50 lines of custom reconnect logic.
      // The SDK also restores namespace/database/auth after reconnect.
      reconnect: {
        enabled: true,
        attempts: -1,          // unlimited — important for long migrations
        retryDelay: 1000,      // start at 1s
        retryDelayMax: 30000,  // cap at 30s
        retryDelayMultiplier: 2,
        retryDelayJitter: 0.1,
      },
    });

    // Event subscriptions for observability
    newDb.subscribe("connected", () => {
      logger.info(`Connected to SurrealDB at ${config.surrealdb_url}`);
    });

    newDb.subscribe("reconnecting", () => {
      logger.warn("SurrealDB reconnecting...");
    });

    newDb.subscribe("disconnected", () => {
      logger.warn("SurrealDB disconnected");
    });

    newDb.subscribe("error", (error: unknown) => {
      logger.warn(`SurrealDB error: ${error}`);
    });

    db = newDb;
    logger.info(
      `Connected to SurrealDB at ${config.surrealdb_url} (${config.namespace}/${config.database})`,
    );
    return db;
  } catch (error) {
    logger.error(`Failed to connect to SurrealDB: ${error}`);
    db = null;
    return null;
  }
}

/** Disconnect from SurrealDB */
export async function disconnect(): Promise<void> {
  if (db) {
    try { await db.close(); } catch { /* ignore */ }
    db = null;
    logger.info("Disconnected from SurrealDB");
  }
}

/** Check if SurrealDB is healthy */
export async function isHealthy(): Promise<boolean> {
  if (!db) return false;
  try {
    await db.query("RETURN true;");
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a SurrealQL query with graceful degradation.
 *
 * Reconnection is handled by the SDK automatically.
 * If the connection is temporarily down, returns null instead of crashing.
 */
export async function query<T = unknown>(
  surql: string,
  params?: Record<string, unknown>,
): Promise<T[] | null> {
  if (!db) return null;

  try {
    if (currentConfig?.debug) {
      logger.debug(`SurrealQL: ${surql.slice(0, 200)}`, params);
    }

    const results = await db.query<[T[]]>(surql, params);
    return results[0] ?? [];
  } catch (error) {
    // SDK handles reconnection in the background.
    // Log the error and return null for graceful degradation.
    logger.error(`SurrealQL error: ${error}`);
    return null;
  }
}

/**
 * Execute multiple statements as one query.
 * Same graceful degradation as query().
 */
export async function queryMulti<T extends unknown[]>(
  surql: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  if (!db) return null;

  try {
    if (currentConfig?.debug) {
      logger.debug(`SurrealQL (multi): ${surql.slice(0, 200)}`, params);
    }
    const results = await db.query(surql, params);
    return results as T;
  } catch (error) {
    logger.error(`SurrealQL error: ${error}`);
    return null;
  }
}

/**
 * Apply the schema from qmemory.surql.
 * Called during bootstrap — safe to run multiple times.
 */
export async function applySchema(schemaSurql: string): Promise<boolean> {
  if (!db) return false;
  try {
    await db.query(schemaSurql);
    logger.info("Schema applied successfully");
    return true;
  } catch (error) {
    logger.error(`Schema apply failed: ${error}`);
    return false;
  }
}

/** Generate a timestamp-based ID (no dashes — SurrealDB safe) */
export function generateId(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * SurrealDB Connection Manager
 *
 * Single connection instance shared across all Qmemory modules.
 * Uses the official SurrealDB JS SDK (WebSocket transport).
 *
 * Pattern: connect once at bootstrap, reuse everywhere.
 * Graceful degradation: if DB is unavailable, log warnings and continue.
 */

import Surreal, { ConnectionUnavailableError, SurrealError } from "surrealdb";
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
 */
export async function connect(config: QmemoryConfig): Promise<Surreal | null> {
  if (db) return db;
  currentConfig = config;

  try {
    db = new Surreal();

    await db.connect(config.surrealdb_url, {
      namespace: config.namespace,
      database: config.database,
      authentication: {
        username: config.surrealdb_user,
        password: config.surrealdb_pass,
      },
    });

    // Listen for connection errors (auto-reconnect)
    db.subscribe("error", (error) => {
      logger.warn(`SurrealDB connection error: ${error}`);
    });

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
    try {
      await db.close();
    } catch {
      // Ignore close errors
    }
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
 * Returns null if DB is unavailable (instead of throwing).
 */
export async function query<T = unknown>(
  surql: string,
  params?: Record<string, unknown>,
): Promise<T[] | null> {
  if (!db) {
    logger.warn("SurrealDB not connected — skipping query");
    return null;
  }

  try {
    if (currentConfig?.debug) {
      logger.debug(`SurrealQL: ${surql.slice(0, 200)}`, params);
    }

    const results = await db.query<[T[]]>(surql, params);
    return results[0] ?? [];
  } catch (error) {
    if (error instanceof ConnectionUnavailableError) {
      logger.warn("SurrealDB connection lost — skipping query");
      db = null;
      return null;
    }
    logger.error(`SurrealQL error: ${error}`);
    return null;
  }
}

/**
 * Execute multiple statements as one query.
 * Returns array of results (one per statement).
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
    logger.error(`SurrealQL multi error: ${error}`);
    return null;
  }
}

/**
 * Apply the schema from qmemory.surql.
 * Called during bootstrap — safe to run multiple times (IF NOT EXISTS).
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

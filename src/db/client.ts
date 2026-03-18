/**
 * SurrealDB Connection Manager
 *
 * Single connection instance shared across all Qmemory modules.
 * Uses the official SurrealDB JS SDK (WebSocket transport).
 *
 * KEY FIX: Auto-reconnect on connection loss.
 * During long operations (migration: 1000+ queries), the WebSocket
 * can drop. The query() function now detects this and reconnects
 * before retrying — instead of silently failing.
 */

import { Surreal, ConnectionUnavailableError } from "surrealdb";
import type { QmemoryConfig, QmemoryLogger } from "../config.js";
import { consoleLogger } from "../config.js";

let db: Surreal | null = null;
let logger: QmemoryLogger = consoleLogger;
let currentConfig: QmemoryConfig | null = null;
let reconnecting = false;

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
  return await createConnection(config);
}

/** Internal: create a fresh connection */
async function createConnection(config: QmemoryConfig): Promise<Surreal | null> {
  try {
    const newDb = new Surreal();

    await newDb.connect(config.surrealdb_url, {
      namespace: config.namespace,
      database: config.database,
      authentication: {
        username: config.surrealdb_user,
        password: config.surrealdb_pass,
      },
    });

    newDb.subscribe("error", (error: unknown) => {
      logger.warn(`SurrealDB connection error: ${error}`);
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

/**
 * Reconnect to SurrealDB after connection loss.
 * Prevents multiple simultaneous reconnection attempts.
 */
async function reconnect(): Promise<boolean> {
  if (reconnecting || !currentConfig) return false;
  reconnecting = true;

  try {
    // Close stale connection
    if (db) {
      try { await db.close(); } catch { /* ignore */ }
      db = null;
    }

    logger.info("Reconnecting to SurrealDB...");
    const result = await createConnection(currentConfig);
    return result !== null;
  } finally {
    reconnecting = false;
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
 * Execute a SurrealQL query with auto-reconnect.
 *
 * If the connection drops mid-query:
 * 1. Reconnect automatically
 * 2. Retry the query once
 * 3. If still failing, return null (graceful degradation)
 */
export async function query<T = unknown>(
  surql: string,
  params?: Record<string, unknown>,
): Promise<T[] | null> {
  // Try to reconnect if disconnected
  if (!db) {
    if (currentConfig) {
      const ok = await reconnect();
      if (!ok) return null;
    } else {
      return null;
    }
  }

  try {
    if (currentConfig?.debug) {
      logger.debug(`SurrealQL: ${surql.slice(0, 200)}`, params);
    }

    const results = await db!.query<[T[]]>(surql, params);
    return results[0] ?? [];
  } catch (error) {
    // Connection lost — try reconnect + retry ONCE
    if (error instanceof ConnectionUnavailableError || isConnectionError(error)) {
      logger.warn("SurrealDB connection lost — attempting reconnect...");
      db = null;
      const ok = await reconnect();
      if (!ok) return null;

      // Retry the query
      try {
        const results = await db!.query<[T[]]>(surql, params);
        return results[0] ?? [];
      } catch (retryError) {
        logger.error(`Query failed after reconnect: ${retryError}`);
        db = null;
        return null;
      }
    }

    logger.error(`SurrealQL error: ${error}`);
    return null;
  }
}

/**
 * Execute multiple statements as one query.
 * Same auto-reconnect behavior as query().
 */
export async function queryMulti<T extends unknown[]>(
  surql: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  if (!db) {
    if (currentConfig) {
      const ok = await reconnect();
      if (!ok) return null;
    } else {
      return null;
    }
  }

  try {
    if (currentConfig?.debug) {
      logger.debug(`SurrealQL (multi): ${surql.slice(0, 200)}`, params);
    }
    const results = await db!.query(surql, params);
    return results as T;
  } catch (error) {
    if (error instanceof ConnectionUnavailableError || isConnectionError(error)) {
      logger.warn("SurrealDB connection lost (multi) — attempting reconnect...");
      db = null;
      const ok = await reconnect();
      if (!ok) return null;
      try {
        const results = await db!.query(surql, params);
        return results as T;
      } catch {
        db = null;
        return null;
      }
    }
    logger.error(`SurrealQL multi error: ${error}`);
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

/** Check if an error is connection-related (covers various error types) */
function isConnectionError(error: unknown): boolean {
  if (error instanceof ConnectionUnavailableError) return true;
  const msg = String(error).toLowerCase();
  return msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("not connected") ||
    msg.includes("closed");
}

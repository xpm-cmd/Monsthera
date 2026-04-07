import mysql from "mysql2/promise";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";

/**
 * Configuration for Dolt database connection pool.
 * Dolt is MySQL-compatible, so we use standard MySQL connection settings.
 */
export interface DoltConnectionConfig {
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  connectionLimit?: number;
}

/**
 * Create a connection pool for Dolt database.
 * Returns a mysql2/promise Pool that can be used for queries.
 */
export function createDoltPool(config: DoltConnectionConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user ?? "root",
    password: config.password ?? "",
    connectionLimit: config.connectionLimit ?? 10,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
}

/**
 * Execute a SELECT query against the database.
 * Wraps the result in a Result type for error handling.
 * Returns an array of rows on success, StorageError on failure.
 */
export async function executeQuery(
  pool: Pool,
  sql: string,
  params?: unknown[],
): Promise<Result<RowDataPacket[], StorageError>> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(sql, params as (string | number | null)[]);
    return ok(rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new StorageError(`Query failed: ${message}`, { sql, error: String(error) }));
  }
}

/**
 * Execute a mutation (INSERT/UPDATE/DELETE) against the database.
 * Wraps the result in a Result type for error handling.
 * Returns a ResultSetHeader on success, StorageError on failure.
 */
export async function executeMutation(
  pool: Pool,
  sql: string,
  params?: unknown[],
): Promise<Result<ResultSetHeader, StorageError>> {
  try {
    const [result] = await pool.execute<ResultSetHeader>(sql, params as (string | number | null)[]);
    return ok(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new StorageError(`Mutation failed: ${message}`, { sql, error: String(error) }));
  }
}

/**
 * Close the connection pool gracefully.
 * Waits for all active connections to complete before closing.
 */
export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}

/**
 * Get a single connection from the pool.
 * Useful for transactions or operations requiring a persistent connection.
 * Caller must release the connection when done.
 */
export async function getConnection(pool: Pool): Promise<Result<PoolConnection, StorageError>> {
  try {
    const connection = await pool.getConnection();
    return ok(connection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new StorageError(`Failed to get connection: ${message}`, { error: String(error) }));
  }
}

/**
 * Execute a query within a transaction.
 * Automatically handles BEGIN/COMMIT/ROLLBACK.
 */
export async function executeTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<Result<T, StorageError>> {
  const connResult = await getConnection(pool);
  if (!connResult.ok) {
    return connResult;
  }

  const connection = connResult.value;

  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return ok(result);
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      return err(new StorageError(`Rollback failed: ${message}`, { error: String(rollbackError) }));
    }

    const message = error instanceof Error ? error.message : String(error);
    return err(new StorageError(`Transaction failed: ${message}`, { error: String(error) }));
  } finally {
    await connection.release();
  }
}

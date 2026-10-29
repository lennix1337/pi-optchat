import type { DatabaseSync } from 'node:sqlite';

/** Runs fn inside BEGIN IMMEDIATE; commits its result or rolls back and rethrows. */
export function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

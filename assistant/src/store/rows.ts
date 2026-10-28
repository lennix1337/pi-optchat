import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** Every row of one query, mapped; callers own the SQL and the row shape. */
export function allRows<R, T>(db: DatabaseSync, sql: string, map: (row: R) => T, ...params: SQLInputValue[]): T[] {
  return (db.prepare(sql).all(...params) as R[]).map(row => map(row));
}

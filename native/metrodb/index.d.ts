export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
}

export class Database {
  constructor(filename: string)
  exec(sql: string): void
  pragma(sql: string, options?: { simple?: boolean }): unknown
  prepare(sql: string): Statement
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T
  close(): void
}

export const available: boolean
export const sqliteVersion: string | null
export function version(): string
export const triedNames: string[]
export const loadErrors: string[]

import { readFileSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

type D1Value = string | number | bigint | boolean | null | Uint8Array
type TestD1Result<T = unknown> = {
  results: T[]
  success: boolean
  meta: Record<string, unknown>
}
type TestD1ExecResult = {
  count: number
  duration: number
}
type TestD1PreparedStatementLike = {
  bind(...values: D1Value[]): TestD1PreparedStatementLike
  first<T = unknown>(colName?: string): Promise<T | null>
  run(): Promise<TestD1Result>
  all<T = unknown>(): Promise<TestD1Result<T>>
  raw<T = unknown[]>(): Promise<T[]>
}

export class TestD1Database {
  readonly db = new DatabaseSync(':memory:')

  constructor() {
    this.db.exec('PRAGMA foreign_keys = ON')
    for (const migration of [
      '../migrations/0000_living_shockwave.sql',
      '../migrations/0001_ambiguous_cardiac.sql',
      '../migrations/0002_collaboration_metadata.sql',
    ]) {
      const sql = readFileSync(new URL(migration, import.meta.url), 'utf-8')
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim()
        if (trimmed) {
          this.db.exec(trimmed)
        }
      }
    }
  }

  prepare(query: string): TestD1PreparedStatementLike {
    return new TestD1PreparedStatement(this.db.prepare(query))
  }

  async batch(statements: TestD1PreparedStatementLike[]): Promise<TestD1Result[]> {
    return Promise.all(statements.map((statement) => statement.run()))
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0)
  }

  async exec(query: string): Promise<TestD1ExecResult> {
    this.db.exec(query)
    return { count: 0, duration: 0 }
  }

  close(): void {
    this.db.close()
  }
}

class TestD1PreparedStatement implements TestD1PreparedStatementLike {
  readonly #statement: StatementSync
  readonly #bindings: D1Value[]

  constructor(statement: StatementSync, bindings: D1Value[] = []) {
    this.#statement = statement
    this.#bindings = bindings
  }

  bind(...values: D1Value[]): TestD1PreparedStatementLike {
    return new TestD1PreparedStatement(this.#statement, values)
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.#statement.get(...this.bindings())
    if (!row) {
      return null
    }
    if (colName) {
      return (row as Record<string, T>)[colName] ?? null
    }
    return row as T
  }

  async run(): Promise<TestD1Result> {
    this.#statement.run(...this.bindings())
    return d1Result([])
  }

  async all<T = unknown>(): Promise<TestD1Result<T>> {
    return d1Result(this.#statement.all(...this.bindings()) as T[])
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    this.#statement.setReturnArrays(true)
    try {
      return this.#statement.all(...this.bindings()) as T[]
    } finally {
      this.#statement.setReturnArrays(false)
    }
  }

  private bindings(): (string | number | bigint | null | Uint8Array)[] {
    return this.#bindings.map((value) => {
      if (value === null) return null
      if (typeof value === 'boolean') return value ? 1 : 0
      return value
    })
  }
}

function d1Result<T>(results: T[]): TestD1Result<T> {
  return {
    results,
    success: true,
    meta: {},
  }
}

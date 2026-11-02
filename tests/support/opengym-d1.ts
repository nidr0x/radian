import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '../../functions/types';

type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements D1PreparedStatementLike {
  private values: SqlValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values.map((value) => {
      if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
      if (ArrayBuffer.isView(value)) return value as NodeJS.ArrayBufferView;
      throw new TypeError('SQLite fixture recibió un valor SQL no compatible.');
    });
    return this;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all<T>(): Promise<{ results: T[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] });
  }

  run(): Promise<D1ResultLike> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } });
  }

  runSync(): D1ResultLike {
    let result;
    try { result = this.database.prepare(this.sql).run(...this.values); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : 'SQL error'}: ${this.sql} [${this.values.length} bindings]`); }
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): SqliteStatement { return new SqliteStatement(this.database, query); }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => (statement as SqliteStatement).runSync());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export const openTestDatabase = (): { database: DatabaseSync; d1: D1DatabaseLike } => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  const migrations = [
    '0001_sync_records.sql', '0002_accounts.sql', '0003_passkey_management.sql', '0004_auth_hardening.sql',
    '0005_mcp_oauth.sql', '0006_mcp_revisions.sql', '0007_mcp_recovery_hardening.sql', '0008_mcp_receipts.sql',
    '0009_auth_challenge_browser_binding.sql', '0010_mcp_disabled_account_tokens.sql', '0011_sync_storage_quota.sql',
    '0012_opengym_core.sql', '0013_opengym_sync_media.sql', '0014_opengym_account_security.sql',
    '0015_opengym_accounts.sql', '0016_opengym_activity_presence.sql', '0017_opengym_coach_admin.sql',
    '0018_opengym_mcp_revisions.sql',
  ];
  for (const migration of migrations) database.exec(readFileSync(resolve(process.cwd(), 'migrations', migration), 'utf8'));
  database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run('account-a', 'A', '2026-10-26T00:00:00.000Z');
  return { database, d1: new SqliteD1(database) };
};

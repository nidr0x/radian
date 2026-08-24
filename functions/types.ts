export interface D1ResultLike {
  success: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface SyncEnv {
  DB?: D1DatabaseLike;
}

export interface SyncContext {
  request: Request;
  env: SyncEnv;
}

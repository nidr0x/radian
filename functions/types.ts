export interface D1ResultLike {
  success: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface SyncEnv {
  DB?: D1DatabaseLike;
  AUTH_RATE_LIMITER?: RateLimiterLike;
  SESSION_SECRET?: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_ORIGIN?: string;
}

export interface SyncContext {
  request: Request;
  env: SyncEnv;
}

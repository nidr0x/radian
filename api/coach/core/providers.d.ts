export interface HttpProviderMetadata {
  label: string;
  runtime: string;
  http: true;
  apiKeyEnv: string;
  oauthEnv: null;
  defaultBase: string | null;
  defaultModel: string | null;
  keyPlaceholder: string;
  keyOptional?: boolean;
  baseUrl?: boolean;
}

export const HTTP_PROVIDERS: Readonly<Record<string, HttpProviderMetadata>>;
export const HTTP_PROVIDER_IDS: readonly string[];
export const MAX_HEADERS: number;
export const MAX_HEADER_VALUE: number;
export function baseUrlFor(id: string, cfg?: unknown): string;
export function isReservedHeader(name: string): boolean;
export function validateHeaders(raw: unknown): { ok: true; value: Record<string, string> | null } | { ok: false; error: string };
export function extraHeadersFor(id: string, cfg?: unknown): Record<string, string>;
export function validateBaseUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string };

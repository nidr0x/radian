import type { D1DatabaseLike } from '../../types';

export interface CoachWorkerEnvironment {
  DB?: D1DatabaseLike;
  COACH_PROVIDER?: string;
  COACH_MODEL?: string;
  COACH_BASE_URL?: string;
  COACH_HANDLE_SECRET?: string;
  COACH_CREDENTIAL_WRAP_KEY?: string;
  COACH_DISABLED?: string;
  COACH_COMMUNITY?: string;
  COACH_CAP_PER_PROFILE?: string;
  COACH_CAP_INSTANCE?: string;
  COACH_MAX_MESSAGE_LEN?: string;
  COACH_MAX_OUTPUT_TOKENS?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENAI_COMPAT_API_KEY?: string;
}

export interface CoachSettings {
  enabled: boolean;
  provider: string;
  meta: { label: string; runtime: string; apiKeyEnv: string; defaultModel: string | null; keyOptional?: boolean; keyPlaceholder: string; baseUrl?: boolean } | null;
  model: string | null;
  baseUrl: string;
  headers: Record<string, string> | null;
  headersError: string | null;
  baseUrlError: string | null;
  apiKey: string | null;
  hasCredential: boolean;
  credentialStored: boolean;
  credentialError: string | null;
  caps: { perProfileDaily: number; instanceDaily: number };
  maxMessageLen: number;
  maxOutputTokens: number;
  community: boolean;
  models: Record<string, string>;
  disabledByEnv: boolean;
}

export interface CoachJobInput {
  jobId: string;
  accountId: string;
  kind: 'create' | 'review' | 'debrief';
  lang?: string;
  options?: Record<string, unknown>;
}

export type CoachJobResult =
  | { ok: false; errorClass: string; retryable?: boolean }
  | { ok: true; nochange: true; reading: string }
  | { ok: true; pending: Record<string, unknown> };

export function coachRuntime(env: CoachWorkerEnvironment): Promise<{
  provider: string | null;
  providerLabel: string | null;
  host: string | null;
  model: string | null;
  configured: boolean;
  reason: string | null;
  enabled: boolean;
  disabledByEnv: boolean;
  caps: { perProfileDaily: number; instanceDaily: number };
  maxMessageLen: number;
  maxOutputTokens: number;
  community: boolean;
  hasCredential: boolean;
  credentialStored: boolean;
}>;

export function readCoachSettings(env: CoachWorkerEnvironment): Promise<CoachSettings>;
export function coachExplicitProvider(env: CoachWorkerEnvironment): Promise<Record<string, unknown>>;
export function saveCoachConfig(env: CoachWorkerEnvironment, config: Record<string, unknown>): Promise<void>;
export function saveCoachCredential(env: CoachWorkerEnvironment, provider: string, token: string): Promise<void>;
export function removeCoachCredential(env: CoachWorkerEnvironment, provider: string): Promise<void>;
export function encryptCoachCredential(env: CoachWorkerEnvironment, provider: string, token: string): Promise<{ iv: string; ciphertext: string }>;
export function validateCoachWorkerBaseUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string };

export function isRetryableCoachFailure(result: { errorClass?: string; detail?: string }): boolean;

export function runCoachJob(
  state: Record<string, unknown>,
  job: CoachJobInput,
  env: CoachWorkerEnvironment,
  now?: Date,
  fetchImpl?: typeof fetch,
): Promise<CoachJobResult>;

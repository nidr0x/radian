import { json } from '../../lib/auth';
import { HTTP_PROVIDERS } from '../../../api/coach/core/providers.js';
import { coachRuntime, readCoachSettings, type CoachSettings, type CoachWorkerEnvironment } from '../../lib/radian-api/coach.js';
import { coachAdminGuard } from '../../lib/radian-api/coach-admin';
import type { SyncContext } from '../../types';

type CoachContext = SyncContext & { env: SyncContext['env'] & CoachWorkerEnvironment & { PUSH_QUEUE?: unknown } };

const ENV_KEY: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', compatible: 'OPENAI_COMPAT_API_KEY',
};

const errorText = (reason: string | null): string => ({
  config_unavailable: 'Shared Coach configuration could not be read from D1.',
  disabled: 'Coach is disabled by the instance configuration.',
  handle_secret_unavailable: 'COACH_HANDLE_SECRET is missing or too short.',
  credential_unavailable: 'An API key is not configured.',
  credential_wrap_unavailable: 'COACH_CREDENTIAL_WRAP_KEY is missing; dynamic credentials are unavailable.',
  credential_unreadable: 'The stored credential cannot be decrypted. Add the API key again.',
  base_url_unavailable: 'The provider endpoint is missing or invalid.',
  provider_unavailable: 'CLI and local runtimes are unavailable in Cloudflare Workers.',
  headers_unavailable: 'The configured provider headers are invalid.',
}[reason || ''] || 'Provider configuration is incomplete.');

export const onRequestGet = async (context: CoachContext): Promise<Response> => {
  const admin = await coachAdminGuard(context, 'read');
  if (admin instanceof Response) return admin;
  if (context.env.COACH_DISABLED === '1') return json({ disabledByEnv: true });
  let settings: CoachSettings;
  try { settings = await readCoachSettings(context.env); }
  catch { return json({ error: 'config_unavailable' }, 503); }
  const runtime = await coachRuntime(context.env);
  const envConnected = (provider: string) => {
    const keyName = ENV_KEY[provider];
    return !!(keyName && context.env[keyName as keyof typeof context.env]);
  };
  let storedProviders = new Set<string>();
  try {
    const rows = await admin.env.DB!.prepare('SELECT provider FROM gym_coach_credentials').all<{ provider: string }>();
    storedProviders = new Set(rows.results.map(row => row.provider));
  } catch { /* configuration remains visible; migrations are reported by the save routes */ }
  const providers: Array<Record<string, unknown>> = [
    ...Object.entries(HTTP_PROVIDERS).map(([id, provider]) => ({
      id, label: provider.label, runtime: provider.runtime, http: true,
      setupToken: false, deviceLogin: false, apiKey: true, keyOptional: !!provider.keyOptional,
      keyPlaceholder: provider.keyPlaceholder, defaultModel: provider.defaultModel,
      baseUrl: !!provider.baseUrl, connected: storedProviders.has(id) || envConnected(id), available: true,
    })),
    { id: 'claude', label: 'Claude Code', runtime: 'CLI', http: false, setupToken: false, deviceLogin: false, apiKey: false, connected: false, available: false, unavailableReason: 'CLI runtimes are not available in Cloudflare Workers.' },
    { id: 'codex', label: 'Codex CLI', runtime: 'CLI', http: false, setupToken: false, deviceLogin: false, apiKey: false, connected: false, available: false, unavailableReason: 'CLI runtimes are not available in Cloudflare Workers.' },
  ];
  const current = providers.find(provider => provider.id === settings.provider);
  const keyOptional = !!current?.keyOptional;
  const authState = settings.credentialError ? 'unreadable' : settings.hasCredential ? 'connected' : keyOptional ? 'optional' : 'none';
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const db = admin.env.DB!;
  let jobsToday = 0;
  let recent: Array<Record<string, unknown>> = [];
  let lastSuccess: Record<string, unknown> | null = null;
  let lastError: Record<string, unknown> | null = null;
  try {
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM gym_durable_jobs WHERE job_type = 'coach' AND created_at >= ?`)
      .bind(today.toISOString()).first<{ n: number }>();
    jobsToday = count?.n || 0;
    const rows = await db.prepare(`SELECT json_extract(payload_json, '$.kind') AS kind, status,
        json_extract(result_json, '$.outcome') AS outcome, json_extract(result_json, '$.errorClass') AS errorClass,
        created_at AS createdAt, updated_at AS updatedAt
      FROM gym_durable_jobs WHERE job_type = 'coach' ORDER BY created_at DESC LIMIT 20`).all<{
      kind: string | null; status: string; outcome: string | null; errorClass: string | null; createdAt: string; updatedAt: string;
    }>();
    recent = rows.results.map(row => ({ kind: row.kind || 'create', outcome: row.outcome || (row.status === 'failed' ? 'failed' : row.status === 'succeeded' ? 'ready' : row.status), at: Date.parse(row.updatedAt), ms: Math.max(0, Date.parse(row.updatedAt) - Date.parse(row.createdAt)), ...(row.errorClass ? { errorClass: row.errorClass } : {}) }));
    const success = rows.results.find(row => row.status === 'succeeded');
    const failure = rows.results.find(row => row.status === 'failed');
    if (success) lastSuccess = { at: Date.parse(success.updatedAt) };
    if (failure) lastError = { errorClass: failure.errorClass || 'internal', at: Date.parse(failure.updatedAt) };
  } catch { /* no activity is safer than returning job payloads or blocking the admin screen */ }
  const baseUrl = settings.provider === 'compatible' ? settings.baseUrl : null;
  const host = (() => { try { return new URL(settings.baseUrl).host; } catch { return null; } })();
  const scheme = (() => { try { return new URL(settings.baseUrl).protocol === 'http:' ? 'HTTP' : 'HTTPS'; } catch { return 'HTTPS'; } })();
  const runtimeOk = runtime.configured && (!!settings.hasCredential || keyOptional);
  return json({
    disabledByEnv: runtime.disabledByEnv,
    enabled: settings.enabled,
    provider: settings.provider,
    providers,
    model: settings.model || '',
    models: settings.models || {},
    knownModels: null,
    baseUrl,
    headers: settings.headers || {},
    caps: settings.caps,
    maxMessageLen: settings.maxMessageLen,
    maxOutputTokens: settings.maxOutputTokens,
    community: settings.community,
    runtime: { ok: runtimeOk, version: runtimeOk ? `${scheme} · ${host}` : null, error: runtimeOk ? null : errorText(runtime.reason || (settings.credentialError ? 'credential_unreadable' : null)) },
    authMode: 'instance',
    auth: { state: authState, type: settings.hasCredential ? 'apikey' : null, account: null, connectedAt: null },
    unprivileged: { ok: true, dropped: false, why: 'Cloudflare Workers provides runtime isolation.' },
    jobsToday, lastSuccess, lastError, recent,
  });
};

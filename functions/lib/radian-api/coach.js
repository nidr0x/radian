import * as payloadLib from '../../../api/coach/core/payload.js';
import { runPipeline } from '../../../api/coach/core/pipeline.js';
import { HTTP_PROVIDERS, baseUrlFor, validateBaseUrl, validateHeaders } from '../../../api/coach/core/providers.js';
import { hashPlan } from '../../../api/coach/core/plan-hash.js';
import anthropic from '../../../api/coach/core/adapters/anthropic.js';
import openai from '../../../api/coach/core/adapters/openai.js';
import gemini from '../../../api/coach/core/adapters/gemini.js';
import compatible from '../../../api/coach/core/adapters/compatible.js';
import { coachPromptCohort, readCoachCohortData } from './coach-cohort';

const ADAPTERS = { anthropic, openai, gemini, compatible };
const HANDLE_SECRET_MIN = 32;
const PENDING_DAYS = 14;
const DEFAULT_LIMITS = Object.freeze({ perProfileDaily: 10, instanceDaily: 0, maxMessageLen: 1000, maxOutputTokens: 16000 });
const LIMIT_ENV = Object.freeze({
  perProfileDaily: 'COACH_CAP_PER_PROFILE', instanceDaily: 'COACH_CAP_INSTANCE',
  maxMessageLen: 'COACH_MAX_MESSAGE_LEN', maxOutputTokens: 'COACH_MAX_OUTPUT_TOKENS',
});

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const bounded = (value, min, max, fallback) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
const fromEnv = (env, key) => {
  const raw = env[LIMIT_ENV[key]];
  return raw == null || raw === '' ? DEFAULT_LIMITS[key] : bounded(raw, key === 'maxMessageLen' ? 200 : key === 'maxOutputTokens' ? 1024 : 0, key === 'perProfileDaily' ? 200 : key === 'instanceDaily' ? 5000 : key === 'maxMessageLen' ? 4000 : 65536, DEFAULT_LIMITS[key]);
};

const decodeJson = value => {
  let parsed;
  try { parsed = JSON.parse(value || '{}'); } catch { throw new Error('config_unavailable'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config_unavailable');
  return parsed;
};
const bytesToB64 = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const b64ToBytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const wrappingKey = env => {
  const raw = String(env.COACH_CREDENTIAL_WRAP_KEY || '').trim();
  if (/^[a-f\d]{64}$/i.test(raw)) return Uint8Array.from(raw.match(/.{2}/g), byte => parseInt(byte, 16));
  try { const bytes = b64ToBytes(raw); return bytes.byteLength === 32 ? bytes : null; } catch { return null; }
};

const privateIpv4 = value => {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (parts[2] === 0 || parts[2] === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100)))
    || (a === 203 && b === 0 && parts[2] === 113)
    || (a === 100 && b >= 64 && b <= 127);
};

// The shared provider validator still permits HTTP for the legacy native client. Pages/Jobs
// Workers require hosted HTTPS URLs and reject obvious private/local destinations here.
export const validateCoachWorkerBaseUrl = raw => {
  const checked = validateBaseUrl(raw);
  if (!checked.ok || !checked.value) return checked;
  const url = new URL(checked.value);
  if (url.protocol !== 'https:') return { ok: false, error: 'Cloudflare Workers require an HTTPS endpoint' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || /\.(?:localhost|local|lan|internal|home|test|invalid)$/.test(host)) {
    return { ok: false, error: 'The endpoint must use a public host, not a local network name' };
  }
  if (!host.includes('.') && !host.includes(':')) return { ok: false, error: 'The endpoint must use a public hostname or IP address' };
  if (privateIpv4(host)) return { ok: false, error: 'The endpoint must not use a private or reserved IP address' };
  if (host.includes(':')) {
    const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host) || /^2001:db8/.test(host)
      || (mapped && privateIpv4(mapped[1]))) {
      return { ok: false, error: 'The endpoint must not use a private or reserved IP address' };
    }
  }
  return checked;
};

const cryptoKey = async env => {
  const bytes = wrappingKey(env);
  if (!bytes) throw new Error('credential_wrap_unavailable');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

export const encryptCoachCredential = async (env, provider, token) => {
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) throw new Error('invalid_credential');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await cryptoKey(env);
  const aad = new TextEncoder().encode(`coach-credential:${provider}`);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, new TextEncoder().encode(token.trim()));
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(cipher)) };
};

const decryptCoachCredential = async (env, provider, stored) => {
  const key = await cryptoKey(env);
  try {
    const aad = new TextEncoder().encode(`coach-credential:${provider}`);
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(stored.iv), additionalData: aad }, key, b64ToBytes(stored.ciphertext));
    const value = new TextDecoder().decode(clear);
    if (!value || value.length > 4096) throw new Error('credential_unreadable');
    return value;
  } catch (error) {
    if (error?.message === 'credential_wrap_unavailable') throw error;
    throw new Error('credential_unreadable');
  }
};

export const saveCoachCredential = async (env, provider, token) => {
  if (!env.DB) throw new Error('database_unavailable');
  if (!Object.hasOwn(HTTP_PROVIDERS, provider)) throw new Error('provider_unavailable');
  const encrypted = await encryptCoachCredential(env, provider, token);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO gym_coach_credentials(provider, ciphertext, iv, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext,
    iv = excluded.iv, updated_at = excluded.updated_at`).bind(provider, encrypted.ciphertext, encrypted.iv, now).run();
};

export const removeCoachCredential = async (env, provider) => {
  if (!env.DB) throw new Error('database_unavailable');
  if (!Object.hasOwn(HTTP_PROVIDERS, provider)) throw new Error('provider_unavailable');
  await env.DB.prepare('DELETE FROM gym_coach_credentials WHERE provider = ?').bind(provider).run();
};

export const saveCoachConfig = async (env, config) => {
  if (!env.DB) throw new Error('database_unavailable');
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO gym_coach_config(singleton_id, config_json, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(config), now).run();
};

export const readCoachSettings = async env => {
  let stored = {};
  let configRowExists = false;
  let credentialRow = null;
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT config_json AS configJson FROM gym_coach_config WHERE singleton_id = 1').first();
      if (typeof row?.configJson === 'string') {
        configRowExists = true;
        stored = decodeJson(row.configJson);
      }
    } catch { throw new Error('config_unavailable'); }
  }
  const provider = typeof stored.provider === 'string' ? stored.provider : configRowExists ? '' : env.COACH_PROVIDER || 'openai';
  const meta = Object.hasOwn(HTTP_PROVIDERS, provider) ? HTTP_PROVIDERS[provider] : null;
  if (env.DB && meta) {
    try { credentialRow = await env.DB.prepare('SELECT ciphertext, iv FROM gym_coach_credentials WHERE provider = ?').bind(provider).first(); }
    catch { throw new Error('config_unavailable'); }
  }
  let credential = null;
  let credentialError = null;
  if (credentialRow) {
    try { credential = await decryptCoachCredential(env, provider, credentialRow); }
    catch (error) { credentialError = error?.message || 'credential_unreadable'; }
  }
  const options = record(stored.providerOptions);
  const providerOption = record(options[provider]);
  const rawBaseUrl = provider === 'compatible'
    ? (typeof stored.baseUrl === 'string' && stored.baseUrl.trim() ? stored.baseUrl : env.COACH_BASE_URL || providerOption.baseUrl || '')
    : providerOption.baseUrl;
  const checkedBase = rawBaseUrl ? validateCoachWorkerBaseUrl(rawBaseUrl) : { ok: true, value: null };
  const checkedHeaders = validateHeaders(stored.headers ?? providerOption.headers);
  const baseUrl = checkedBase.ok ? checkedBase.value : null;
  const modelMap = Object.fromEntries(Object.entries(record(stored.models))
    .filter(([id, value]) => Object.hasOwn(HTTP_PROVIDERS, id) && typeof value === 'string' && value.length <= 80));
  const model = typeof modelMap[provider] === 'string' ? modelMap[provider]
    : typeof stored.model === 'string' ? stored.model : env.COACH_MODEL || meta?.defaultModel || null;
  const caps = {
    perProfileDaily: bounded(stored.caps?.perProfileDaily ?? fromEnv(env, 'perProfileDaily'), 0, 200, DEFAULT_LIMITS.perProfileDaily),
    instanceDaily: bounded(stored.caps?.instanceDaily ?? fromEnv(env, 'instanceDaily'), 0, 5000, DEFAULT_LIMITS.instanceDaily),
  };
  const maxMessageLen = bounded(stored.maxMessageLen ?? fromEnv(env, 'maxMessageLen'), 200, 4000, DEFAULT_LIMITS.maxMessageLen);
  const maxOutputTokens = bounded(stored.maxOutputTokens ?? fromEnv(env, 'maxOutputTokens'), 1024, 65536, DEFAULT_LIMITS.maxOutputTokens);
  const envCredential = meta?.apiKeyEnv ? env[meta.apiKeyEnv] || null : null;
  return {
    enabled: env.COACH_DISABLED !== '1' && (typeof stored.enabled === 'boolean' ? stored.enabled : true),
    provider, meta, model, baseUrl: checkedBase.ok ? (baseUrl || (meta ? baseUrlFor(provider, { providerOptions: { [provider]: providerOption } }) : '')) : '',
    headers: checkedHeaders.ok ? checkedHeaders.value : null,
    headersError: checkedHeaders.ok ? null : 'headers_unavailable',
    baseUrlError: checkedBase.ok ? null : 'base_url_unavailable',
    apiKey: credential || envCredential, hasCredential: !!credential || !!envCredential,
    credentialStored: !!credentialRow, credentialError, caps, maxMessageLen, maxOutputTokens,
    community: typeof stored.community === 'boolean' ? stored.community : env.COACH_COMMUNITY === '1',
    models: modelMap,
    disabledByEnv: env.COACH_DISABLED === '1',
  };
};

const providerConfig = async env => {
  const settings = await readCoachSettings(env);
  const { provider, meta } = settings;
  const adapter = Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : null;
  const apiKey = settings.apiKey;
  const checkedBase = settings.baseUrl ? validateCoachWorkerBaseUrl(settings.baseUrl) : { ok: true, value: null };
  const reason = !settings.enabled ? 'disabled'
    : !meta || !adapter ? 'provider_unavailable'
      : !env.COACH_HANDLE_SECRET || env.COACH_HANDLE_SECRET.length < HANDLE_SECRET_MIN ? 'handle_secret_unavailable'
        : settings.credentialError || settings.headersError ? settings.credentialError || settings.headersError
          : settings.baseUrlError || !checkedBase.ok ? 'base_url_unavailable'
            : !apiKey && !(meta.keyOptional && settings.baseUrl) ? 'credential_unavailable'
              : provider === 'compatible' && !settings.baseUrl ? 'base_url_unavailable' : null;
  const providerOptions = { [provider]: {
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    ...(settings.headers ? { headers: settings.headers } : {}),
  } };
  return { ...settings, adapter, cfg: { provider, providerOptions }, reason };
};

// Used only by the explicit admin model-list and test routes. It deliberately shares the
// provider/configuration validation with durable jobs without requiring the unrelated HMAC
// handle secret used to anonymize user payloads.
export const coachExplicitProvider = async env => {
  let configured;
  try { configured = await providerConfig(env); }
  catch { return { reason: 'config_unavailable', provider: null, adapter: null, cfg: null, apiKey: null, meta: null }; }
  if (configured.reason === 'handle_secret_unavailable') return { ...configured, reason: null };
  return configured;
};

export const coachRuntime = async env => {
  let configured;
  try { configured = await providerConfig(env); }
  catch {
    return { provider: null, providerLabel: null, host: null, model: null, configured: false,
      reason: 'config_unavailable', enabled: false, disabledByEnv: env.COACH_DISABLED === '1',
      caps: { perProfileDaily: DEFAULT_LIMITS.perProfileDaily, instanceDaily: DEFAULT_LIMITS.instanceDaily }, maxMessageLen: DEFAULT_LIMITS.maxMessageLen,
      maxOutputTokens: DEFAULT_LIMITS.maxOutputTokens, community: false, hasCredential: false, credentialStored: false };
  }
  let host = null;
  try { host = configured.baseUrl ? new URL(configured.baseUrl).host : null; } catch { /* invalid base is reported as unavailable */ }
  return {
    provider: configured.meta ? configured.provider : null,
    providerLabel: configured.meta?.label || null,
    host,
    model: configured.model,
    configured: !configured.reason,
    reason: configured.reason,
    enabled: configured.enabled,
    disabledByEnv: configured.disabledByEnv,
    caps: configured.caps,
    maxMessageLen: configured.maxMessageLen,
    maxOutputTokens: configured.maxOutputTokens,
    community: configured.community,
    hasCredential: configured.hasCredential,
    credentialStored: configured.credentialStored,
  };
};

const accountHandle = async (secret, accountId) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(accountId)));
  let binary = '';
  for (const byte of digest.slice(0, 12)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '').slice(0, 16);
};

export const isRetryableCoachFailure = result => {
  if (result?.errorClass === 'timeout') return true;
  const detail = String(result?.detail || '');
  return result?.errorClass === 'provider'
    && (/\b(?:429|500|502|503|504|529)\b/.test(detail) || /could not reach|fetch failed|network/i.test(detail));
};

export const runCoachJob = async (state, job, env, now = new Date(), fetchImpl = globalThis.fetch) => {
  if (!state?.coach?.consent?.agreedAt) return { ok: false, errorClass: 'consent' };
  let configured;
  try { configured = await providerConfig(env); }
  catch { return { ok: false, errorClass: 'missing' }; }
  if (configured.reason) return { ok: false, errorClass: configured.reason === 'disabled' ? 'off' : 'missing' };
  const kind = job?.kind;
  if (!['create', 'review', 'debrief'].includes(kind)) return { ok: false, errorClass: 'internal' };
  const options = job.options && typeof job.options === 'object' && !Array.isArray(job.options) ? job.options : {};
  let cohort = null;
  if (configured.community && env.DB) {
    try { cohort = coachPromptCohort(await readCoachCohortData(env.DB, job.accountId, now.getTime(), state)); }
    catch { /* Cohort is optional; a failed aggregate is omitted from the provider payload. */ }
  }
  const payload = payloadLib.build(state, {
    ...options,
    ...(cohort ? { cohort } : {}),
    handle: await accountHandle(env.COACH_HANDLE_SECRET, job.accountId),
    kind,
    lang: job.lang,
  });
  const result = await runPipeline({
    adapter: configured.adapter,
    cfg: configured.cfg,
    kind,
    payload,
    model: configured.model || configured.meta.defaultModel,
    timeoutMs: 5 * 60_000,
    invokeOpts: { env: configured.apiKey ? { [configured.meta.apiKeyEnv]: configured.apiKey } : {}, fetch: fetchImpl, maxTokens: configured.maxOutputTokens },
  });
  if (!result.ok) {
    return { ok: false, errorClass: result.errorClass || 'internal', retryable: isRetryableCoachFailure(result) };
  }
  if (result.nochange) return { ok: true, nochange: true, reading: String(result.reading || '').slice(0, 1200) };

  const pending = {
    id: job.jobId,
    kind,
    createdAt: now.getTime(),
    expiresAt: now.getTime() + PENDING_DAYS * 86_400_000,
    planHash: hashPlan(payloadLib.canonicalPlan(state)),
    iteration: Number.isInteger(options.iteration) && options.iteration > 0 ? Math.min(options.iteration, 100) : 1,
    ...(kind === 'debrief' ? { workout: payloadLib.workoutMeta(state, options.workoutId) } : {}),
    ...result.result,
  };
  if (new TextEncoder().encode(JSON.stringify(pending)).byteLength > 60_000) return { ok: false, errorClass: 'unusable' };
  return { ok: true, pending };
};

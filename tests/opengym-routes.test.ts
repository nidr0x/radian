import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SyncContext } from '../functions/types';

const mocks = vi.hoisted(() => ({
  getAuthenticatedContext: vi.fn(),
  enforceAuthRateLimit: vi.fn(),
  requireDatabase: vi.fn(),
  readGymState: vi.fn(),
  readGymRevision: vi.fn(),
  writeGymState: vi.fn(),
}));

vi.mock('../functions/lib/auth', () => ({
  getAuthenticatedContext: mocks.getAuthenticatedContext,
  enforceAuthRateLimit: mocks.enforceAuthRateLimit,
  requireDatabase: mocks.requireDatabase,
  isRecord: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' },
  }),
}));

vi.mock('../functions/lib/db/radian/state', () => ({
  readGymState: mocks.readGymState,
  readGymRevision: mocks.readGymRevision,
  writeGymState: mocks.writeGymState,
  MAX_DOCUMENT_BYTES: 900_000,
}));

import { onRequestGet as getData, onRequestPut } from '../functions/api/data';
import { onRequestGet as getRevision } from '../functions/api/data/rev';
import { onRequestGet as getHealth } from '../functions/api/health';
import { mapLegacyAuthResponse, rewriteJsonRequest } from '../functions/lib/radian-api/compat';

const database = { prepare: vi.fn(), batch: vi.fn() };
const authenticated = { env: { DB: database }, user: { id: 'account-a', displayName: 'Ana', createdAt: '2026-10-26' } };
const context = (request: Request): SyncContext => ({ request, env: { DB: database } });
const jsonRequest = (url: string, method: string, body?: unknown): Request => {
  const headers = new Headers(body === undefined ? {} : { 'Content-Type': 'application/json' });
  if (new URL(url).pathname === '/api/data') headers.set('Accept', 'application/vnd.opengym+json');
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
};

beforeEach(() => vi.clearAllMocks());

describe('contrato Pages de openGym', () => {
  it('adapta el nombre de challenge/user de WebAuthn y conserva la cookie de sesión', async () => {
    const response = await mapLegacyAuthResponse(new Response(JSON.stringify({
      challengeId: 'challenge-1',
      options: { challenge: 'nonce' },
      user: { id: 'account-a', displayName: 'Ana', createdAt: '2026-10-26' },
    }), { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=abc; HttpOnly' } }), {
      request: new Request('https://radian.example/api/register/options'),
      env: {},
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('Set-Cookie')).toContain('session=abc');
    expect(await response.json()).toMatchObject({ cid: 'challenge-1', user: { id: 'account-a', name: 'Ana' } });
  });

  it('reescribe campos de ruta sin perder cookies ni el método HTTP', async () => {
    const original = new Request('https://radian.example/api/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'challenge=secret' },
      body: JSON.stringify({ cid: 'challenge-1', credential: { id: 'credential-1' } }),
    });
    const mapped = await rewriteJsonRequest(context(original), (body) => ({ ...body, challengeId: body.cid }));

    expect(mapped.request.method).toBe('POST');
    expect(mapped.request.headers.get('Cookie')).toBe('challenge=secret');
    expect(await mapped.request.json()).toMatchObject({ cid: 'challenge-1', challengeId: 'challenge-1' });
  });

  it('limita las escrituras autenticadas antes de entrar en el repositorio', async () => {
    const blocked = new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 });
    mocks.getAuthenticatedContext.mockResolvedValue(authenticated);
    mocks.enforceAuthRateLimit.mockResolvedValue(blocked);

    const response = await onRequestPut(context(jsonRequest('https://radian.example/api/data', 'PUT', { state: {} })));

    expect(response).toBe(blocked);
    expect(mocks.writeGymState).not.toHaveBeenCalled();
  });

  it('lee la instantánea y la revisión solo dentro de la sesión autenticada', async () => {
    mocks.getAuthenticatedContext.mockResolvedValue(authenticated);
    mocks.enforceAuthRateLimit.mockResolvedValue(undefined);
    mocks.readGymState.mockResolvedValue({ state: { routines: [], _rev: 4, _wid: 'write-4' }, rev: 4, wid: 'write-4' });
    mocks.readGymRevision.mockResolvedValue({ rev: 4, wid: 'write-4' });

    const data = await getData(context(jsonRequest('https://radian.example/api/data', 'GET')));
    const revision = await getRevision(context(jsonRequest('https://radian.example/api/data/rev', 'GET')));

    expect(await data.json()).toEqual({ state: { routines: [], _rev: 4, _wid: 'write-4' }, rev: 4 });
    expect(await revision.json()).toEqual({ rev: 4, wid: 'write-4' });
    expect(mocks.readGymState).toHaveBeenCalledWith(database, 'account-a');
    expect(mocks.readGymRevision).toHaveBeenCalledWith(database, 'account-a');
  });

  it('conserva el contrato de datos de Radian sin el selector de OpenGym', async () => {
    mocks.getAuthenticatedContext.mockResolvedValue(authenticated);
    const statement = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
    database.prepare.mockReturnValue(statement);

    const response = await getData(context(new Request('https://radian.example/api/data')));

    expect(await response.json()).toEqual({ data: null, updatedAt: null });
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM user_data'));
    expect(mocks.readGymState).not.toHaveBeenCalled();
  });

  it('declara la salud de Radian solo cuando existe el esquema D1', async () => {
    const query = { first: vi.fn().mockResolvedValue(null) };
    mocks.requireDatabase.mockReturnValue({ prepare: vi.fn().mockReturnValue(query) });

    const response = await getHealth(context(jsonRequest('https://radian.example/api/health', 'GET')));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'radian' });
    expect(query.first).toHaveBeenCalledOnce();
  });

  it('valida y escribe el documento con baseRev/baseWid, devuelve conflicto rebasable', async () => {
    mocks.getAuthenticatedContext.mockResolvedValue(authenticated);
    mocks.enforceAuthRateLimit.mockResolvedValue(undefined);
    mocks.writeGymState.mockResolvedValueOnce({ ok: true, rev: 5, wid: 'write-5', replayed: false });
    mocks.writeGymState.mockResolvedValueOnce({ ok: false, conflict: { state: { routines: [] }, rev: 6, wid: 'write-6' } });
    const body = { state: { routines: [] }, baseRev: 4, baseWid: 'write-4', stamped: true };

    const saved = await onRequestPut(context(jsonRequest('https://radian.example/api/data', 'PUT', body)));
    const conflict = await onRequestPut(context(jsonRequest('https://radian.example/api/data', 'PUT', body)));

    expect(mocks.writeGymState).toHaveBeenNthCalledWith(1, database, 'account-a', expect.objectContaining({
      state: body.state,
      baseRev: 4,
      baseWid: 'write-4',
    }));
    expect(await saved.json()).toEqual({ rev: 5, wid: 'write-5' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'conflict', state: { routines: [] }, rev: 6, wid: 'write-6' });
  });

  it('rechaza JSON inválido, un estado no objeto y cuerpos sobredimensionados', async () => {
    mocks.getAuthenticatedContext.mockResolvedValue(authenticated);
    mocks.enforceAuthRateLimit.mockResolvedValue(undefined);
    const malformed = new Request('https://radian.example/api/data', { method: 'PUT', body: '{' });
    const invalid = jsonRequest('https://radian.example/api/data', 'PUT', { state: [] });
    const large = new Request('https://radian.example/api/data', {
      method: 'PUT',
      body: JSON.stringify({ state: { notes: 'x'.repeat(902_000) } }),
    });

    expect((await onRequestPut(context(malformed))).status).toBe(400);
    expect((await onRequestPut(context(invalid))).status).toBe(400);
    expect((await onRequestPut(context(large))).status).toBe(413);
    expect(mocks.writeGymState).not.toHaveBeenCalled();
  });

  it('el middleware exige origen de mismo origen en mutaciones con cookie', async () => {
    let nextCalls = 0;
    const request = new Request('https://radian.example/api/data', {
      method: 'PUT',
      headers: { Origin: 'https://evil.example', Cookie: 'radian_session=session', 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: {} }),
    });
    const response = await (await import('../functions/_middleware')).onRequest({
      request,
      env: {},
      next: async () => { nextCalls++; return new Response('ok'); },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'cross_site_request' });
    expect(nextCalls).toBe(0);
  });

  it('deja pasar preflight y las llamadas MCP con bearer sin cookie', async () => {
    const middleware = (await import('../functions/_middleware')).onRequest;
    let nextCalls = 0;
    const next = async () => { nextCalls++; return new Response('ok'); };
    const preflight = await middleware({
      request: new Request('https://radian.example/api/data', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } }),
      env: {},
      next,
    });
    const bearer = await middleware({
      request: new Request('https://radian.example/api/mcp', { method: 'POST', headers: { Authorization: 'Bearer access-token', 'Content-Type': 'application/json' }, body: '{}' }),
      env: {},
      next,
    });

    expect(preflight.status).toBe(200);
    expect(bearer.status).toBe(200);
    expect(nextCalls).toBe(2);
  });

  it('mantiene el prepaint inline cubierto por su hash CSP exacto', async () => {
    const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const hash = createHash('sha256').update(script!).digest('base64');
    const response = await (await import('../functions/_middleware')).onRequest({
      request: new Request('https://radian.example/'),
      env: {},
      next: async () => new Response('ok'),
    });

    expect(response.headers.get('Content-Security-Policy')).toContain(`'sha256-${hash}'`);
  });

  it('no usa la excepción MCP bearer para una ruta de datos con origen ajeno', async () => {
    let nextCalls = 0;
    const response = await (await import('../functions/_middleware')).onRequest({
      request: new Request('https://radian.example/api/data', {
        method: 'PUT',
        headers: { Authorization: 'Bearer access-token', Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: {} }),
      }),
      env: {},
      next: async () => { nextCalls++; return new Response('ok'); },
    });

    expect(response.status).toBe(403);
    expect(nextCalls).toBe(0);
  });
});

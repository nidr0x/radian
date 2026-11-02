import { afterEach, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { issueSessionCookie } from '../functions/lib/auth';
import { onRequest as middleware } from '../functions/_middleware';
import { readGymState, writeGymState } from '../functions/lib/db/radian/state';
import type { D1DatabaseLike, SyncContext } from '../functions/types';
import { onRequestPost as disableUser } from '../functions/api/admin/user/disable';
import { onRequestPost as registerClient } from '../functions/api/mcp/register';
import { onRequestGet as authorizeGet, onRequestPost as authorizePost } from '../functions/api/mcp/authorize';
import { onRequestPost as exchangeToken } from '../functions/api/mcp/token';
import { onRequestPost as mcpPost } from '../functions/api/mcp';
import { openTestDatabase } from './support/opengym-d1';

const origin = 'http://localhost';
const databases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const value = openTestDatabase();
  databases.push(value);
  return value;
};

const context = (
  database: ReturnType<typeof openTestDatabase>['d1'],
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown> | URLSearchParams;
    cookie?: string;
    authorization?: string;
  } = {},
): SyncContext => {
  const method = options.method ?? 'POST';
  const headers = new Headers({ Origin: origin, 'CF-Connecting-IP': '127.0.0.1' });
  let body: BodyInit | undefined;
  if (options.body instanceof URLSearchParams) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.authorization) headers.set('Authorization', options.authorization);
  return {
    request: new Request(`${origin}${path}`, { method, headers, ...(body ? { body } : {}) }),
    env: { DB: database, OPENGYM_API: '1', PASSWORD_LOGIN: '1' },
  };
};

const sessionCookie = async (database: ReturnType<typeof openTestDatabase>['d1'], id: string): Promise<string> =>
  (await issueSessionCookie({ request: new Request(`${origin}/api/login/password`), env: { DB: database } }, id, 0)).split(';', 1)[0];

const tokenForm = (values: Record<string, string>): URLSearchParams => new URLSearchParams(values);

const mcpCall = async (database: ReturnType<typeof openTestDatabase>['d1'], accessToken: string, name: string, args: Record<string, unknown> = {}) => {
  const response = await mcpPost(context(database, '/api/mcp', {
    authorization: `Bearer ${accessToken}`,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  }));
  return { response, body: await response.json() as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } } };
};

const authorizeClient = async (database: ReturnType<typeof openTestDatabase>['d1'], userCookie: string, clientName: string) => {
  const redirectUri = `https://client.example.test/${clientName}/callback`;
  const registered = await registerClient(context(database, '/api/mcp/register', {
    body: { client_name: clientName, redirect_uris: [redirectUri] },
  }));
  const client = await registered.json() as { client_id: string };
  expect(registered.status).toBe(201);

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = new URL(`${origin}/api/mcp/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('scope', 'radian:read radian:write offline_access');
  const consent = await authorizeGet(context(database, `${authorizeUrl.pathname}${authorizeUrl.search}`, { method: 'GET', cookie: userCookie }));
  const consentHtml = await consent.text();
  const requestId = consentHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
  const csrfToken = consentHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  expect(consent.status).toBe(200);
  expect(requestId).toBeTruthy();
  expect(csrfToken).toBeTruthy();

  const consentContext = context(database, '/api/mcp/authorize', {
    cookie: userCookie,
    body: tokenForm({ request_id: requestId!, csrf_token: csrfToken!, decision: 'approve' }),
  });
  const consented = await middleware({ ...consentContext, next: () => authorizePost(consentContext) });
  const code = new URL(consented.headers.get('Location')!).searchParams.get('code')!;
  const exchanged = await exchangeToken(context(database, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier }),
  }));
  const tokens = await exchanged.json() as { access_token: string; refresh_token: string };
  expect(consented.status).toBe(302);
  expect(exchanged.status).toBe(200);
  return { clientId: client.client_id, ...tokens };
};

const pauseAfterFirst = (database: D1DatabaseLike, matches: (query: string) => boolean) => {
  let arrive!: () => void;
  let resume!: () => void;
  let paused = false;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const blocked = new Promise<void>((resolve) => { resume = resolve; });
  const gated: D1DatabaseLike = {
    prepare(query) {
      const statement = database.prepare(query);
      if (!matches(query)) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        bound.first = async <T>() => {
          const row = await first<T>();
          if (row && !paused) {
            paused = true;
            arrive();
            await blocked;
          }
          return row;
        };
        return bound;
      };
      return statement;
    },
    batch: (statements) => database.batch(statements),
  };
  return { database: gated, reached, release: () => resume() };
};

afterEach(() => { while (databases.length) databases.pop()?.database.close(); });

it('completa OAuth MCP con PKCE, rota refresh, aplica preview y revoca tokens al desactivar la cuenta', async () => {
  const { database, d1 } = makeDatabase();
  database.prepare('UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?').run('account-a');
  database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
    .run('mcp-smoke-user', 'Cuenta MCP sintética', '2026-10-26T00:00:00.000Z');
  const ownerCookie = await sessionCookie(d1, 'account-a');
  const userCookie = await sessionCookie(d1, 'mcp-smoke-user');
  const seeded = await writeGymState(d1, 'mcp-smoke-user', {
    state: { workouts: [{ id: 'mcp-smoke-workout', d: '2026-10-26', entries: [] }] },
    baseRev: 0,
    baseWid: null,
  });
  expect(seeded.ok).toBe(true);

  const redirectUri = 'https://client.example.test/oauth/callback';
  const registered = await registerClient(context(d1, '/api/mcp/register', {
    body: { client_name: 'Synthetic MCP route test', redirect_uris: [redirectUri] },
  }));
  const client = await registered.json() as { client_id: string };
  expect(registered.status).toBe(201);
  expect(client.client_id).toBeTruthy();

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = new URL(`${origin}/api/mcp/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('scope', 'radian:read radian:write offline_access');
  authorizeUrl.searchParams.set('state', 'mcp-smoke-state');
  const consent = await authorizeGet(context(d1, `${authorizeUrl.pathname}${authorizeUrl.search}`, {
    method: 'GET', cookie: userCookie,
  }));
  const consentHtml = await consent.text();
  expect(consent.status).toBe(200);
  expect(consentHtml).toContain('Synthetic MCP route test');
  expect(consentHtml).toContain('Permitir leer y modificar');
  const requestId = consentHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
  const csrfToken = consentHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  expect(requestId).toBeTruthy();
  expect(csrfToken).toBeTruthy();

  let crossSiteNextCalls = 0;
  const crossSiteConsent = await middleware({
    request: new Request(`${origin}/api/mcp/authorize`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'decision=approve',
    }),
    env: {},
    next: async () => { crossSiteNextCalls++; return new Response('ok'); },
  });
  expect(crossSiteConsent.status).toBe(403);
  expect(crossSiteNextCalls).toBe(0);

  const consentContext = context(d1, '/api/mcp/authorize', {
    cookie: userCookie,
    body: tokenForm({ request_id: requestId!, csrf_token: csrfToken!, decision: 'approve' }),
  });
  const consented = await middleware({ ...consentContext, next: () => authorizePost(consentContext) });
  expect(consented.status).toBe(302);
  const callback = new URL(consented.headers.get('Location')!);
  const code = callback.searchParams.get('code')!;
  expect(callback.searchParams.get('state')).toBe('mcp-smoke-state');
  expect(code).toBeTruthy();

  const badVerifier = await exchangeToken(context(d1, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: `${verifier}wrong` }),
  }));
  expect(badVerifier.status).toBe(400);
  const exchanged = await exchangeToken(context(d1, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier }),
  }));
  const initialTokens = await exchanged.json() as { access_token: string; refresh_token: string; scope: string };
  expect(exchanged.status).toBe(200);
  expect(initialTokens.scope).toBe('radian:read radian:write offline_access');

  const replayCode = await exchangeToken(context(d1, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier }),
  }));
  expect(replayCode.status).toBe(400);
  const refreshed = await exchangeToken(context(d1, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: initialTokens.refresh_token }),
  }));
  const rotatedTokens = await refreshed.json() as { access_token: string; refresh_token: string };
  expect(refreshed.status).toBe(200);
  expect(rotatedTokens.refresh_token).not.toBe(initialTokens.refresh_token);
  const reusedRefresh = await exchangeToken(context(d1, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: initialTokens.refresh_token }),
  }));
  expect(reusedRefresh.status).toBe(400);

  const listed = await mcpPost(context(d1, '/api/mcp', {
    authorization: `Bearer ${rotatedTokens.access_token}`,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  }));
  const listedBody = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
  expect(listed.status).toBe(200);
  expect(listedBody.result?.tools?.map((tool) => tool.name)).toContain('preview_delete_workout');

  const beforePreview = await mcpCall(d1, rotatedTokens.access_token, 'list_workouts');
  const snapshot = beforePreview.body.result?.structuredContent as { rev: number; wid: string | null; workouts: unknown[] };
  expect(snapshot.workouts).toHaveLength(1);
  const preview = await mcpCall(d1, rotatedTokens.access_token, 'preview_delete_workout', {
    baseRev: snapshot.rev, baseWid: snapshot.wid, idempotencyKey: 'mcp-route-preview', workoutId: 'mcp-smoke-workout',
  });
  const proposal = preview.body.result?.structuredContent as { changeId: string; requiresConfirmation: boolean };
  expect(proposal.requiresConfirmation).toBe(true);
  expect((await readGymState(d1, 'mcp-smoke-user')).state?.workouts).toHaveLength(1);

  const declined = await mcpCall(d1, rotatedTokens.access_token, 'apply_change', { changeId: proposal.changeId, confirm: false });
  expect(declined.body.result?.structuredContent?.error).toBe('confirmation_required');
  expect((await readGymState(d1, 'mcp-smoke-user')).state?.workouts).toHaveLength(1);
  const applied = await mcpCall(d1, rotatedTokens.access_token, 'apply_change', { changeId: proposal.changeId, confirm: true });
  expect(applied.body.result?.isError).toBe(false);
  expect((await readGymState(d1, 'mcp-smoke-user')).state?.workouts).toEqual([]);

  const disabled = await disableUser(context(d1, '/api/admin/user/disable', {
    cookie: ownerCookie, body: { id: 'mcp-smoke-user', disabled: true },
  }));
  expect(disabled.status).toBe(200);
  const activeTokens = database.prepare('SELECT COUNT(*) AS count FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL')
    .get('mcp-smoke-user') as { count: number };
  expect(activeTokens.count).toBe(0);
  const revokedAccess = await mcpPost(context(d1, '/api/mcp', {
    authorization: `Bearer ${rotatedTokens.access_token}`,
    body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  }));
  expect(revokedAccess.status).toBe(401);
  const revokedRefresh = await exchangeToken(context(d1, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: rotatedTokens.refresh_token }),
  }));
  expect(revokedRefresh.status).toBe(400);
});

it('no rota refresh si la cuenta se desactiva después de validar el token', async () => {
  const { database, d1 } = makeDatabase();
  database.prepare('UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?').run('account-a');
  database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
    .run('mcp-refresh-race', 'Refresh race', '2026-10-26T00:00:00.000Z');
  const ownerCookie = await sessionCookie(d1, 'account-a');
  const userCookie = await sessionCookie(d1, 'mcp-refresh-race');
  const tokens = await authorizeClient(d1, userCookie, 'mcp-refresh-race');
  expect(database.prepare('SELECT COUNT(*) AS count FROM mcp_tokens WHERE user_id = ?').get('mcp-refresh-race'))
    .toEqual({ count: 2 });

  const barrier = pauseAfterFirst(d1, (query) => query.includes("t.token_type = 'refresh'"));
  const pendingRefresh = exchangeToken(context(barrier.database, '/api/mcp/token', {
    body: tokenForm({ grant_type: 'refresh_token', client_id: tokens.clientId, refresh_token: tokens.refresh_token }),
  }));
  await barrier.reached;
  try {
    const disabled = await disableUser(context(d1, '/api/admin/user/disable', {
      cookie: ownerCookie, body: { id: 'mcp-refresh-race', disabled: true },
    }));
    expect(disabled.status).toBe(200);
  } finally { barrier.release(); }

  const response = await pendingRefresh;
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  const storedTokens = database.prepare('SELECT token_type AS type, revoked_at AS revokedAt FROM mcp_tokens WHERE user_id = ? ORDER BY token_type')
    .all('mcp-refresh-race') as Array<{ type: string; revokedAt: string | null }>;
  expect(storedTokens).toHaveLength(2);
  expect(storedTokens.map((token) => token.type)).toEqual(['access', 'refresh']);
  expect(storedTokens.every((token) => token.revokedAt !== null)).toBe(true);
  expect(database.prepare('SELECT COUNT(*) AS count FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL').get('mcp-refresh-race'))
    .toEqual({ count: 0 });
  expect((await mcpCall(d1, tokens.access_token, 'list_workouts')).response.status).toBe(401);
});

it('no aplica ni consume un cambio si la cuenta se desactiva después de autenticar el acceso', async () => {
  const { database, d1 } = makeDatabase();
  database.prepare('UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?').run('account-a');
  database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
    .run('mcp-apply-race', 'Apply race', '2026-10-26T00:00:00.000Z');
  const ownerCookie = await sessionCookie(d1, 'account-a');
  const userCookie = await sessionCookie(d1, 'mcp-apply-race');
  const seeded = await writeGymState(d1, 'mcp-apply-race', {
    state: { workouts: [{ id: 'race-workout', d: '2026-10-26', entries: [] }] }, baseRev: 0, baseWid: null,
  });
  expect(seeded.ok).toBe(true);
  const tokens = await authorizeClient(d1, userCookie, 'mcp-apply-race');
  const preview = await mcpCall(d1, tokens.access_token, 'preview_delete_workout', {
    baseRev: seeded.ok ? seeded.rev : 0, baseWid: seeded.ok ? seeded.wid : null,
    idempotencyKey: 'apply-race-preview', workoutId: 'race-workout',
  });
  const proposal = preview.body.result?.structuredContent as { changeId: string; requiresConfirmation: boolean };
  expect(proposal.requiresConfirmation).toBe(true);
  const before = await readGymState(d1, 'mcp-apply-race');
  const pendingBefore = database.prepare('SELECT used_at FROM gym_mcp_pending_changes WHERE account_id = ? AND change_id = ?')
    .get('mcp-apply-race', proposal.changeId);
  const revisionCount = database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_revisions WHERE account_id = ?').get('mcp-apply-race');
  const auditCount = database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE account_id = ?').get('mcp-apply-race');

  const barrier = pauseAfterFirst(d1, (query) => query.includes('FROM gym_mcp_pending_changes') && query.includes('SELECT kind, payload_json'));
  const pendingApply = mcpCall(barrier.database, tokens.access_token, 'apply_change', { changeId: proposal.changeId, confirm: true });
  await barrier.reached;
  try {
    const disabled = await disableUser(context(d1, '/api/admin/user/disable', {
      cookie: ownerCookie, body: { id: 'mcp-apply-race', disabled: true },
    }));
    expect(disabled.status).toBe(200);
  } finally { barrier.release(); }

  const applied = await pendingApply;
  expect(applied.body.result?.isError).toBe(true);
  expect(await readGymState(d1, 'mcp-apply-race')).toMatchObject({
    rev: before.rev, wid: before.wid, state: { workouts: [{ id: 'race-workout' }] },
  });
  expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_revisions WHERE account_id = ?').get('mcp-apply-race'))
    .toEqual(revisionCount);
  expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_operations WHERE account_id = ? AND operation_id = ?')
    .get('mcp-apply-race', `apply-${proposal.changeId}`)).toEqual({ count: 0 });
  expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE account_id = ?').get('mcp-apply-race'))
    .toEqual(auditCount);
  expect(database.prepare('SELECT used_at FROM gym_mcp_pending_changes WHERE account_id = ? AND change_id = ?')
    .get('mcp-apply-race', proposal.changeId)).toEqual(pendingBefore);
  expect(database.prepare('SELECT COUNT(*) AS count FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL')
    .get('mcp-apply-race')).toEqual({ count: 0 });
  expect((await mcpCall(d1, tokens.access_token, 'list_workouts')).response.status).toBe(401);
});

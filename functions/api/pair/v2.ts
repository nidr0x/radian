import { json } from '../../lib/auth';
import {
  authorizePair,
  isPairId,
  pairAuthKey,
  pairRateLimit,
  pairRow,
  readBoundedBytes,
  readPairSnapshot,
  revokePair,
  writePairSnapshot,
  type PairContext,
} from '../../lib/pairing/v2';

const sameOriginMutation = (request: Request): boolean => {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return (origin === null || origin === new URL(request.url).origin) && fetchSite !== 'cross-site';
};

const pairIdFromUrl = (request: Request): string => new URL(request.url).searchParams.get('id') ?? '';

export const onRequestGet = async (context: PairContext): Promise<Response> => {
  const pairId = pairIdFromUrl(context.request);
  if (!isPairId(pairId)) return json({ error: 'invalid_pair_id' }, 400);
  if (!context.env.DB) return json({ error: 'database_unavailable' }, 503);
  const limited = await pairRateLimit(context, pairId);
  if (limited) return limited;
  const authorized = await authorizePair(context.env.DB, pairId, pairAuthKey(context.request));
  if (authorized.response) return authorized.response;
  const row = authorized.row;
  if (!row) return json({ error: 'pair_not_found' }, 404);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
  await context.env.DB.prepare(
    'UPDATE gym_pair_channels SET last_active_at = ?, expires_at = ? WHERE pair_id = ? AND revision = ? AND revoked_at IS NULL AND expires_at > ?',
  ).bind(now, expiresAt, pairId, row.revision, now).run();
  const latest = await pairRow(context.env.DB, pairId);
  if (!latest || latest.revokedAt || Date.parse(latest.expiresAt) <= Date.now()) return json({ error: 'pair_expired' }, 410);
  const etag = `"${latest.revision}"`;
  if (context.request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { 'Cache-Control': 'private, no-store', ETag: etag } });
  }
  return readPairSnapshot(context, latest);
};

export const onRequestPut = async (context: PairContext): Promise<Response> => {
  if (!sameOriginMutation(context.request)) return json({ error: 'cross_site_request' }, 403);
  if (context.request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
    return json({ error: 'content_type_required' }, 415);
  }
  const pairId = context.request.headers.get('X-Pair-Id') ?? '';
  const authKey = pairAuthKey(context.request) ?? '';
  if (!isPairId(pairId)) return json({ error: 'invalid_pair_id' }, 400);
  const limited = await pairRateLimit(context, pairId);
  if (limited) return limited;
  const ifMatch = context.request.headers.get('If-Match') ?? '';
  const match = /^"?(\d+)"?$/.exec(ifMatch);
  if (!match) return json({ error: 'if_match_required' }, 428);
  const bytes = await readBoundedBytes(context.request, 8 * 1024 * 1024);
  if (!bytes) return json({ error: 'pair_payload_too_large' }, 413);
  return writePairSnapshot(context, pairId, authKey, Number(match[1]), bytes);
};

export const onRequestDelete = async (context: PairContext): Promise<Response> => {
  if (!sameOriginMutation(context.request)) return json({ error: 'cross_site_request' }, 403);
  const pairId = pairIdFromUrl(context.request);
  const authKey = pairAuthKey(context.request) ?? '';
  if (!isPairId(pairId)) return json({ error: 'invalid_pair_id' }, 400);
  const limited = await pairRateLimit(context, pairId);
  if (limited) return limited;
  if (!context.env.DB) return json({ error: 'database_unavailable' }, 503);
  return revokePair(context, pairId, authKey);
};

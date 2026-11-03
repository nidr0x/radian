import { json } from '../../../lib/auth';
import {
  authorizePair,
  isPairId,
  pairAuthKey,
  PAIR_MEDIA_CIPHERTEXT_LIMIT,
  pairRateLimit,
  pairWriteRateLimit,
  readBoundedBytes,
  readPairMedia,
  storePairMedia,
  type PairContext,
} from '../../../lib/pairing/v2';

const sameOriginMutation = (request: Request): boolean => {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return (origin === null || origin === new URL(request.url).origin) && fetchSite !== 'cross-site';
};

const query = (request: Request): { pairId: string; objectId: string } => {
  const url = new URL(request.url);
  return { pairId: url.searchParams.get('id') ?? '', objectId: url.searchParams.get('objectId') ?? '' };
};

export const onRequestGet = async (context: PairContext): Promise<Response> => {
  const { pairId, objectId } = query(context.request);
  if (!isPairId(pairId) || !/^[A-Za-z0-9_-]{16,96}$/.test(objectId)) return json({ error: 'invalid_pair_media_id' }, 400);
  if (!context.env.DB) return json({ error: 'database_unavailable' }, 503);
  const limited = await pairRateLimit(context, pairId);
  if (limited) return limited;
  const authorized = await authorizePair(context.env.DB, pairId, pairAuthKey(context.request));
  if (authorized.response) return authorized.response;
  return readPairMedia(context, pairId, objectId);
};

export const onRequestPut = async (context: PairContext): Promise<Response> => {
  if (!sameOriginMutation(context.request)) return json({ error: 'cross_site_request' }, 403);
  if (context.request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
    return json({ error: 'content_type_required' }, 415);
  }
  const { pairId, objectId } = query(context.request);
  if (!isPairId(pairId) || !/^[A-Za-z0-9_-]{16,96}$/.test(objectId)) return json({ error: 'invalid_pair_media_id' }, 400);
  if (!context.env.DB) return json({ error: 'database_unavailable' }, 503);
  const writeLimited = await pairWriteRateLimit(context);
  if (writeLimited) return writeLimited;
  const limited = await pairRateLimit(context, pairId);
  if (limited) return limited;
  const authorized = await authorizePair(context.env.DB, pairId, pairAuthKey(context.request));
  if (authorized.response) return authorized.response;
  const row = authorized.row;
  if (!row) return json({ error: 'pair_not_found' }, 404);
  const bytes = await readBoundedBytes(context.request, PAIR_MEDIA_CIPHERTEXT_LIMIT);
  if (!bytes) return json({ error: 'pair_payload_too_large' }, 413);
  return storePairMedia(context, row, objectId, bytes);
};

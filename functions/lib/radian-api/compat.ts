import type { SyncContext } from '../../types';
import { getAccountRoles } from '../auth';

type JsonObject = Record<string, unknown>;
type BodyMapper = (body: JsonObject) => JsonObject;

const objectBody = (value: unknown): JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
  ? value as JsonObject
  : {};

export const rewriteJsonRequest = async (context: SyncContext, map: BodyMapper): Promise<SyncContext> => {
  const body = await context.request.clone().json().catch(() => null);
  return {
    ...context,
    request: new Request(context.request, { body: JSON.stringify(map(objectBody(body))) }),
  };
};

export const mapJsonResponse = async (response: Response, map: BodyMapper): Promise<Response> => {
  const body = await response.json().catch(() => null);
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(JSON.stringify(map(objectBody(body))), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const legacyUserShape = (value: unknown): unknown => {
  const user = objectBody(value);
  return { ...user, name: typeof user.displayName === 'string' ? user.displayName : user.name };
};

export const mapLegacyAuthResponse = async (response: Response, context: SyncContext): Promise<Response> => {
  const body: unknown = await response.json().catch(() => null);
  const mapped = objectBody(body);
  let user = mapped.user ? objectBody(mapped.user) : null;
  if (user && typeof user.id === 'string' && context.env.DB) {
    const roles = await getAccountRoles(context.env.DB, user.id, context.env).catch(() => ({ admin: false, owner: false }));
    user = { ...user, ...roles };
  }
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(JSON.stringify({
    ...mapped,
    ...(typeof mapped.challengeId === 'string' ? { cid: mapped.challengeId } : {}),
    ...(user ? { user: legacyUserShape(user) as JsonObject } : {}),
  }), { status: response.status, statusText: response.statusText, headers });
};

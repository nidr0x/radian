import { json } from './lib/auth';
import type { SyncContext } from './types';

interface MiddlewareContext extends SyncContext {
  next: () => Promise<Response>;
}

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
};

const umamiOrigin = (value?: string): string | undefined => {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && url.origin === value ? url.origin : undefined;
  } catch { return undefined; }
};

const contentSecurityPolicy = (analyticsOrigin?: string): string => `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'sha256-+fk/NZNDTDYSJvdWoenF6+KV7NFE14k3qZ9vqz5xdhY='${analyticsOrigin ? ` ${analyticsOrigin}` : ''}; connect-src 'self'${analyticsOrigin ? ` ${analyticsOrigin}` : ''}; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'`;

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const publicOAuthMutations = new Set(['/api/mcp/register', '/api/mcp/token']);

const isMachineBearerRequest = (path: string, request: Request): boolean => path === '/api/mcp'
  && !request.headers.has('Cookie')
  && /^Bearer\s+\S+$/i.test(request.headers.get('Authorization') ?? '');

const allowsRawMedia = (path: string, method: string): boolean => method === 'PUT'
  && /^\/api\/media\/[a-f\d]{64}$/.test(path);

const allowsPairBinary = (path: string, method: string, contentType: string | undefined): boolean => method === 'PUT'
  && contentType === 'application/octet-stream'
  && (path === '/api/pair/v2' || path === '/api/pair/v2/media');

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  let response: Response;
  try {
    const url = new URL(context.request.url);
    const method = context.request.method.toUpperCase();
    const mutating = !safeMethods.has(method);
    const oauthMutation = method === 'POST' && publicOAuthMutations.has(url.pathname);
    const machineRequest = isMachineBearerRequest(url.pathname, context.request);
    const origin = context.request.headers.get('Origin');
    const fetchSite = context.request.headers.get('Sec-Fetch-Site');
    const contentType = context.request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    const jsonMutation = contentType === 'application/json' || allowsRawMedia(url.pathname, method)
      || allowsPairBinary(url.pathname, method, contentType);
    const oauthConsentForm = method === 'POST' && url.pathname === '/api/mcp/authorize'
      && contentType === 'application/x-www-form-urlencoded';
    const sameOrigin = origin === url.origin;

    if (mutating && !oauthMutation && !machineRequest && (!sameOrigin || fetchSite === 'cross-site' || (!jsonMutation && !oauthConsentForm))) {
      response = json({ error: 'cross_site_request', message: 'La solicitud debe proceder de este sitio.' }, 403);
    } else {
      response = await context.next();
    }
  } catch (error: unknown) {
    console.error('Unhandled Pages Function error', {
      path: new URL(context.request.url).pathname,
      error: error instanceof Error ? error.name : 'unknown',
    });
    response = json({ error: 'internal_error', message: 'No se ha podido completar la solicitud.' }, 500);
  }
  const headers = new Headers(response.headers);
  Object.entries(securityHeaders).forEach(([name, value]) => headers.set(name, value));
  headers.set('Content-Security-Policy', contentSecurityPolicy(umamiOrigin(context.env.UMAMI_ORIGIN)));
  if (new URL(context.request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

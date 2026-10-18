import { json } from './lib/auth';
import type { SyncContext } from './types';

interface MiddlewareContext extends SyncContext {
  next: () => Promise<Response>;
}

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'",
};

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  let response: Response;
  try {
    const url = new URL(context.request.url);
    const method = context.request.method.toUpperCase();
    const authMutation = url.pathname.startsWith('/api/auth/') && !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const origin = context.request.headers.get('Origin');
    const fetchSite = context.request.headers.get('Sec-Fetch-Site');
    const contentType = context.request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (authMutation && (contentType !== 'application/json' || (origin !== null && origin !== url.origin) || fetchSite === 'cross-site')) {
      response = json({ error: 'cross_site_request', message: 'La solicitud de autenticación debe proceder de Radian.' }, 403);
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
  if (new URL(context.request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

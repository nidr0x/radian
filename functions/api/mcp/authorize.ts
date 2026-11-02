import {
  clientAllowsRedirect,
  createAuthorizationCode,
  currentMcpUser,
  escapeHtml,
  htmlResponse,
  isAllowedRedirectUri,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  mcpOptions,
  normalizeScope,
  parseForm,
  randomId,
  rateLimitMcp,
  readAuthorizationRequest,
  readClient,
  redirectResponse,
  requireMcpDatabase,
  sha256,
  storeAuthorizationRequest,
} from '../../lib/mcpAuth';
import type { SyncContext } from '../../types';

export const consentPage = (values: { requestId: string; csrfToken: string; clientName: string; scope: string }): string => {
  const writeRequested = values.scope.split(/\s+/).includes(MCP_WRITE_SCOPE);
  const scopeSummary = writeRequested ? 'lectura y modificación' : 'solo lectura';
  const scopeDetail = writeRequested
    ? '<li><strong>Leer</strong>: revisar perfil, rutina, sesiones, medidas y recomendaciones.</li><li><strong>Modificar</strong>: crear o actualizar datos de entrenamiento dentro de tu cuenta.</li>'
    : '<li><strong>Leer</strong>: revisar perfil, rutina, sesiones, medidas y recomendaciones.</li>';
  const consentButton = writeRequested ? 'Permitir leer y modificar' : 'Permitir solo lectura';
  const scopeIntro = writeRequested
    ? 'El alcance solicitado incluye lectura y, si lo autorizas, modificación de tus datos.'
    : 'El alcance solicitado solo permite consultar tus datos.';

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar Radian</title></head>
<body style="font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:1.5rem;line-height:1.5;color:#152019;background:#f7faf6">
  <main style="background:white;border:1px solid #d9e2da;border-radius:1rem;padding:1.5rem;box-shadow:0 1rem 3rem #15201912">
    <p style="text-transform:uppercase;letter-spacing:.12em;font-size:.72rem;color:#5f7565">Radian · acceso de ${scopeSummary}</p>
    <h1 style="font-size:1.7rem;margin:.5rem 0 1rem">Autorizar consulta de entrenamientos</h1>
    <p><strong>${escapeHtml(values.clientName)}</strong> quiere consultar tu perfil, rutina, sesiones, medidas y recomendaciones.</p>
    <p>${scopeIntro} Solo accederá a tu cuenta y nunca a la de otra persona.</p>
    <ul style="margin:1rem 0;padding-left:1.25rem">
      ${scopeDetail}
    </ul>
    <form method="post" action="/api/mcp/authorize" style="display:grid;gap:.75rem;margin-top:1.5rem">
      <input type="hidden" name="request_id" value="${escapeHtml(values.requestId)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(values.csrfToken)}">
      <button name="decision" value="approve" type="submit" style="border:0;border-radius:.7rem;padding:.8rem 1rem;background:#244d2e;color:white;font:inherit;cursor:pointer">${consentButton}</button>
      <button name="decision" value="deny" type="submit" style="border:1px solid #b8c7ba;border-radius:.7rem;padding:.8rem 1rem;background:white;color:#244d2e;font:inherit;cursor:pointer">Cancelar</button>
    </form>
  </main>
</body></html>`;
};

const loginPage = (): string => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inicia sesión en Radian</title></head>
<body style="font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:1.5rem;line-height:1.5;color:#152019;background:#f7faf6">
  <main style="background:white;border:1px solid #d9e2da;border-radius:1rem;padding:1.5rem;box-shadow:0 1rem 3rem #15201912">
    <p style="text-transform:uppercase;letter-spacing:.12em;font-size:.72rem;color:#5f7565">Radian</p>
    <h1 style="font-size:1.7rem;margin:.5rem 0 1rem">Inicia sesión para continuar</h1>
    <p>Abre Radian, entra con tu passkey y vuelve a esta página para autorizar la consulta desde ChatGPT.</p>
    <a href="/" style="display:inline-block;margin-top:1rem;border-radius:.7rem;padding:.8rem 1rem;background:#244d2e;color:white;text-decoration:none">Abrir Radian</a>
  </main>
</body></html>`;

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const database = requireMcpDatabase(context);
  if (database instanceof Response) return database;
  const rateLimitResponse = await rateLimitMcp(context, 'authorize');
  if (rateLimitResponse) return rateLimitResponse;
  const url = new URL(context.request.url);
  const clientId = url.searchParams.get('client_id') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  const state = url.searchParams.get('state') ?? undefined;
  const client = await readClient(database, clientId);
  if (!client || !isAllowedRedirectUri(redirectUri) || !clientAllowsRedirect(client, redirectUri)) return new Response('Solicitud OAuth no válida.', { status: 400 });
  const fail = (error: string, description: string): Response => redirectResponse(redirectUri, { error, error_description: description, state });
  if (url.searchParams.get('response_type') !== 'code') return fail('unsupported_response_type', 'Solo se admite response_type=code.');
  if (url.searchParams.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'Se requiere PKCE con S256.');
  const codeChallenge = url.searchParams.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return fail('invalid_request', 'El code_challenge no es válido.');
  const scope = normalizeScope(url.searchParams.get('scope') ?? undefined);
  if (!scope) return fail('invalid_scope', 'El cliente solo puede solicitar lectura o modificación de Radian.');
  if (scope.includes(MCP_WRITE_SCOPE) && !scope.includes(MCP_READ_SCOPE)) return fail('invalid_scope', 'La escritura requiere también permiso de lectura.');

  const authenticated = await currentMcpUser(context);
  if (authenticated instanceof Response) {
    if (authenticated.status === 401) return htmlResponse(loginPage(), 401);
    return authenticated;
  }
  const requestId = randomId(18);
  const csrfToken = randomId(24);
  await storeAuthorizationRequest(database, { id: requestId, clientId, userId: authenticated.user.id, redirectUri, codeChallenge, scope, state, csrfTokenHash: await sha256(csrfToken) });
  return htmlResponse(consentPage({ requestId, csrfToken, clientName: client.clientName, scope }));
};

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const database = requireMcpDatabase(context);
  if (database instanceof Response) return database;
  const values = await parseForm(context.request);
  const requestId = values.get('request_id') ?? '';
  const csrfToken = values.get('csrf_token') ?? '';
  const request = await readAuthorizationRequest(database, requestId);
  if (!request || Date.parse(request.expiresAt) <= Date.now() || request.csrfTokenHash !== await sha256(csrfToken)) return htmlResponse('<p>La solicitud de autorización ha caducado. Vuelve a iniciar la conexión desde ChatGPT.</p>', 400);
  const authenticated = await currentMcpUser(context);
  if (authenticated instanceof Response) return authenticated;
  if (authenticated.user.id !== request.userId) return htmlResponse('<p>La sesión no coincide con la solicitud de autorización.</p>', 403);
  if (values.get('decision') !== 'approve') {
    await database.prepare('DELETE FROM mcp_authorization_requests WHERE id = ?').bind(request.id).run();
    return redirectResponse(request.redirectUri, { error: 'access_denied', error_description: 'El usuario canceló el acceso.', state: request.state });
  }
  const code = await createAuthorizationCode(database, request);
  return redirectResponse(request.redirectUri, { code, state: request.state });
};

export const onRequestOptions = (): Response => mcpOptions();

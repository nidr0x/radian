import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  mcpJson,
  mcpOptions,
  parseForm,
  rateLimitMcp,
  readClient,
  requireMcpDatabase,
} from '../../lib/mcpAuth';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const database = requireMcpDatabase(context);
  if (database instanceof Response) return database;
  const rateLimitResponse = await rateLimitMcp(context, 'token');
  if (rateLimitResponse) return rateLimitResponse;
  const values = await parseForm(context.request);
  const clientId = values.get('client_id') ?? '';
  const client = await readClient(database, clientId);
  if (!client) return mcpJson({ error: 'invalid_client', error_description: 'El cliente MCP no está registrado.' }, 401);
  const grantType = values.get('grant_type');
  const response = grantType === 'authorization_code'
    ? await exchangeAuthorizationCode(database, {
      code: values.get('code') ?? '',
      clientId,
      redirectUri: values.get('redirect_uri') ?? '',
      codeVerifier: values.get('code_verifier') ?? '',
    })
    : grantType === 'refresh_token'
      ? await exchangeRefreshToken(database, { refreshToken: values.get('refresh_token') ?? '', clientId })
      : undefined;
  if (!response) return mcpJson({ error: 'invalid_grant', error_description: 'El código o token no es válido, ha caducado o ya se ha utilizado.' }, 400);
  return mcpJson({
    access_token: response.accessToken,
    token_type: 'Bearer',
    expires_in: response.expiresIn,
    refresh_token: response.refreshToken,
    scope: response.scope,
  });
};

export const onRequestOptions = (): Response => mcpOptions();

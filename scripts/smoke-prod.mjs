import { isCloudflarePerimeterBlock } from './smoke-policy.mjs';

const baseUrl = (process.env.RADIAN_SMOKE_URL ?? 'https://radian.nidr0x.win').replace(/\/+$/, '');

const fail = (message) => {
  throw new Error(message);
};

const response = await fetch(`${baseUrl}/`, { cache: 'no-store', redirect: 'follow' });
if (!response.ok) {
  if (isCloudflarePerimeterBlock(response)) {
    console.warn('Smoke bloqueado por el perímetro de Cloudflare (HTTP 403); la ejecución necesita una ruta de CI permitida.');
    process.exit(2);
  }
  fail(`La página principal respondió ${response.status}.`);
}

const html = await response.text();
if (!html.includes('id="root"')) {
  fail('La página principal no contiene el punto de montaje de Radian.');
}

const moduleMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/i);
if (!moduleMatch) {
  fail('La página publicada no conserva el script principal como módulo.');
}

const assetUrl = new URL(moduleMatch[1], baseUrl).toString();
const assetResponse = await fetch(assetUrl, { cache: 'no-store', redirect: 'follow' });
if (!assetResponse.ok) {
  fail(`El bundle principal respondió ${assetResponse.status}.`);
}

const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: 'no-store', redirect: 'follow' });
if (!healthResponse.ok) {
  fail(`El endpoint de salud respondió ${healthResponse.status}.`);
}

const health = await healthResponse.json();
if (health.ok !== true) {
  fail('El endpoint de salud no indicó que el servicio esté operativo.');
}

const oauthMetadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { cache: 'no-store', redirect: 'follow' });
if (!oauthMetadataResponse.ok) {
  fail(`Los metadatos OAuth respondieron ${oauthMetadataResponse.status}.`);
}

const oauthMetadata = await oauthMetadataResponse.json();
if (oauthMetadata.issuer !== baseUrl || oauthMetadata.authorization_endpoint !== `${baseUrl}/api/mcp/authorize` || oauthMetadata.token_endpoint !== `${baseUrl}/api/mcp/token`) {
  fail('Los metadatos OAuth no apuntan a los endpoints públicos de producción.');
}

const mcpResponse = await fetch(`${baseUrl}/api/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'smoke', method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
});
if (mcpResponse.status !== 401 || !mcpResponse.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource')) {
  fail(`El endpoint MCP no está protegido correctamente (respondió ${mcpResponse.status}).`);
}

console.log(`Smoke OK: ${baseUrl} · frontend, backend y MCP OAuth disponibles.`);

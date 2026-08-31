const baseUrl = (process.env.RADIAN_SMOKE_URL ?? 'https://radian.nidr0x.win').replace(/\/+$/, '');

const fail = (message) => {
  throw new Error(message);
};

const response = await fetch(`${baseUrl}/`, { cache: 'no-store', redirect: 'follow' });
if (!response.ok) {
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

console.log(`Smoke OK: ${baseUrl} · frontend y backend disponibles.`);

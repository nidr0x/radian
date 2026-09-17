import assert from 'node:assert/strict';
import test from 'node:test';
import { isCloudflarePerimeterBlock } from './smoke-policy.mjs';

test('identifica un 403 del perímetro Cloudflare', () => {
  const response = new Response('', { status: 403, headers: { server: 'cloudflare', 'cf-ray': 'test-ray' } });
  assert.equal(isCloudflarePerimeterBlock(response), true);
});

test('no convierte un 403 de la aplicación en un bloqueo ignorado', () => {
  const response = new Response('', { status: 403, headers: { server: 'cloudflare' } });
  assert.equal(isCloudflarePerimeterBlock(response), false);
});

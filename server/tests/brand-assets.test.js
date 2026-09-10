import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = ':memory:';
const { handleRequest } = await import('../src/server.js');

test('portal serves only the four public brand assets with correct content types', async (t) => {
  const server = http.createServer(handleRequest);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const asset of ['favicon.svg', 'emberstage-logo.svg', 'emberstage-wordmark.svg']) {
    const res = await fetch(`${base}/assets/brand/${asset}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await res.text(), /<svg\b/);
  }
  const css = await fetch(`${base}/assets/css/emberstage_brand.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.match(await css.text(), /--ember-brand-/);
  for (const forbidden of ['/assets/brand/missing.svg', '/assets/brand/../../server/.env', '/assets/css/../js/private.js']) {
    assert.equal((await fetch(base + forbidden)).status, 404);
  }
});

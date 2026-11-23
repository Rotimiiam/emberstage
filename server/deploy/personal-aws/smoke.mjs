// Guest-only synthetic auth acceptance. Child SQLite is :memory:, never live DB.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'https://account.emberstage.live';
let child;
const request = (method, path, data, headers = {}) => new Promise((resolve, reject) => {
  const body = data === undefined ? '' : JSON.stringify(data);
  const req = http.request({ hostname: '127.0.0.1', port: 3101, path, method,
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } }, res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; if (raw.length > 1024 * 1024) req.destroy(); });
    res.on('end', () => {
      let json;
      try { json = JSON.parse(raw); } catch { json = null; }
      resolve({ status: res.statusCode, headers: res.headers, json });
    });
  });
  req.setTimeout(3000, () => req.destroy(new Error('TIMEOUT')));
  req.on('error', reject);
  req.end(body);
});

function session(response) {
  const cookies = response.headers['set-cookie'];
  assert.equal(cookies.length, 2);
  assert(cookies.every(c => /; Secure/.test(c) && /SameSite=Lax/.test(c)));
  assert(cookies.find(c => c.startsWith('session_id=')).includes('; HttpOnly'));
  return {
    Cookie: cookies.map(c => c.split(';')[0]).join('; '),
    'X-CSRF-Token': cookies.find(c => c.startsWith('_csrf=')).split(';')[0].slice(6)
  };
}

let success = false;
try {
  assert.equal(process.getuid(), Number(process.argv[2]));
  child = spawn('/opt/node-v24.22.3-linux-x64/bin/node', [
    '--import', 'data:text/javascript,globalThis.fetch%3Dasync()%3D%3E%7Bthrow%20new%20Error(%22EXTERNAL_FETCH_BLOCKED%22)%7D',
    'src/index.js'
  ], { cwd: '/opt/emberstage/current/server', stdio: 'ignore', env: {
    PATH: '/usr/bin:/bin', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3101',
    APP_BASE_URL: origin, DATABASE_URL: ':memory:', CAMERA_ROOMS_ENABLED: 'false',
    FAKE_WORKERS: 'false', FFMPEG_PATH: '/usr/bin/ffmpeg',
    ENCRYPTION_SECRET: crypto.randomBytes(32).toString('hex')
  }});
  child.on('error', () => {});
  let ready = false;
  for (let n = 0; n < 40; n++) {
    try { ready = (await request('GET', '/api/auth/config')).status === 200; } catch {}
    if (ready) break;
    assert.equal(child.exitCode, null);
    await delay(250);
  }
  assert(ready);
  const auth = await request('GET', '/api/auth/config');
  assert.equal(auth.json.google.enabled, false);
  assert.equal(auth.json.auth0.enabled, false);
  assert.equal((await request('GET', '/app')).status, 200);
  assert.equal((await request('GET', '/api/auth/me')).status, 401);
  assert.equal((await request('GET', '/api/workspaces')).status, 401);
  assert.equal((await request('GET', '/api/auth/config', undefined, { Origin: 'https://untrusted.invalid' })).status, 403);
  const billing = await request('GET', '/api/billing/plan');
  assert.equal(billing.status, 200);
  assert.equal(billing.json.checkoutAvailable, false);
  assert.equal(billing.json.mode, 'unconfigured');
  const email = crypto.randomBytes(16).toString('hex') + '@example.invalid';
  const password = crypto.randomBytes(32).toString('base64url');
  const registered = await request('POST', '/api/auth/register', { email, password, workspaceName: 'Isolated acceptance' });
  assert.equal(registered.status, 201);
  const registeredSession = session(registered);
  const workspace = registered.json.workspace.id;
  assert.equal((await request('GET', '/api/auth/me', undefined, registeredSession)).status, 200);
  const login = await request('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 200);
  const loggedIn = session(login);
  assert.notEqual(loggedIn.Cookie, registeredSession.Cookie);
  assert.equal((await request('GET', '/api/auth/me', undefined, loggedIn)).status, 200);
  assert.equal((await request('POST', `/api/workspaces/${workspace}/devices/link-code`, { name: 'No paid bypass' }, loggedIn)).status, 402);
  assert.equal((await request('POST', '/api/auth/logout', {}, { Cookie: loggedIn.Cookie })).status, 403);
  assert.equal((await request('POST', '/api/auth/logout', {}, { ...loggedIn, 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await request('POST', '/api/auth/logout', {}, loggedIn)).status, 200);
  assert.equal((await request('GET', '/api/auth/me', undefined, loggedIn)).status, 401);
  success = true;
} catch {
  success = false;
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const result = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
    if (!result) { child.kill('SIGKILL'); await exited; success = false; }
  }
}
console.log(success ? 'EMBERSTAGE_ISOLATED_AUTH_SMOKE_VERIFIED' : 'EMBERSTAGE_ISOLATED_AUTH_SMOKE_FAILED');
process.exit(success ? 0 : 1);

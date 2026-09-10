import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Setup global test environment variables BEFORE importing application code
process.env.DATABASE_URL = ':memory:';
process.env.ENCRYPTION_SECRET = 'test-secret-key-must-be-long-and-secure-32-bytes!';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock';
process.env.PAYSTACK_PLAN_CODE = 'PLN_emberstage_test';
process.env.PAYSTACK_PLAN_AMOUNT = '500000';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
process.env.FAKE_WORKERS = 'true';

// Dynamically import to ensure environment variables are evaluated correctly at import time
const { handleRequest, googleOidcClient, providerOAuthClient, auth0OidcClient, getNormalizedAuth0Domain } = await import('../src/server.js');
const { initDatabase, db, queryOne, queryAll } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { nangoClient } = await import('../src/nango-client.js');
const cryptoUtils = await import('../src/crypto-utils.js');

// Re-initialize database in-memory for testing
initDatabase();

// Start test HTTP server on a dynamic port assigned by the OS
let server;
let baseUrl;

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(handleRequest);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function stopServer() {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

// Utility to parse cookies from Set-Cookie headers
function parseSetCookies(headers) {
  const setCookies = headers.getSetCookie ? headers.getSetCookie() : (headers.get('set-cookie') || '').split(',');
  const cookies = {};
  for (const sc of setCookies) {
    if (!sc) continue;
    const parts = sc.split(';')[0].split('=');
    if (parts[0] && parts[1]) {
      cookies[parts[0].trim()] = parts[1].trim();
    }
  }
  return cookies;
}

function createActiveDeviceToken(workspaceId, label) {
  const deviceId = `dev_${label}_${crypto.randomBytes(4).toString('hex')}`;
  const token = `device_${crypto.randomBytes(16).toString('hex')}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86400000).toISOString();
  db.run("INSERT INTO devices (id, workspace_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?)", [deviceId, workspaceId, label, now]);
  db.run("INSERT INTO device_sessions (id, device_id, refresh_token_hash, expires_at, refresh_token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", [tokenHash, deviceId, `refresh_${tokenHash}`, expires, expires, now]);
  return { deviceId, token };
}

async function rotateDeviceIngestKey(workspaceId, deviceId, cookies) {
  const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/${deviceId}/ingest-key/rotate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    }
  });
  const body = await response.json();
  assert.strictEqual(response.status, 200, body.error || 'Ingest key rotation should succeed');
  assert.ok(body.streamKey);
  return body;
}

async function publishIngestKey(streamKey) {
  return fetch(`${baseUrl}/api/streams/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: streamKey }).toString()
  });
}

async function waitForValue(readValue, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for expected state');
}

function paystackSignature(payload) {
  return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(payload).digest('hex');
}

async function postPaystackWebhook(event) {
  const payload = JSON.stringify(event);
  return fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paystack-signature': paystackSignature(payload)
    },
    body: payload
  });
}

// Global test setup
test.before(async () => {
  // Clear any existing tables to guarantee test isolation and idempotency
  db.exec('DELETE FROM web_sessions');
  db.exec('DELETE FROM memberships');
  db.exec('DELETE FROM users');
  db.exec('DELETE FROM workspaces');
  db.exec('DELETE FROM devices');
  db.exec('DELETE FROM device_sessions');
  db.exec('DELETE FROM provider_connections');
  db.exec('DELETE FROM oauth_states');
  db.exec('DELETE FROM streaming_sessions');
  db.exec('DELETE FROM usage_counters');
  db.exec('DELETE FROM audit_records');

  await startServer();
});

test.after(async () => {
  await stopServer();
});

// --- TESTS ---

test('1. Product Auth (Register, Login, CSRF protection)', async () => {
  const email = `test_${Math.random()}@example.com`;
  const password = 'Password123!';
  const workspaceName = 'TestWorkspace';

  // Test Web registration
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, workspaceName })
  });

  if (regRes.status !== 201) {
    console.error('REGISTRATION FAILED:', regRes.status, await regRes.text());
  }

  assert.strictEqual(regRes.status, 201, 'Registration should succeed');
  const regBody = await regRes.json();
  assert.strictEqual(regBody.success, true);
  assert.ok(regBody.user.id);
  assert.strictEqual(regBody.user.email, email);
  assert.ok(regBody.workspace.id);

  const cookies = parseSetCookies(regRes.headers);
  assert.ok(cookies.session_id, 'Should set session_id cookie');
  assert.ok(cookies._csrf, 'Should set _csrf cookie');

  const workspaceId = regBody.workspace.id;

  // Test duplicate registration rejection
  const dupRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, workspaceName })
  });
  assert.strictEqual(dupRes.status, 400, 'Duplicate registration must fail');

  // Test login with valid credentials
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.strictEqual(loginRes.status, 200, 'Login should succeed');
  const loginBody = await loginRes.json();
  assert.strictEqual(loginBody.success, true);

  const loginCookies = parseSetCookies(loginRes.headers);
  assert.ok(loginCookies.session_id);
  assert.ok(loginCookies._csrf);

  // Test CSRF Denial
  // Make mutating request without CSRF headers
  const linkNoCsrfRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${loginCookies.session_id}; _csrf=${loginCookies._csrf}`
    },
    body: JSON.stringify({ name: 'OBS-1' })
  });
  assert.strictEqual(linkNoCsrfRes.status, 403, 'Should reject mutating web request without X-CSRF-Token header');

  // Make mutating request with mismatched CSRF
  const linkMismatchedCsrfRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${loginCookies.session_id}; _csrf=${loginCookies._csrf}`,
      'X-CSRF-Token': 'wrong_csrf_token'
    },
    body: JSON.stringify({ name: 'OBS-1' })
  });
  assert.strictEqual(linkMismatchedCsrfRes.status, 403, 'Should reject mutating web request with mismatched CSRF');

  // Make mutating request with matching CSRF
  const linkSuccessRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${loginCookies.session_id}; _csrf=${loginCookies._csrf}`,
      'X-CSRF-Token': loginCookies._csrf
    },
    body: JSON.stringify({ name: 'OBS-1' })
  });
  assert.strictEqual(linkSuccessRes.status, 200, 'Should succeed with correct CSRF');
  const linkCodeBody = await linkSuccessRes.json();
  assert.ok(linkCodeBody.linkCode);
});

test('2. Tenant Isolation', async () => {
  // Register Tenant A
  const emailA = `tenantA_${Math.random()}@example.com`;
  const resA = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailA, password: 'Password123!', workspaceName: 'WorkspaceA' })
  });
  const bodyA = await resA.json();
  const cookiesA = parseSetCookies(resA.headers);

  // Register Tenant B
  const emailB = `tenantB_${Math.random()}@example.com`;
  const resB = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailB, password: 'Password123!', workspaceName: 'WorkspaceB' })
  });
  const bodyB = await resB.json();
  const cookiesB = parseSetCookies(resB.headers);

  // Tenant A attempts to access Tenant B's workspace endpoints
  const crossRes = await fetch(`${baseUrl}/api/workspaces/${bodyB.workspace.id}/devices`, {
    method: 'GET',
    headers: {
      'Cookie': `session_id=${cookiesA.session_id}; _csrf=${cookiesA._csrf}`
    }
  });

  assert.strictEqual(crossRes.status, 403, 'Cross-tenant access must be blocked with 403 Forbidden');
});

test('3. Workspace Role Denials', async () => {
  // Register Workspace with Owner
  const ownerEmail = `owner_${Math.random()}@example.com`;
  const oRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: 'Password123!', workspaceName: 'RoleTestWorkspace' })
  });
  const oBody = await oRes.json();
  const oCookies = parseSetCookies(oRes.headers);
  const workspaceId = oBody.workspace.id;

  // Create operator user first
  const opEmail = `op_${Math.random()}@example.com`;
  db.run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'fake', ?)", [
    'u_op_test',
    opEmail,
    new Date().toISOString()
  ]);

  // Owner adds user to workspace as "operator"
  const addOpRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${oCookies.session_id}; _csrf=${oCookies._csrf}`,
      'X-CSRF-Token': oCookies._csrf
    },
    body: JSON.stringify({ email: opEmail, role: 'operator' })
  });
  if (addOpRes.status !== 200) {
    console.error('addOpRes FAILED:', addOpRes.status, await addOpRes.text());
  }
  assert.strictEqual(addOpRes.status, 200);

  // Log in as Operator
  // Create web session directly for ease of role denial testing
  const opSessionId = 'sess_op_test';
  const opCsrf = 'csrf_op_test';
  db.run("INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, 'u_op_test', ?, ?)", [
    opSessionId,
    opCsrf,
    new Date(Date.now() + 100000).toISOString()
  ]);

  // Operator tries to add another member (Owner-only route)
  const addByOpRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${opSessionId}; _csrf=${opCsrf}`,
      'X-CSRF-Token': opCsrf
    },
    body: JSON.stringify({ email: 'some@email.com', role: 'finance' })
  });
  assert.strictEqual(addByOpRes.status, 403, 'Operator should be denied access to owner-only endpoints');

  // Create Finance user
  const finEmail = `fin_${Math.random()}@example.com`;
  db.run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'fake', ?)", [
    'u_fin_test',
    finEmail,
    new Date().toISOString()
  ]);

  // Owner adds user to workspace as "finance"
  const addFinRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${oCookies.session_id}; _csrf=${oCookies._csrf}`,
      'X-CSRF-Token': oCookies._csrf
    },
    body: JSON.stringify({ email: finEmail, role: 'finance' })
  });
  assert.strictEqual(addFinRes.status, 200);

  // Create Finance web session
  const finSessionId = 'sess_fin_test';
  const finCsrf = 'csrf_fin_test';
  db.run("INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, 'u_fin_test', ?, ?)", [
    finSessionId,
    finCsrf,
    new Date(Date.now() + 100000).toISOString()
  ]);

  // Finance tries to generate a device link code (Operator/Owner route)
  const linkByFinRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${finSessionId}; _csrf=${finCsrf}`,
      'X-CSRF-Token': finCsrf
    },
    body: JSON.stringify({ name: 'Finance-Device' })
  });
  assert.strictEqual(linkByFinRes.status, 403, 'Finance role must be denied access to device pairing routes');
});

test('4. Link Code Replay and Consuming', async () => {
  // Register
  const email = `lc_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'LinkCodeWorkspace' })
  });
  const body = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const workspaceId = body.workspace.id;

  // Generate Link Code
  const codeRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ name: 'OBS-Playout' })
  });
  const { linkCode } = await codeRes.json();

  // First Pair -> Succeeds
  const pair1Res = await fetch(`${baseUrl}/api/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_code: linkCode.toLowerCase().split('').join(' ') })
  });
  assert.strictEqual(pair1Res.status, 200, 'First pairing should accept normalized lowercase/spaced input');
  const pair1Body = await pair1Res.json();
  assert.ok(pair1Body.accessToken);

  // Second Pair (Replay) -> Fails with 400
  const pair2Res = await fetch(`${baseUrl}/api/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_code: linkCode })
  });
  assert.strictEqual(pair2Res.status, 400, 'Link code replay must fail');
});

test('5. Refresh Token Rotation and Replay Protection', async () => {
  // Pair device and obtain refresh token
  const email = `rt_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'RotationWorkspace' })
  });
  const body = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const workspaceId = body.workspace.id;

  const codeRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ name: 'OBS-Rotate' })
  });
  const { linkCode } = await codeRes.json();

  const pairRes = await fetch(`${baseUrl}/api/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_code: linkCode })
  });
  const pairBody = await pairRes.json();
  const originalRefreshToken = pairBody.refreshToken;

  // First Refresh -> Rotates refresh token successfully
  const refresh1Res = await fetch(`${baseUrl}/api/devices/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: originalRefreshToken })
  });
  assert.strictEqual(refresh1Res.status, 200, 'First refresh should succeed');
  const refresh1Body = await refresh1Res.json();
  assert.ok(refresh1Body.accessToken);
  assert.ok(refresh1Body.refreshToken);
  assert.notStrictEqual(refresh1Body.refreshToken, originalRefreshToken, 'Refresh token must be rotated');

  // Second Refresh with obsolete token (Replay Attack) -> Must fail 401
  const refresh2Res = await fetch(`${baseUrl}/api/devices/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: originalRefreshToken })
  });
  assert.strictEqual(refresh2Res.status, 401, 'Replayed refresh token must be rejected with 401 Unauthorized');
});

test('6. Revoked Device rejection', async () => {
  const email = `rev_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'RevokedDeviceWorkspace' })
  });
  const body = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const workspaceId = body.workspace.id;

  const codeRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ name: 'OBS-Revoke' })
  });
  const { linkCode } = await codeRes.json();

  const pairRes = await fetch(`${baseUrl}/api/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_code: linkCode })
  });
  const { deviceId, accessToken } = await pairRes.json();
  const revokedIngestKey = `esk_${crypto.randomBytes(24).toString('base64url')}`;
  db.run('UPDATE devices SET ingest_key_hash = ?, ingest_key_last4 = ? WHERE id = ?', [
    crypto.createHash('sha256').update(revokedIngestKey).digest('hex'),
    revokedIngestKey.slice(-4),
    deviceId
  ]);

  // Revoke device from Owner dashboard
  const revokeRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/${deviceId}/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    }
  });
  assert.strictEqual(revokeRes.status, 200, 'Revoke operation should succeed');

  // Both device API access and the persistent OBS ingest key are invalid after revocation.
  const bootstrapRes = await fetch(`${baseUrl}/api/device/bootstrap`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  assert.strictEqual(bootstrapRes.status, 401, 'Revoked device API token must be rejected');
  const publishRes = await publishIngestKey(revokedIngestKey);
  assert.strictEqual(publishRes.status, 401, 'Revoked device ingest key must be rejected');
});

test('7. Entitlement Limits (Devices & Expiry)', async () => {
  const email = `ent_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'EntitlementsWorkspace' })
  });
  const body = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const workspaceId = body.workspace.id;

  // On Free/default plan, max_devices = 1.
  // Generate first link code and pair
  const code1Res = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ name: 'Device-1' })
  });
  assert.strictEqual(code1Res.status, 200);
  const { linkCode: code1 } = await code1Res.json();

  const pair1Res = await fetch(`${baseUrl}/api/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_code: code1 })
  });
  assert.strictEqual(pair1Res.status, 200);

  // Attempt to generate second link code on Free plan (limit = 1) -> Must reject with 402/400
  const code2Res = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ name: 'Device-2' })
  });
  assert.strictEqual(code2Res.status, 402, 'Should deny generating link code due to workspace devices limit on Free plan');

  // Upgrade Workspace via simulated Paystack Webhook
  const upgradeRes = await postPaystackWebhook({
    event: 'subscription.create',
    data: {
      id: 123,
      subscription_code: 'SUB_test_123',
      customer: { customer_code: 'CUS_test_123' },
      status: 'active',
      plan: { plan_code: process.env.PAYSTACK_PLAN_CODE },
      metadata: { workspace_id: workspaceId }
    }
  });
  assert.strictEqual(upgradeRes.status, 200);

  // Generate second link code now (upgrade sets max_devices = 3) -> Should succeed
  const code2UpgradeRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ name: 'Device-2' })
  });
  assert.strictEqual(code2UpgradeRes.status, 200, 'Link code creation should succeed after upgrading subscription');
});

test('8. Max Destinations Limit', async () => {
  const email = `dest_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'DestinationsWorkspace' })
  });
  const body = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const workspaceId = body.workspace.id;
  const streamDevice = createActiveDeviceToken(workspaceId, 'limits');

  // On Free plan, max_destinations = 1.
  // Set subscription to active to bypass subscription check, but keep max_destinations = 1
  db.run("UPDATE workspaces SET stripe_status = 'active', max_destinations = 1 WHERE id = ?", [workspaceId]);

  // Custom RTMP is the implemented MVP destination type.
  const encryptedKey = cryptoUtils.encrypt('destination-secret', config.ENCRYPTION_SECRET);
  db.run("INSERT INTO custom_rtmp_targets (id, workspace_id, name, stream_url, encrypted_stream_key, selected, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ['crt_limit_1', workspaceId, 'Custom One', 'rtmps://one.example/live', encryptedKey, new Date().toISOString()]);
  db.run("INSERT INTO custom_rtmp_targets (id, workspace_id, name, stream_url, encrypted_stream_key, selected, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ['crt_limit_2', workspaceId, 'Custom Two', 'rtmps://two.example/live', encryptedKey, new Date().toISOString()]);

  const webStartRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/streams/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ destinations: ['crt_limit_1'] })
  });
  assert.strictEqual(webStartRes.status, 403, 'Contribution credentials must only be issued to paired devices');

  // Preflight with 2 destinations -> Must fail/reject
  const preflightRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/streams/preflight`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ destinations: ['crt_limit_1', 'crt_limit_2'] })
  });
  assert.strictEqual(preflightRes.status, 400, 'Preflight with excess destinations must fail');
  const preflightBody = await preflightRes.json();
  assert.strictEqual(preflightBody.eligible, false);

  // Upgrade to Pro (max_destinations = 3)
  await postPaystackWebhook({
    event: 'subscription.create',
    data: {
      id: 456,
      subscription_code: 'SUB_test_dest',
      customer: { customer_code: 'CUS_test_dest' },
      status: 'active',
      plan: { plan_code: process.env.PAYSTACK_PLAN_CODE },
      metadata: { workspace_id: workspaceId }
    }
  });

  // A Pro workspace can snapshot both selected destinations when OBS publishes.
  const ingest = await rotateDeviceIngestKey(workspaceId, streamDevice.deviceId, cookies);
  const publishRes = await publishIngestKey(ingest.streamKey);
  assert.strictEqual(publishRes.status, 200, 'Publishing with 2 destinations should succeed on Pro plan');
  const stream = await waitForValue(() => queryOne(
    "SELECT id FROM stream_sessions WHERE device_id = ? AND status = 'streaming' ORDER BY created_at DESC LIMIT 1",
    [streamDevice.deviceId]
  ));
  assert.strictEqual(queryOne(
    'SELECT COUNT(*) AS count FROM stream_session_destinations WHERE stream_session_id = ?',
    [stream.id]
  ).count, 2);
});

test('9. Usage Counters Tracking', async () => {
  const email = `usage_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'UsageWorkspace' })
  });
  const body = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const workspaceId = body.workspace.id;
  const streamDevice = createActiveDeviceToken(workspaceId, 'usage');

  // Upgrade workspace to avoid destination limit and set active subscription
  db.run("UPDATE workspaces SET stripe_status = 'active', max_destinations = 5 WHERE id = ?", [workspaceId]);

  const usageKey = cryptoUtils.encrypt('usage-destination-secret', config.ENCRYPTION_SECRET);
  db.run("INSERT INTO custom_rtmp_targets (id, workspace_id, name, stream_url, encrypted_stream_key, selected, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ['crt_usage', workspaceId, 'Usage Target', 'rtmps://usage.example/live', usageKey, new Date().toISOString()]);

  // Publishing the device's reusable key creates and starts the stream session.
  const ingest = await rotateDeviceIngestKey(workspaceId, streamDevice.deviceId, cookies);
  const publishRes = await publishIngestKey(ingest.streamKey);
  assert.strictEqual(publishRes.status, 200);
  const { id: streamId } = await waitForValue(() => queryOne(
    "SELECT id FROM stream_sessions WHERE device_id = ? AND status = 'streaming' ORDER BY created_at DESC LIMIT 1",
    [streamDevice.deviceId]
  ));

  // Stop stream session
  const stopRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/streams/${streamId}/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    }
  });
  assert.strictEqual(stopRes.status, 200);

  // Check usage counters database tables directly
  const sessionsCounter = queryOne(
    "SELECT value FROM usage_counters WHERE workspace_id = ? AND metric = 'stream_sessions_count'",
    [workspaceId]
  );
  assert.strictEqual(sessionsCounter.value, 1, 'Stream session count counter should be exactly 1');

  const hoursCounter = queryOne(
    "SELECT value FROM usage_counters WHERE workspace_id = ? AND metric = 'stream_hours'",
    [workspaceId]
  );
  assert.ok(hoursCounter.value >= 0, 'Stream hours tracking should be recorded');
});

test('10. Signed Webhook Rejection', async () => {
  // Test Paystack webhook signature rejection
  const invalidSigRes = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paystack-signature': '00'.repeat(64)
    },
    body: JSON.stringify({ event: 'subscription.disable' })
  });

  assert.strictEqual(invalidSigRes.status, 400, 'Invalid signature must be rejected with 400 Bad Request');

  const missingSigRes = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ event: 'subscription.disable' })
  });

  assert.strictEqual(missingSigRes.status, 400, 'Missing signature must be rejected with 400 Bad Request');
});

test('10b. Paystack checkout initialization and hosted subscription management', async () => {
  const email = `paystack_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'PaystackWorkspace' })
  });
  assert.strictEqual(reg.status, 201);
  const { workspace } = await reg.json();
  const cookies = parseSetCookies(reg.headers);

  const originalFetch = globalThis.fetch;
  const paystackRequests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (!url.startsWith('https://api.paystack.co/')) return originalFetch(input, options);
    paystackRequests.push({ url, options });
    if (url.endsWith('/transaction/initialize')) {
      return new Response(JSON.stringify({
        status: true,
        data: { authorization_url: 'https://checkout.paystack.com/mock-checkout' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/subscription/SUB_mock/manage/link')) {
      return new Response(JSON.stringify({
        status: true,
        data: { link: 'https://paystack.com/manage/subscriptions/mock' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: false, message: 'Unexpected test URL' }), { status: 404 });
  };

  try {
    const authHeaders = {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    };
    const checkout = await originalFetch(`${baseUrl}/api/workspaces/${workspace.id}/billing/checkout`, {
      method: 'POST',
      headers: authHeaders
    });
    assert.strictEqual(checkout.status, 200);
    assert.strictEqual((await checkout.json()).url, 'https://checkout.paystack.com/mock-checkout');

    const checkoutRequest = paystackRequests[0];
    const checkoutBody = JSON.parse(checkoutRequest.options.body);
    assert.strictEqual(checkoutBody.email, email);
    assert.strictEqual(checkoutBody.plan, process.env.PAYSTACK_PLAN_CODE);
    assert.strictEqual(checkoutBody.metadata.workspace_id, workspace.id);
    assert.strictEqual(checkoutRequest.options.headers.Authorization, `Bearer ${process.env.PAYSTACK_SECRET_KEY}`);

    db.run('UPDATE workspaces SET stripe_subscription_id = ? WHERE id = ?', ['SUB_mock', workspace.id]);
    const portal = await originalFetch(`${baseUrl}/api/workspaces/${workspace.id}/billing/portal`, {
      method: 'POST',
      headers: authHeaders
    });
    assert.strictEqual(portal.status, 200);
    assert.strictEqual((await portal.json()).url, 'https://paystack.com/manage/subscriptions/mock');
    assert.ok(paystackRequests.some(request => request.url.endsWith('/subscription/SUB_mock/manage/link')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('10c. Direct Twitch OAuth connects with encrypted credentials and discovered targets', async () => {
  const email = `twitch_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'TwitchWorkspace' })
  });
  assert.strictEqual(reg.status, 201);
  const { workspace } = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const authHeaders = {
    'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
    'X-CSRF-Token': cookies._csrf
  };

  const oldEnvironment = {
    id: process.env.TWITCH_CLIENT_ID,
    secret: process.env.TWITCH_CLIENT_SECRET,
    redirect: process.env.TWITCH_REDIRECT_URI
  };
  process.env.TWITCH_CLIENT_ID = 'twitch_test_client';
  process.env.TWITCH_CLIENT_SECRET = 'twitch_test_secret';
  process.env.TWITCH_REDIRECT_URI = `${baseUrl}/api/providers/twitch/callback`;

  const originalExchange = providerOAuthClient.exchangeCode;
  const originalFetchTargets = providerOAuthClient.fetchTargets;
  providerOAuthClient.exchangeCode = async (provider, code, verifier) => {
    assert.strictEqual(provider, 'twitch');
    assert.strictEqual(code, 'mock_twitch_code');
    assert.ok(verifier);
    return { access_token: 'private_twitch_access_token', refresh_token: 'private_twitch_refresh_token', expires_in: 3600 };
  };
  providerOAuthClient.fetchTargets = async (provider, accessToken) => {
    assert.strictEqual(provider, 'twitch');
    assert.strictEqual(accessToken, 'private_twitch_access_token');
    return [{ id: 'channel_123', name: 'Emberstage Test Channel' }];
  };

  try {
    const connect = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/providers/twitch/connect`, {
      method: 'POST',
      headers: authHeaders
    });
    assert.strictEqual(connect.status, 200);
    const authorizationUrl = new URL((await connect.json()).authorizationUrl);
    assert.strictEqual(authorizationUrl.origin, 'https://id.twitch.tv');
    assert.strictEqual(authorizationUrl.searchParams.get('client_id'), 'twitch_test_client');
    assert.strictEqual(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    const state = authorizationUrl.searchParams.get('state');
    assert.ok(state);

    const callback = await fetch(`${baseUrl}/api/providers/twitch/callback?code=mock_twitch_code&state=${encodeURIComponent(state)}`);
    assert.strictEqual(callback.status, 200);
    assert.match(await callback.text(), /Twitch Linked Successfully/);

    const connection = queryOne('SELECT * FROM provider_connections WHERE workspace_id = ? AND provider = ?', [workspace.id, 'twitch']);
    assert.ok(connection);
    assert.strictEqual(connection.status, 'connected');
    assert.doesNotMatch(connection.encrypted_tokens, /private_twitch/);
    const decrypted = JSON.parse(cryptoUtils.decrypt(connection.encrypted_tokens, process.env.ENCRYPTION_SECRET));
    assert.strictEqual(decrypted.access_token, 'private_twitch_access_token');
    assert.strictEqual(decrypted.refresh_token, 'private_twitch_refresh_token');

    const target = queryOne('SELECT * FROM provider_targets WHERE provider_connection_id = ?', [connection.id]);
    assert.strictEqual(target.external_id, 'channel_123');
    assert.strictEqual(target.name, 'Emberstage Test Channel');
    assert.strictEqual(queryOne('SELECT 1 AS present FROM oauth_states WHERE state = ?', [state]), undefined);
  } finally {
    providerOAuthClient.exchangeCode = originalExchange;
    providerOAuthClient.fetchTargets = originalFetchTargets;
    if (oldEnvironment.id === undefined) delete process.env.TWITCH_CLIENT_ID; else process.env.TWITCH_CLIENT_ID = oldEnvironment.id;
    if (oldEnvironment.secret === undefined) delete process.env.TWITCH_CLIENT_SECRET; else process.env.TWITCH_CLIENT_SECRET = oldEnvironment.secret;
    if (oldEnvironment.redirect === undefined) delete process.env.TWITCH_REDIRECT_URI; else process.env.TWITCH_REDIRECT_URI = oldEnvironment.redirect;
  }
});

test('11. Security and Edge Cases (Subscription Denial, Cross-provider State Rejection, Webhook Replay, No Plaintext Tokens, Persistence Config)', async () => {
  // 1. Subscription denial
  const email = `sec_test_${Math.random()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', workspaceName: 'SecurityWorkspace' })
  });
  const body = await reg.json();
  const cookies = parseSetCookies(reg.headers);
  const workspaceId = body.workspace.id;

  // New workspace stripe_status is 'none'. Preflight should fail with 402
  const preflightRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/streams/preflight`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ destinations: [] })
  });
  assert.strictEqual(preflightRes.status, 402, 'Preflight without active subscription must return 402 Payment Required');

  // 2. Cross-provider callback state rejection
  // Create an OAuth state for YouTube
  const stateToken = 'state_sec_test';
  db.run(
    'INSERT INTO oauth_states (state, workspace_id, provider, pkce_verifier, expires_at) VALUES (?, ?, ?, ?, ?)',
    [stateToken, workspaceId, 'youtube', 'verifier_sec', new Date(Date.now() + 60000).toISOString()]
  );

  // Send callback to Twitch route but with state bound to YouTube -> Must fail with 400
  const crossProviderRes = await fetch(`${baseUrl}/api/providers/twitch/callback?state=${stateToken}&code=auth_code`);
  assert.strictEqual(crossProviderRes.status, 400);
  const crossBody = await crossProviderRes.text();
  assert.match(crossBody, /Provider state mismatch/);

  // 3. Webhook replay
  // Prepare a webhook payload
  const webhookEvent = {
    event: 'charge.success',
    data: {
      id: 789,
      reference: 'replay_test_123',
      customer: { customer_code: 'CUS_replay' },
      status: 'success',
      plan: { plan_code: process.env.PAYSTACK_PLAN_CODE },
      metadata: { workspace_id: workspaceId }
    }
  };

  // First post -> Should succeed
  const webhookRes1 = await postPaystackWebhook(webhookEvent);
  assert.strictEqual(webhookRes1.status, 200);

  // Second post with same event ID -> Should ack with duplicate message without re-applying state changes
  const webhookRes2 = await postPaystackWebhook(webhookEvent);
  assert.strictEqual(webhookRes2.status, 200);
  const webhookBody2 = await webhookRes2.json();
  assert.strictEqual(webhookBody2.duplicate, true);

  // 4. No plaintext access token
  // Generate a link code
  const codeRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices/link-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ name: 'SecurityDevice' })
  });
  const codeBody = await codeRes.json();
  const linkCode = codeBody.linkCode;

  // Pair device
  const pairRes = await fetch(`${baseUrl}/api/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_code: linkCode })
  });
  const pairBody = await pairRes.json();
  const accessToken = pairBody.accessToken;

  // Query DB directly to verify access token is not stored as plaintext (id column must be the SHA-256 hash of accessToken)
  const sessionRecord = queryOne('SELECT * FROM device_sessions WHERE device_id = ?', [pairBody.deviceId]);
  assert.notStrictEqual(sessionRecord.id, accessToken, 'Device access token must never be stored plaintext at rest');
  const expectedHash = crypto.createHash('sha256').update(accessToken).digest('hex');
  assert.strictEqual(sessionRecord.id, expectedHash, 'Device session ID should be the SHA-256 hash of the access token');

  // 5. Restart persistence config
  // The database configuration uses default filename 'navecue.db' when DATABASE_URL is not set
  assert.strictEqual(config.DATABASE_URL, ':memory:', 'In test environments, config.DATABASE_URL should resolve to :memory: correctly');

  // 6. Device bearer token restricted to device-only routes
  // Try to access web-only route GET /api/workspaces/:workspaceId/devices using device access token in Authorization header
  const authHeaderRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/devices`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  assert.strictEqual(authHeaderRes.status, 403, 'Device access token must be rejected on web-only endpoints');

  // Device-allowed route should succeed with the bearer token
  const bootstrapRes = await fetch(`${baseUrl}/api/device/bootstrap`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  assert.strictEqual(bootstrapRes.status, 200, 'Device access token must be accepted on device endpoints');
  const bootstrapBody = await bootstrapRes.json();
  assert.strictEqual(bootstrapBody.workspace.id, workspaceId, 'Bootstrap must return the workspace shape consumed by the streaming dock');
  assert.strictEqual(bootstrapBody.device.id, pairBody.deviceId, 'Bootstrap must return the paired device shape consumed by the streaming dock');

  // 7. A successful charge for an unrelated plan does not activate Pro, but the configured subscription does
  const checkoutRes = await postPaystackWebhook({
    event: 'charge.success',
    data: {
      id: 900,
      reference: 'checkout_test_1',
      customer: { customer_code: 'CUS_checkout_test' },
      status: 'success',
      plan: { plan_code: 'PLN_unrelated' },
      metadata: { workspace_id: workspaceId }
    }
  });
  assert.strictEqual(checkoutRes.status, 200);

  // Customer is linked, but an unrelated plan must not upgrade the workspace.
  const workspaceAfterCheckout = queryOne('SELECT stripe_status, stripe_customer_id FROM workspaces WHERE id = ?', [workspaceId]);
  assert.strictEqual(workspaceAfterCheckout.stripe_customer_id, 'CUS_checkout_test');
  assert.notStrictEqual(workspaceAfterCheckout.stripe_status, 'active');

  // The configured Paystack subscription upgrades limits and status.
  const subCreatedRes = await postPaystackWebhook({
    event: 'subscription.create',
    data: {
      id: 901,
      subscription_code: 'SUB_checkout_test',
      customer: { customer_code: 'CUS_checkout_test' },
      status: 'active',
      plan: { plan_code: process.env.PAYSTACK_PLAN_CODE },
      metadata: { workspace_id: workspaceId }
    }
  });
  assert.strictEqual(subCreatedRes.status, 200);

  const workspaceAfterSubCreated = queryOne('SELECT stripe_status, max_devices FROM workspaces WHERE id = ?', [workspaceId]);
  assert.strictEqual(workspaceAfterSubCreated.stripe_status, 'active', 'Subscription should now be active');
  assert.strictEqual(workspaceAfterSubCreated.max_devices, 3, 'Plan should be upgraded to Pro limits');

  // 8. Block provider OAuth when ENCRYPTION_SECRET is default/unset
  // Temporarily set default secret in config and process.env
  const originalSecret = process.env.ENCRYPTION_SECRET;
  const originalEnv = process.env.NODE_ENV;
  delete process.env.ENCRYPTION_SECRET;
  process.env.NODE_ENV = 'production';
  
  // Try to connect Twitch OAuth -> Must fail with 503
  const connectFailRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/providers/twitch/connect`, {
    method: 'POST',
    headers: {
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    }
  });
  assert.strictEqual(connectFailRes.status, 503, 'Should reject provider connect when using default secret in production/dev');
  
  // Restore original
  process.env.ENCRYPTION_SECRET = originalSecret;
  process.env.NODE_ENV = originalEnv;

  // 9. Target List, Selection, and Deselection
  // Verify twitch targets exist (created via previous tests or insert one directly)
  const targetId = 'pt_twitch_test';
  db.run(`INSERT INTO provider_connections (id, workspace_id, provider, encrypted_tokens, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`, ['pc_dummy', workspaceId, 'twitch', 'encrypted_tokens_mock', 'connected', new Date().toISOString()]);
  db.run(`INSERT INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?)`, [targetId, workspaceId, 'pc_dummy', 'twitch', 'ext_twitch', 'Twitch Channel', new Date().toISOString()]);

  // Try to preflight stream with this target ID (it's NOT selected yet) -> Must return 400
  const preflightUnselectedRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/streams/preflight`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ destinations: [targetId] })
  });
  assert.strictEqual(preflightUnselectedRes.status, 400, 'Preflight with unselected target should return 400');
  const preflightUnselectedBody = await preflightUnselectedRes.json();
  assert.match(preflightUnselectedBody.error, /not available yet/);

  // Expose target list GET route -> Verify we can retrieve it
  const targetsRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/providers/targets`, {
    headers: {
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    }
  });
  assert.strictEqual(targetsRes.status, 200);
  const targetsList = await targetsRes.json();
  assert.ok(targetsList.length > 0);

  // Select target POST route -> Should succeed
  const selectRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/providers/targets/${targetId}/select`, {
    method: 'POST',
    headers: {
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    }
  });
  assert.strictEqual(selectRes.status, 200);

  assert.strictEqual(queryOne('SELECT selected FROM provider_targets WHERE id = ?', [targetId]).selected, 1);

  // Provider OAuth exists, but managed provider relay provisioning is intentionally not advertised yet.
  const preflightSelectedRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/streams/preflight`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ destinations: [targetId] })
  });
  assert.strictEqual(preflightSelectedRes.status, 400);
  assert.match((await preflightSelectedRes.json()).error, /not available yet/);

  // Deselect target POST route -> Should succeed
  const deselectRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/providers/targets/${targetId}/deselect`, {
    method: 'POST',
    headers: {
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    }
  });
  assert.strictEqual(deselectRes.status, 200);
  assert.strictEqual(queryOne('SELECT selected FROM provider_targets WHERE id = ?', [targetId]).selected, 0);

  // Verifying it is deselected again
  const preflightDeselectedRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/streams/preflight`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${cookies.session_id}; _csrf=${cookies._csrf}`,
      'X-CSRF-Token': cookies._csrf
    },
    body: JSON.stringify({ destinations: [targetId] })
  });
  assert.strictEqual(preflightDeselectedRes.status, 400, 'Deselected target should fail preflight again');
});

test('12. Same-Origin Account Portal and Static Routes', async () => {
  // Test /app HTML retrieval
  const appHtmlRes = await fetch(`${baseUrl}/app`);
  assert.strictEqual(appHtmlRes.status, 200, '/app should return 200');
  assert.match(appHtmlRes.headers.get('content-type') || '', /text\/html/);
  const appHtmlBody = await appHtmlRes.text();
  assert.match(appHtmlBody, /<title>Emberstage Portal<\/title>/);

  // Test /app/app.js retrieval
  const appJsRes = await fetch(`${baseUrl}/app/app.js`);
  assert.strictEqual(appJsRes.status, 200, '/app/app.js should return 200');
  assert.match(appJsRes.headers.get('content-type') || '', /javascript/);

  // Test /app/app.css retrieval
  const appCssRes = await fetch(`${baseUrl}/app/app.css`);
  assert.strictEqual(appCssRes.status, 200, '/app/app.css should return 200');
  assert.match(appCssRes.headers.get('content-type') || '', /text\/css/);

  // Test 404 for arbitrary/invalid paths
  const invalidRes = await fetch(`${baseUrl}/app/nonexistent_file.json`);
  assert.strictEqual(invalidRes.status, 404, 'Arbitrary path should return 404');

  // Verify unauthenticated portal API boundaries
  const unauthorizedApiRes = await fetch(`${baseUrl}/api/workspaces`);
  assert.strictEqual(unauthorizedApiRes.status, 401, 'Unauthenticated workspace list should return 401');
});

test('12b. Streaming dock keeps pairing safe and never exposes persistent OBS credentials', async () => {
  const dockPath = new URL('../../streaming_dock.html', import.meta.url);
  const dockHtml = await readFile(dockPath, 'utf8');

  assert.match(dockHtml, /Pair <span>Emberstage<\/span> once/);
  assert.match(dockHtml, /link code/i);
  assert.match(dockHtml, /Open portal/);
  assert.match(dockHtml, /target="_blank" rel="noopener"/);
  assert.match(dockHtml, /Configure OBS once/);
  assert.match(dockHtml, /streams\/setup/);
  assert.doesNotMatch(dockHtml, /streams\/start/);
  assert.doesNotMatch(dockHtml, /Prepare Stream/);
  assert.doesNotMatch(dockHtml, /id="ingest-key"/);
  assert.doesNotMatch(dockHtml, /id="ingest-server"/);
  assert.doesNotMatch(dockHtml, /Control-Plane Base URL/);
  assert.doesNotMatch(dockHtml, /Device Access Token/);
  assert.doesNotMatch(dockHtml, /Device Refresh Token/);
  assert.doesNotMatch(dockHtml, /Restream-style/i);
});

test('13. Google OpenID Connect (OIDC) Authentication, Registration, and Host Binding Policies', async () => {
  // Set mock Google environment configurations
  process.env.GOOGLE_CLIENT_ID = 'google_mock_client_id';
  process.env.GOOGLE_CLIENT_SECRET = 'google_mock_client_secret';
  process.env.GOOGLE_REDIRECT_URI = `${baseUrl}/api/auth/google/callback`;

  // 1. GET /api/auth/config should return Google active configuration
  const configRes = await fetch(`${baseUrl}/api/auth/config`);
  assert.strictEqual(configRes.status, 200);
  const configBody = await configRes.json();
  assert.strictEqual(configBody.google.enabled, true);
  assert.strictEqual(configBody.google.client_id, 'google_mock_client_id');

  // Generate dynamic RSA key pair for cryptographic token signing and verification
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' });

  // Mock googleOidcClient network calls to execute entirely locally
  googleOidcClient.fetchJwks = async () => ({
    keys: [
      {
        kid: 'mock-kid-123',
        kty: 'RSA',
        n: jwk.n,
        e: jwk.e
      }
    ]
  });

  let currentMockEmail = 'newgoogleuser@example.com';
  let currentMockSub = 'google_sub_123';
  let currentMockNonce = '';
  let currentMockAlg = 'RS256';

  googleOidcClient.exchangeCode = async (code, verifier) => {
    const payload = {
      iss: 'https://accounts.google.com',
      aud: 'google_mock_client_id',
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: currentMockSub,
      email: currentMockEmail,
      email_verified: true,
      nonce: currentMockNonce
    };

    const header = { alg: currentMockAlg, kid: 'mock-kid-123', typ: 'JWT' };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${headerB64}.${payloadB64}`);
    const signature = signer.sign(privateKey, 'base64url');

    return {
      id_token: `${headerB64}.${payloadB64}.${signature}`
    };
  };

  // 2. Start OIDC Authentication Flow
  const startRes = await fetch(`${baseUrl}/api/auth/google/start`, { redirect: 'manual' });
  assert.strictEqual(startRes.status, 302, 'Should return redirect to Google');
  const redirectUrlStr = startRes.headers.get('location');
  assert.ok(redirectUrlStr.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));

  const redirectUrl = new URL(redirectUrlStr);
  const stateVal = redirectUrl.searchParams.get('state');
  const nonceVal = redirectUrl.searchParams.get('nonce');
  assert.ok(stateVal);
  assert.ok(nonceVal);

  currentMockNonce = nonceVal;

  // Verify DB recorded state correctly
  const stateRecord = queryOne('SELECT * FROM google_auth_states WHERE state = ?', [stateVal]);
  assert.ok(stateRecord);
  assert.strictEqual(stateRecord.nonce, nonceVal);
  assert.strictEqual(stateRecord.user_id, null, 'Unauthenticated start should have null user_id');

  // 3. Callback - Successful Auto-provisioning of new user & workspace
  const callbackRes = await fetch(`${baseUrl}/api/auth/google/callback?code=mock_code&state=${stateVal}`, { redirect: 'manual' });
  assert.strictEqual(callbackRes.status, 302, 'Successful login should redirect to /app');
  assert.strictEqual(callbackRes.headers.get('location'), '/app');

  // Verify user and workspace tables
  const userRow = queryOne('SELECT * FROM users WHERE email = ?', ['newgoogleuser@example.com']);
  assert.ok(userRow);
  const identityRow = queryOne('SELECT * FROM google_identities WHERE google_sub = ?', ['google_sub_123']);
  assert.ok(identityRow);
  assert.strictEqual(identityRow.user_id, userRow.id);

  const workspaceRow = queryOne('SELECT w.* FROM workspaces w INNER JOIN memberships m ON w.id = m.workspace_id WHERE m.user_id = ?', [userRow.id]);
  assert.ok(workspaceRow);
  assert.match(workspaceRow.name, /newgoogleuser's Workspace/);

  // 4. Callback - Prevent auto-linking existing email accounts
  // First, create a standard email/password user who does not have google linked
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'passworduser@example.com',
      password: 'SecurePassword123',
      workspaceName: 'Password Workspace'
    })
  });
  assert.strictEqual(regRes.status, 201);

  // Trigger Google Start to get a fresh state/nonce
  const startRes2 = await fetch(`${baseUrl}/api/auth/google/start`, { redirect: 'manual' });
  const stateVal2 = new URL(startRes2.headers.get('location')).searchParams.get('state');
  const nonceVal2 = new URL(startRes2.headers.get('location')).searchParams.get('nonce');

  // Mock callback payload with the existing email 'passworduser@example.com'
  currentMockEmail = 'passworduser@example.com';
  currentMockSub = 'google_sub_password_user';
  currentMockNonce = nonceVal2;

  const callbackRes2 = await fetch(`${baseUrl}/api/auth/google/callback?code=mock_code&state=${stateVal2}`, { redirect: 'manual' });
  assert.strictEqual(callbackRes2.status, 302);
  const errorRedirect = callbackRes2.headers.get('location');
  assert.match(errorRedirect, /error=An(\+| )account(\+| )with(\+| )this(\+| )email(\+| )already(\+| )exists/);

  // 5. Explicit, authenticated linking of Google Account
  // Log in passworduser@example.com
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'passworduser@example.com', password: 'SecurePassword123' })
  });
  assert.strictEqual(loginRes.status, 200);
  const loginCookies = parseSetCookies(loginRes.headers);

  // Trigger Google start with POST to link/start
  const linkStartRes = await fetch(`${baseUrl}/api/auth/google/link/start`, {
    method: 'POST',
    headers: {
      'Cookie': `session_id=${loginCookies.session_id}; _csrf=${loginCookies._csrf}`,
      'X-CSRF-Token': loginCookies._csrf
    }
  });
  assert.strictEqual(linkStartRes.status, 200);
  const linkStartBody = await linkStartRes.json();
  assert.ok(linkStartBody.url);

  const stateVal3 = new URL(linkStartBody.url).searchParams.get('state');
  const nonceVal3 = new URL(linkStartBody.url).searchParams.get('nonce');
  
  // Verify state row recorded current user_id for explicit link
  const stateRecord3 = queryOne('SELECT * FROM google_auth_states WHERE state = ?', [stateVal3]);
  const passwordUserRow = queryOne('SELECT id FROM users WHERE email = ?', ['passworduser@example.com']);
  assert.strictEqual(stateRecord3.user_id, passwordUserRow.id);
  
  currentMockEmail = 'passworduser@example.com';
  currentMockSub = 'google_sub_password_user';
  currentMockNonce = nonceVal3;
  
  // Complete OIDC linking callback
  const callbackRes3 = await fetch(`${baseUrl}/api/auth/google/callback?code=mock_code&state=${stateVal3}`, {
    headers: { 'Cookie': `session_id=${loginCookies.session_id}` },
    redirect: 'manual'
  });
  assert.strictEqual(callbackRes3.status, 302);
  assert.match(callbackRes3.headers.get('location'), /success=Google(\+| )account(\+| )successfully(\+| )linked/);
  
  // Verify Google Identity successfully mapped
  const verifiedLink = queryOne('SELECT * FROM google_identities WHERE user_id = ?', [passwordUserRow.id]);
  assert.ok(verifiedLink);
  assert.strictEqual(verifiedLink.google_sub, 'google_sub_password_user');
  
  // 6. POST /api/auth/google/unlink
  const unlinkRes = await fetch(`${baseUrl}/api/auth/google/unlink`, {
    method: 'POST',
    headers: {
      'Cookie': `session_id=${loginCookies.session_id}; _csrf=${loginCookies._csrf}`,
      'X-CSRF-Token': loginCookies._csrf
    }
  });
  assert.strictEqual(unlinkRes.status, 200);
  const unlinkBody = await unlinkRes.json();
  assert.strictEqual(unlinkBody.success, true);
  
  // Verify deleted from db
  const deletedLink = queryOne('SELECT * FROM google_identities WHERE user_id = ?', [passwordUserRow.id]);
  assert.ok(!deletedLink);
  
  // --- ADDITIONAL REGRESSION TESTS ---
  
  // Regression 1: GET /api/auth/google/start must never link/associate an active session
  const startWithSessionRes = await fetch(`${baseUrl}/api/auth/google/start`, {
    headers: { 'Cookie': `session_id=${loginCookies.session_id}` },
    redirect: 'manual'
  });
  assert.strictEqual(startWithSessionRes.status, 302);
  const startWithSessionState = new URL(startWithSessionRes.headers.get('location')).searchParams.get('state');
  const startWithSessionStateRecord = queryOne('SELECT * FROM google_auth_states WHERE state = ?', [startWithSessionState]);
  assert.strictEqual(startWithSessionStateRecord.user_id, null, 'GET start must never associate active session for linking');
  
  // Regression 2: missing secret config
  const backupSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  
  const configRes2 = await fetch(`${baseUrl}/api/auth/config`);
  const configBody2 = await configRes2.json();
  assert.strictEqual(configBody2.google.enabled, false, 'Missing GOOGLE_CLIENT_SECRET must disable Google login');
  
  const startResWithMissingSecret = await fetch(`${baseUrl}/api/auth/google/start`);
  assert.strictEqual(startResWithMissingSecret.status, 503, 'Missing secret should return 503');
  
  process.env.GOOGLE_CLIENT_SECRET = backupSecret; // restore
  
  // Regression 3: HTML/error leakage (Generic Error Message)
  const callbackWithInvalidState = await fetch(`${baseUrl}/api/auth/google/callback?code=mock_code&state=nonexistent_state`);
  assert.strictEqual(callbackWithInvalidState.status, 400);
  const errorHtml = await callbackWithInvalidState.text();
  assert.ok(!errorHtml.includes('nonexistent_state'), 'Error message must not leak input parameters');
  
  // Regression 4: alg rejection
  // Generate a mock state & exchange code
  const testStateRes = await fetch(`${baseUrl}/api/auth/google/start`, { redirect: 'manual' });
  const testStateVal = new URL(testStateRes.headers.get('location')).searchParams.get('state');
  const testNonceVal = new URL(testStateRes.headers.get('location')).searchParams.get('nonce');
  
  currentMockEmail = 'alg_test@example.com';
  currentMockSub = 'google_sub_alg_test';
  currentMockNonce = testNonceVal;
  currentMockAlg = 'HS256';
  
  const callbackResHS256 = await fetch(`${baseUrl}/api/auth/google/callback?code=mock_code&state=${testStateVal}`);
  assert.strictEqual(callbackResHS256.status, 400);
  const hs256Text = await callbackResHS256.text();
  assert.ok(hs256Text.includes('Invalid algorithm used in token signature'));
  
  currentMockAlg = 'RS256'; // restore
  
  // Regression 5: malformed identity claims
  // Empty sub claim
  const testStateResClaims = await fetch(`${baseUrl}/api/auth/google/start`, { redirect: 'manual' });
  const testStateValClaims = new URL(testStateResClaims.headers.get('location')).searchParams.get('state');
  const testNonceValClaims = new URL(testStateResClaims.headers.get('location')).searchParams.get('nonce');
  
  currentMockEmail = 'claims_test@example.com';
  currentMockSub = ''; // empty sub
  currentMockNonce = testNonceValClaims;
  
  const callbackResEmptySub = await fetch(`${baseUrl}/api/auth/google/callback?code=mock_code&state=${testStateValClaims}`);
  assert.strictEqual(callbackResEmptySub.status, 400);
  
  currentMockSub = 'valid_sub'; // restore
  
  // Regression 6: unlink lockout for Google-only users
  // Create a user via Google login (no password, has_password = 0)
  const testStateResLockout = await fetch(`${baseUrl}/api/auth/google/start`, { redirect: 'manual' });
  const testStateValLockout = new URL(testStateResLockout.headers.get('location')).searchParams.get('state');
  const testNonceValLockout = new URL(testStateResLockout.headers.get('location')).searchParams.get('nonce');
  
  currentMockEmail = 'googleonlyuser@example.com';
  currentMockSub = 'google_sub_lockout_test';
  currentMockNonce = testNonceValLockout;
  
  const callbackResLockout = await fetch(`${baseUrl}/api/auth/google/callback?code=mock_code&state=${testStateValLockout}`, { redirect: 'manual' });
  assert.strictEqual(callbackResLockout.status, 302);
  const lockoutCookies = parseSetCookies(callbackResLockout.headers);
  
  // Attempt to unlink sole login method (must return 400 bad request)
  const unlinkLockoutRes = await fetch(`${baseUrl}/api/auth/google/unlink`, {
    method: 'POST',
    headers: {
      'Cookie': `session_id=${lockoutCookies.session_id}; _csrf=${lockoutCookies._csrf}`,
      'X-CSRF-Token': lockoutCookies._csrf
    }
  });
  assert.strictEqual(unlinkLockoutRes.status, 400);
  const unlinkLockoutBody = await unlinkLockoutRes.json();
  assert.strictEqual(unlinkLockoutBody.error, 'Cannot unlink your sole login method. Please set a password first.');

  // 7. Host Binding and Deployment Rules Config Validation
  // Outside production environment, HOST is always loopback '127.0.0.1'
  process.env.NODE_ENV = 'development';
  process.env.APP_BASE_URL = 'https://hosted-emberstage.com';
  process.env.ENCRYPTION_SECRET = 'secure-non-default-master-secret-value-1234567890';
  assert.strictEqual(config.HOST, '127.0.0.1', 'Dev environment should strictly bind to loopback 127.0.0.1');

  process.env.NODE_ENV = 'production';
  // With defaults, it should fallback to 127.0.0.1
  process.env.ENCRYPTION_SECRET = 'default-super-secret-emberstage-encryption-key-for-mvp-setup';
  assert.strictEqual(config.HOST, '127.0.0.1', 'Default encryption secret should force bind 127.0.0.1');

  // Under genuine HTTPS production and real master secrets, it can open interfaces
  process.env.ENCRYPTION_SECRET = 'secure-non-default-master-secret-value-1234567890';
  assert.strictEqual(config.HOST, '0.0.0.0', 'Production with HTTPS and safe secrets allows binding non-loopback');

  // Reset environmental configurations to default safe state
  process.env.NODE_ENV = 'test';
  process.env.APP_BASE_URL = '';
  process.env.ENCRYPTION_SECRET = 'test-secret-key-must-be-long-and-secure-32-bytes!';
});

test('13b. Auth0 OpenID Connect (OIDC) Authentication, Registration, and Refusal Policies', async () => {
  // Set mock Auth0 environment configurations
  process.env.AUTH0_DOMAIN = 'auth0-test-domain.us.auth0.com';
  process.env.AUTH0_CLIENT_ID = 'auth0_mock_client_id';
  process.env.AUTH0_CLIENT_SECRET = 'auth0_mock_client_secret';
  process.env.AUTH0_REDIRECT_URI = `${baseUrl}/api/auth/auth0/callback`;

  // 1. GET /api/auth/config should return Auth0 active configuration and Google disabled
  const configRes = await fetch(`${baseUrl}/api/auth/config`);
  assert.strictEqual(configRes.status, 200);
  const configBody = await configRes.json();
  assert.strictEqual(configBody.auth0.enabled, true);
  assert.strictEqual(configBody.google.enabled, true);

  // Generate dynamic RSA key pair for cryptographic token signing and verification
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' });

  // Mock auth0OidcClient network calls to execute entirely locally
  auth0OidcClient.fetchJwks = async (domain) => {
    assert.strictEqual(domain, 'auth0-test-domain.us.auth0.com');
    return {
      keys: [
        {
          kid: 'mock-auth0-kid-123',
          kty: 'RSA',
          n: jwk.n,
          e: jwk.e
        }
      ]
    };
  };

  let currentMockEmail = 'newauth0user@example.com';
  let currentMockSub = 'auth0|1234567890';
  let currentMockNonce = '';
  let currentMockAlg = 'RS256';
  let currentMockIss = 'https://auth0-test-domain.us.auth0.com/';
  let currentMockAud = 'auth0_mock_client_id';
  let currentMockExpOffset = 3600;
  let currentMockEmailVerified = true;

  auth0OidcClient.exchangeCode = async (domain, code, verifier) => {
    assert.strictEqual(domain, 'auth0-test-domain.us.auth0.com');
    const payload = {
      iss: currentMockIss,
      aud: currentMockAud,
      exp: Math.floor(Date.now() / 1000) + currentMockExpOffset,
      sub: currentMockSub,
      email: currentMockEmail,
      email_verified: currentMockEmailVerified,
      nonce: currentMockNonce
    };

    const header = { alg: currentMockAlg, kid: 'mock-auth0-kid-123', typ: 'JWT' };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${headerB64}.${payloadB64}`);
    const signature = signer.sign(privateKey, 'base64url');

    return {
      id_token: `${headerB64}.${payloadB64}.${signature}`
    };
  };

  // 2. Start OIDC Authentication Flow
  const startRes = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  assert.strictEqual(startRes.status, 302, 'Should return redirect to Auth0');
  const redirectUrlStr = startRes.headers.get('location');
  assert.ok(redirectUrlStr.startsWith('https://auth0-test-domain.us.auth0.com/authorize'));

  const redirectUrl = new URL(redirectUrlStr);
  const stateVal = redirectUrl.searchParams.get('state');
  const nonceVal = redirectUrl.searchParams.get('nonce');
  assert.ok(stateVal);
  assert.ok(nonceVal);

  currentMockNonce = nonceVal;

  // Verify DB recorded state correctly
  const stateRecord = queryOne('SELECT * FROM auth0_auth_states WHERE state = ?', [stateVal]);
  assert.ok(stateRecord);
  assert.strictEqual(stateRecord.nonce, nonceVal);

  // 3. Callback - Successful Auto-provisioning of new user & workspace
  const callbackRes = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateVal}`, { redirect: 'manual' });
  assert.strictEqual(callbackRes.status, 302, 'Successful login should redirect to /app');
  assert.strictEqual(callbackRes.headers.get('location'), '/app');

  // Verify user and workspace tables
  const userRow = queryOne('SELECT * FROM users WHERE email = ?', ['newauth0user@example.com']);
  assert.ok(userRow);
  const identityRow = queryOne('SELECT * FROM auth0_identities WHERE auth0_sub = ?', ['auth0|1234567890']);
  assert.ok(identityRow);
  assert.strictEqual(identityRow.user_id, userRow.id);

  const workspaceRow = queryOne('SELECT w.* FROM workspaces w INNER JOIN memberships m ON w.id = m.workspace_id WHERE m.user_id = ?', [userRow.id]);
  assert.ok(workspaceRow);
  assert.match(workspaceRow.name, /newauth0user's Workspace/);

  // 4. Callback - Prevent auto-linking existing email accounts (Email Collision Refusal)
  // Register a new password user first
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'existingauth0email@example.com',
      password: 'SecurePassword123',
      workspaceName: 'Exist Workspace'
    })
  });
  assert.strictEqual(regRes.status, 201);

  // Trigger Auth0 Start to get a fresh state/nonce
  const startRes2 = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  const stateVal2 = new URL(startRes2.headers.get('location')).searchParams.get('state');
  const nonceVal2 = new URL(startRes2.headers.get('location')).searchParams.get('nonce');

  // Mock callback payload with the existing email 'existingauth0email@example.com'
  currentMockEmail = 'existingauth0email@example.com';
  currentMockSub = 'auth0|different_sub';
  currentMockNonce = nonceVal2;

  const callbackRes2 = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateVal2}`, { redirect: 'manual' });
  assert.strictEqual(callbackRes2.status, 302);
  const errorRedirect = callbackRes2.headers.get('location');
  assert.match(errorRedirect, /error=An(\+| )account(\+| )with(\+| )this(\+| )email(\+| )already(\+| )exists/);

  // 5. Existing Auth0 subject signs in
  // Trigger Auth0 Start to get a fresh state/nonce
  const startRes3 = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  const stateVal3 = new URL(startRes3.headers.get('location')).searchParams.get('state');
  const nonceVal3 = new URL(startRes3.headers.get('location')).searchParams.get('nonce');

  // Sign in existing user (newauth0user@example.com, sub auth0|1234567890)
  currentMockEmail = 'newauth0user@example.com';
  currentMockSub = 'auth0|1234567890';
  currentMockNonce = nonceVal3;

  const callbackRes3 = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateVal3}`, { redirect: 'manual' });
  assert.strictEqual(callbackRes3.status, 302);
  assert.strictEqual(callbackRes3.headers.get('location'), '/app');

  // 6. Test invalid issuer rejection
  const startResIssuer = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  const stateValIssuer = new URL(startResIssuer.headers.get('location')).searchParams.get('state');
  const nonceValIssuer = new URL(startResIssuer.headers.get('location')).searchParams.get('nonce');

  currentMockNonce = nonceValIssuer;
  currentMockIss = 'https://wrong-domain.com/'; // wrong issuer

  const callbackResIssuer = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateValIssuer}`);
  assert.strictEqual(callbackResIssuer.status, 400);
  const issuerErrHtml = await callbackResIssuer.text();
  assert.ok(issuerErrHtml.includes('Authentication Error'));
  currentMockIss = 'https://auth0-test-domain.us.auth0.com/'; // restore

  // 7. Test invalid algorithm rejection
  const startResAlg = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  const stateValAlg = new URL(startResAlg.headers.get('location')).searchParams.get('state');
  const nonceValAlg = new URL(startResAlg.headers.get('location')).searchParams.get('nonce');

  currentMockNonce = nonceValAlg;
  currentMockAlg = 'HS256';

  const callbackResAlg = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateValAlg}`);
  assert.strictEqual(callbackResAlg.status, 400);
  const algErrHtml = await callbackResAlg.text();
  assert.ok(algErrHtml.includes('Authentication Error'));
  currentMockAlg = 'RS256'; // restore

  // 8. Test invalid audience rejection
  const startResAud = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  const stateValAud = new URL(startResAud.headers.get('location')).searchParams.get('state');
  const nonceValAud = new URL(startResAud.headers.get('location')).searchParams.get('nonce');

  currentMockNonce = nonceValAud;
  currentMockAud = 'wrong_audience';

  const callbackResAud = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateValAud}`);
  assert.strictEqual(callbackResAud.status, 400);
  const audErrHtml = await callbackResAud.text();
  assert.ok(audErrHtml.includes('Authentication Error'));
  currentMockAud = 'auth0_mock_client_id'; // restore

  // 9. Test expired token rejection
  const startResExp = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  const stateValExp = new URL(startResExp.headers.get('location')).searchParams.get('state');
  const nonceValExp = new URL(startResExp.headers.get('location')).searchParams.get('nonce');

  currentMockNonce = nonceValExp;
  currentMockExpOffset = -3600; // expired an hour ago

  const callbackResExp = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateValExp}`);
  assert.strictEqual(callbackResExp.status, 400);
  const expErrHtml = await callbackResExp.text();
  assert.ok(expErrHtml.includes('Authentication Error'));
  currentMockExpOffset = 3600; // restore

  // 10. Test nonce mismatch rejection
  const startResNonce = await fetch(`${baseUrl}/api/auth/auth0/start`, { redirect: 'manual' });
  const stateValNonce = new URL(startResNonce.headers.get('location')).searchParams.get('state');
  const nonceValNonce = new URL(startResNonce.headers.get('location')).searchParams.get('nonce');

  currentMockNonce = 'mismatched_nonce';

  const callbackResNonce = await fetch(`${baseUrl}/api/auth/auth0/callback?code=mock_code&state=${stateValNonce}`);
  assert.strictEqual(callbackResNonce.status, 400);
  const nonceErrHtml = await callbackResNonce.text();
  assert.ok(nonceErrHtml.includes('Authentication Error'));
  currentMockNonce = nonceValNonce; // restore

  // 11. Test config disabled
  const backupSecretAuth0 = process.env.AUTH0_CLIENT_SECRET;
  delete process.env.AUTH0_CLIENT_SECRET;

  const configResDisabled = await fetch(`${baseUrl}/api/auth/config`);
  const configBodyDisabled = await configResDisabled.json();
  assert.strictEqual(configBodyDisabled.auth0.enabled, false, 'Missing AUTH0_CLIENT_SECRET must disable Auth0 login');

  const startResWithMissingSecret = await fetch(`${baseUrl}/api/auth/auth0/start`);
  assert.strictEqual(startResWithMissingSecret.status, 503, 'Missing secret should return 503');

  process.env.AUTH0_CLIENT_SECRET = backupSecretAuth0; // restore

  // 12. Reject malformed / unsafe domains
  const backupDomainAuth0 = process.env.AUTH0_DOMAIN;
  
  process.env.AUTH0_DOMAIN = 'https://malicious.auth0.com/'; // containing protocol and slash
  assert.strictEqual(getNormalizedAuth0Domain(), null);

  process.env.AUTH0_DOMAIN = 'invalid domain.com'; // containing spaces
  assert.strictEqual(getNormalizedAuth0Domain(), null);

  process.env.AUTH0_DOMAIN = backupDomainAuth0; // restore
});

test('YouTube relay admission accepts configured selected targets and preserves safety gates', async (t) => {
  const wsId = 'ws_youtube_relay';
  const targetId = 'target_youtube_relay';
  const connectionId = 'connection_youtube_relay';
  const now = new Date().toISOString();
  db.run("INSERT INTO workspaces (id, name, stripe_status, created_at) VALUES (?, 'YouTube relay test', 'trialing', ?)", [wsId, now]);
  const { deviceId, token } = createActiveDeviceToken(wsId, 'youtube_relay');
  const key = crypto.randomBytes(24).toString('base64url');
  db.run('UPDATE devices SET ingest_key_hash = ? WHERE id = ?', [crypto.createHash('sha256').update(key).digest('hex'), deviceId]);
  db.run("INSERT INTO provider_connections (id, workspace_id, provider, status, updated_at) VALUES (?, ?, 'youtube', 'connected', ?)", [connectionId, wsId, now]);
  db.run("INSERT INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected, selected_broadcast_id, broadcast_snapshot, created_at) VALUES (?, ?, ?, 'youtube', 'test-channel', 'Test Channel', 1, 'mock-b-id', ?, ?)", [targetId, wsId, connectionId, JSON.stringify({id: 'mock-b-id', title: 'Test', boundStreamId: 'stream-id', lifeCycleStatus: 'ready'}), now]);
  let configured = true;
  t.mock.method(nangoClient, 'isConfigured', () => configured);
  const updateBroadcastMock = t.mock.method(nangoClient, 'updateYoutubeBroadcast', async (workspace, externalId, broadcastId, params) => {
    assert.equal(workspace, wsId);
    assert.equal(externalId, 'test-channel');
    assert.equal(broadcastId, 'mock-b-id');
    assert.deepEqual(params, { enableAutoStart: true });
    return { id: broadcastId };
  });
  const resolver = t.mock.method(nangoClient, 'resolveDestination', async (workspace, provider, externalId, broadcastId) => {
    assert.equal(workspace, wsId);
    assert.equal(provider, 'youtube');
    assert.equal(externalId, 'test-channel');
    assert.equal(broadcastId, 'mock-b-id');
    return { streamUrl: 'rtmp://youtube.test/live', streamKey: 'synthetic-youtube-key' };
  });
  const preflight = (destination = targetId) => fetch(`${baseUrl}/api/workspaces/${wsId}/streams/preflight`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinations: [destination] })
  });
  const rejectBoth = async (status) => {
    assert.equal((await preflight()).status, status);
    assert.equal((await publishIngestKey(key)).status, status);
    assert.equal(queryOne('SELECT COUNT(*) AS count FROM stream_sessions WHERE device_id = ?', [deviceId]).count, 0);
  };

  const listedTarget = async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/destinations`, {
      headers: { Authorization: `Bearer ${token}`, Origin: 'null' }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes('synthetic-youtube-key'), false);
    return body.destinations.find(item => item.id === targetId);
  };

  configured = false;
  assert.equal((await listedTarget()).ready, false);
  await rejectBoth(400);
  configured = true;
  assert.equal((await listedTarget()).ready, true);
  assert.equal((await listedTarget()).status, 'ready');
  db.run("UPDATE workspaces SET stripe_status = 'none' WHERE id = ?", [wsId]);
  await rejectBoth(402);
  db.run("UPDATE workspaces SET stripe_status = 'trialing' WHERE id = ?", [wsId]);
  db.run('UPDATE provider_targets SET selected = 0 WHERE id = ?', [targetId]);
  await rejectBoth(400);
  db.exec('PRAGMA ignore_check_constraints = ON;');
  db.run("UPDATE provider_targets SET selected = 1, provider = 'unsupported' WHERE id = ?", [targetId]);
  assert.equal((await listedTarget()).ready, false);
  await rejectBoth(400);
  db.run("UPDATE provider_targets SET provider = 'youtube' WHERE id = ?", [targetId]);
  db.exec('PRAGMA ignore_check_constraints = OFF;');

  const otherWs = 'ws_youtube_other';
  db.run("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Other tenant', ?)", [otherWs, now]);
  db.run('UPDATE provider_targets SET workspace_id = ? WHERE id = ?', [otherWs, targetId]);
  await rejectBoth(400);
  db.run('UPDATE provider_targets SET workspace_id = ? WHERE id = ?', [wsId, targetId]);

  assert.equal((await preflight()).status, 200);
  assert.equal(resolver.mock.callCount(), 0, 'Preflight must not resolve stream credentials');
  try {
    assert.equal((await publishIngestKey(key)).status, 200);
    const destination = await waitForValue(() => {
      const d = queryOne("SELECT d.* FROM stream_session_destinations d JOIN stream_sessions s ON s.id = d.stream_session_id WHERE s.device_id = ? AND d.status = 'pending'", [deviceId]);
      if (!d) return null;
      const w = queryOne("SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ?", [d.stream_session_id]);
      return w && w.count > 0 ? d : null;
    });
    assert.equal(destination.target_type, 'provider');
    assert.equal(destination.target_id, targetId);
    assert.equal(resolver.mock.callCount(), 1);
    assert.equal(updateBroadcastMock.mock.callCount(), 1);
    assert.equal(queryOne("SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ? AND status = 'running'", [destination.stream_session_id]).count, 1);
  } finally {
    const stopped = await fetch(`${baseUrl}/api/streams/publish_done`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: key }).toString()
    });
    assert.equal(stopped.status, 200);
  }
  assert.equal(queryOne("SELECT COUNT(*) AS count FROM stream_sessions WHERE device_id = ? AND status != 'stopped'", [deviceId]).count, 0);
});

test('14. Emberstage Managed-Streaming MVP & Worker Manager Validation', async () => {
  // Set fake workers mode to true
  process.env.FAKE_WORKERS = 'true';

  // 1. Setup a test workspace, users, and credentials
    const wsId = 'ws_streaming_test';
    const devId = 'dev_streaming_test';
    
    db.run("INSERT OR IGNORE INTO workspaces (id, name, stripe_status, max_destinations, created_at) VALUES (?, 'Test Streaming Workspace', 'active', 2, ?)", [wsId, new Date().toISOString()]);
    const presentedKey = `esk_${crypto.randomBytes(24).toString('base64url')}`;
    const presentedKeyHash = crypto.createHash('sha256').update(presentedKey).digest('hex');
    db.run("INSERT OR IGNORE INTO devices (id, workspace_id, name, status, ingest_key_hash, ingest_key_last4, ingest_key_rotated_at, created_at) VALUES (?, ?, 'Test Device', 'active', ?, ?, ?, ?)", [
      devId,
      wsId,
      presentedKeyHash,
      presentedKey.slice(-4),
      new Date().toISOString(),
      new Date().toISOString()
    ]);

    const accessToken = 'device-token-123';
    const accessTokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
    db.run(
      `INSERT INTO device_sessions (id, device_id, refresh_token_hash, expires_at, refresh_token_expires_at, created_at)
       VALUES (?, ?, 'mock-refresh-hash', ?, ?, ?)`,
      [accessTokenHash, devId, new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()]
    );

    // 2. Add custom targets and provider targets
    const customTargetId1 = 'crt_target1';
    const customTargetId2 = 'crt_target2';
    
    // Encrypt the stream keys
    const encKey1 = cryptoUtils.encrypt('secret_stream_key_1', config.ENCRYPTION_SECRET);
    const encKey2 = cryptoUtils.encrypt('secret_stream_key_2', config.ENCRYPTION_SECRET);

    db.run("INSERT OR IGNORE INTO custom_rtmp_targets (id, workspace_id, name, stream_url, encrypted_stream_key, selected, created_at) VALUES (?, ?, 'Custom 1', 'rtmp://custom1.com/live', ?, 1, ?)", [customTargetId1, wsId, encKey1, new Date().toISOString()]);
    db.run("INSERT OR IGNORE INTO custom_rtmp_targets (id, workspace_id, name, stream_url, encrypted_stream_key, selected, created_at) VALUES (?, ?, 'Custom 2', 'rtmp://custom2.com/live', ?, 1, ?)", [customTargetId2, wsId, encKey2, new Date().toISOString()]);

    // 3. Test Device Endpoint: GET Destinations (ensure credentials redacted)
    const destRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/destinations`, {
      headers: {
        'Authorization': 'Bearer device-token-123'
      }
    });
    assert.strictEqual(destRes.status, 200);
    const destData = await destRes.json();
    assert.ok(destData.success);
    assert.strictEqual(destData.destinations.length, 2);
    
    // Check credential redaction: Ensure stream keys/secrets are never returned
    for (const d of destData.destinations) {
      assert.strictEqual(d.stream_key, undefined);
      assert.strictEqual(d.encrypted_stream_key, undefined);
    }

    // 4. Test Preflight check endpoint
    const preflightRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/preflight`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer device-token-123',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ destinations: [customTargetId1, customTargetId2] })
    });
    assert.strictEqual(preflightRes.status, 200);
    const preflightData = await preflightRes.json();
    assert.ok(preflightData.eligible);

    // 5. The retired session-key endpoint no longer issues credentials.
    const retiredStartRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/start`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer device-token-123' }
    });
    assert.strictEqual(retiredStartRes.status, 410);

    // 5b. NGINX on_publish authenticates the persistent device key and creates the stream.
    const publishRes = await fetch(`${baseUrl}/api/streams/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ name: presentedKey }).toString()
    });
    assert.strictEqual(publishRes.status, 200);
    const publishData = await publishRes.json();
    assert.ok(publishData.success);

    const dbSession = await waitForValue(() => queryOne(
      "SELECT * FROM stream_sessions WHERE device_id = ? AND status = 'streaming' ORDER BY created_at DESC LIMIT 1",
      [devId]
    ));
    const streamSessionId = dbSession.id;
    assert.ok(dbSession.started_at);
    assert.strictEqual(dbSession.stream_key_hash, crypto.createHash('sha256').update(presentedKey).digest('hex'));

    const dbDestinations = queryAll("SELECT * FROM stream_session_destinations WHERE stream_session_id = ?", [streamSessionId]);
    assert.strictEqual(dbDestinations.length, 2);

    // A duplicate publish callback is idempotent for the same active device stream.
    const duplicatePublishRes = await publishIngestKey(presentedKey);
    assert.strictEqual(duplicatePublishRes.status, 200);
    assert.strictEqual(queryOne(
      "SELECT COUNT(*) AS count FROM stream_sessions WHERE device_id = ? AND status = 'streaming'",
      [devId]
    ).count, 1);

    // Test on_publish reject with wrong key
    const publishRejectRes = await fetch(`${baseUrl}/api/streams/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ name: 'wrong-key-123' }).toString()
    });
    assert.strictEqual(publishRejectRes.status, 401);

    // NGINX authorizes first; relays start automatically once the publisher exists.
    await waitForValue(() => queryOne(
      "SELECT id FROM stream_workers WHERE stream_session_id = ? AND status = 'running' LIMIT 1",
      [streamSessionId]
    ));

    const statusRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/${streamSessionId}/status`, {
      headers: { 'Authorization': 'Bearer device-token-123' }
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.stream.status, 'streaming');

    // Verify session state in database is now streaming
    const dbSessionActive = queryOne("SELECT * FROM stream_sessions WHERE id = ?", [streamSessionId]);
    assert.strictEqual(dbSessionActive.status, 'streaming');
    assert.ok(dbSessionActive.started_at);

    const dbDestinationsActive = queryAll("SELECT * FROM stream_session_destinations WHERE stream_session_id = ?", [streamSessionId]);
    assert.strictEqual(dbDestinationsActive[0].status, 'pending');

    // Verify workers running in database
    const dbWorkers = queryAll("SELECT * FROM stream_workers WHERE stream_session_id = ?", [streamSessionId]);
    assert.strictEqual(dbWorkers.length, 2);
    assert.strictEqual(dbWorkers[0].status, 'running');

    // 5d. Test Device CORS preflight request (OPTIONS) with Origin: null
    const corsPreflightRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/${streamSessionId}/status`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'null',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type, Authorization'
      }
    });
    assert.strictEqual(corsPreflightRes.status, 204);
    assert.strictEqual(corsPreflightRes.headers.get('Access-Control-Allow-Origin'), 'null');
    assert.strictEqual(corsPreflightRes.headers.get('Access-Control-Allow-Methods'), 'GET, POST, DELETE, OPTIONS');

    // Test actual Device fetch with Origin: null
    const corsFetchRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/destinations`, {
      method: 'GET',
      headers: {
        'Origin': 'null',
        'Authorization': 'Bearer device-token-123'
      }
    });
    assert.strictEqual(corsFetchRes.status, 200);
    assert.strictEqual(corsFetchRes.headers.get('Access-Control-Allow-Origin'), 'null');

    const arbitraryOriginRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/destinations`, {
      headers: {
        'Origin': 'https://attacker.example',
        'Authorization': 'Bearer device-token-123'
      }
    });
    assert.strictEqual(arbitraryOriginRes.status, 403);

    // Test non-device (web/admin/auth) route with Origin: null should be rejected with 403 Forbidden
    const webRejectRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Origin': 'null',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: 'test@example.com', password: 'password' })
    });
    assert.strictEqual(webRejectRes.status, 403);

    // 5e. Test NGINX on_publish_done callback stopping the session idempotently
    const doneRes = await fetch(`${baseUrl}/api/streams/publish_done`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ name: presentedKey }).toString()
    });
    assert.strictEqual(doneRes.status, 200);
    const doneData = await doneRes.json();
    assert.ok(doneData.success);

    // Verify database state is stopped and workers are stopped
    const dbSessionDone = queryOne("SELECT * FROM stream_sessions WHERE id = ?", [streamSessionId]);
    assert.strictEqual(dbSessionDone.status, 'stopped');

    const dbWorkersDone = queryAll("SELECT * FROM stream_workers WHERE stream_session_id = ?", [streamSessionId]);
    assert.strictEqual(dbWorkersDone.every(w => w.status === 'stopped'), true);

    // Test stop endpoint can be called (should return 400 since already stopped)
    const stopRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/${streamSessionId}/stop`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer device-token-123'
      }
    });
    assert.strictEqual(stopRes.status, 400);
});

test('YouTube Broadcast Flow Contract and Edge Cases', async (t) => {
  process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION IN TEST RUNNER PROCESS:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION IN TEST RUNNER PROCESS:', err);
  });

  const wsId = 'ws_yt_flow';
  const targetId = 'target_yt_flow';
  const connectionId = 'connection_yt_flow';
  const now = new Date().toISOString();

  // Insert workspace
  db.run("INSERT INTO workspaces (id, name, stripe_status, created_at) VALUES (?, 'YT Flow Test', 'trialing', ?)", [wsId, now]);

  const userId = 'user_yt_flow';
  const sessionId = 'session_yt_flow';
  const csrfSecret = 'csrf_secret_yt_flow';
  const expiresAt = new Date(Date.now() + 86400000).toISOString();

  // Insert user, membership, web session
  db.run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, 'yt_owner@example.com', 'hash', ?)", [userId, now]);
  db.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')", [wsId, userId]);
  db.run("INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)", [sessionId, userId, csrfSecret, expiresAt]);

  const webHeaders = {
    'Cookie': `session_id=${sessionId}; _csrf=${csrfSecret}`,
    'X-CSRF-Token': csrfSecret
  };

  const { deviceId, token: deviceToken } = createActiveDeviceToken(wsId, 'yt_flow');
  const key = crypto.randomBytes(24).toString('base64url');
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  db.run('UPDATE devices SET ingest_key_hash = ?, link_code = ?, ingest_key_last4 = ?, ingest_key_rotated_at = ? WHERE id = ?', [keyHash, 'CODE123', 'xxxx', now, deviceId]);

  // Insert provider target
  db.run("INSERT INTO provider_connections (id, workspace_id, provider, status, updated_at) VALUES (?, ?, 'youtube', 'connected', ?)", [connectionId, wsId, now]);
  db.run(`
    INSERT INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected, created_at)
    VALUES (?, ?, ?, 'youtube', 'yt-external-id', 'My YouTube Channel', 1, ?)
  `, [targetId, wsId, connectionId, now]);

  // Mock NangoClient
  const mockIsConfigured = t.mock.method(nangoClient, 'isConfigured', () => true);

  const mockBroadcasts = [
    {
      id: 'b-existing-1',
      title: 'Existing Live Broadcast',
      description: 'Cool description',
      privacyStatus: 'private',
      lifeCycleStatus: 'ready',
      boundStreamId: 'stream-1',
      scheduledStartTime: now,
      latencyPreference: 'normal',
      categoryId: '22',
      thumbnailUrl: null
    }
  ];

  const mockGetYoutubeBroadcasts = t.mock.method(nangoClient, 'getYoutubeBroadcasts', async () => {
    return mockBroadcasts;
  });

  const mockCreateYoutubeBroadcast = t.mock.method(nangoClient, 'createYoutubeBroadcast', async (workspace, extId, params) => {
    return {
      id: 'b-new-created',
      snippet: {
        title: params.title,
        description: params.description,
        scheduledStartTime: params.scheduledStartTime || now,
        categoryId: params.categoryId
      },
      status: {
        privacyStatus: params.privacyStatus
      },
      contentDetails: {
        latencyPreference: params.latencyPreference || 'normal',
        boundStreamId: 'stream-new-bound'
      }
    };
  });

  const mockUpdateYoutubeBroadcast = t.mock.method(nangoClient, 'updateYoutubeBroadcast', async (workspace, extId, bId, params) => {
    return {
      id: bId,
      snippet: {
        title: params.title || 'Updated Title',
        description: params.description || 'Updated Description',
        categoryId: params.categoryId
      },
      status: {
        privacyStatus: params.privacyStatus
      },
      contentDetails: {
        latencyPreference: params.latencyPreference || 'normal',
        boundStreamId: 'stream-1'
      }
    };
  });

  const mockUploadYoutubeThumbnail = t.mock.method(nangoClient, 'uploadYoutubeThumbnail', async () => {});

  const mockTransitionYoutubeBroadcast = t.mock.method(nangoClient, 'transitionYoutubeBroadcast', async (workspace, extId, bId, status) => {
    return {
      id: bId,
      snippet: { title: 'Broadcast Title' },
      status: { privacyStatus: 'private', lifeCycleStatus: status === 'live' ? 'live' : 'complete' },
      contentDetails: { boundStreamId: 'stream-1' }
    };
  });

  // Mock youtubeApiRequest to bypass background setup checks in Setup endpoint if it invokes them
  const mockYoutubeApiRequest = t.mock.method(nangoClient, 'youtubeApiRequest', async (workspace, path) => {
    if (path.includes('/liveBroadcasts')) {
      return {
        items: [{
          id: 'b-existing-1',
          status: { lifeCycleStatus: 'ready' },
          contentDetails: { boundStreamId: 'stream-1' }
        }]
      };
    }
    if (path.includes('/liveStreams')) {
      return {
        items: [{
          id: 'stream-1',
          status: { streamStatus: 'active', healthStatus: { status: 'good' } }
        }]
      };
    }
    return { items: [] };
  });

  // 1. GET broadcasts
  const getBRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts`, {
    headers: { Authorization: `Bearer ${deviceToken}` }
  });
  assert.strictEqual(getBRes.status, 200);
  const getBData = await getBRes.json();
  assert.ok(getBData.success);
  assert.deepEqual(getBData.broadcasts, mockBroadcasts);

  // 2. POST create broadcast
  const createBRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'New Broadcast Title',
      description: 'New Broadcast Desc',
      privacyStatus: 'private',
      latencyPreference: 'low',
      categoryId: '10'
    })
  });
  if (createBRes.status !== 200) {
    console.error('FAILED createBRes:', await createBRes.text());
  }
  assert.strictEqual(createBRes.status, 200);
  const createBData = await createBRes.json();
  assert.ok(createBData.success);
  assert.strictEqual(createBData.broadcast.id, 'b-new-created');
  assert.strictEqual(createBData.broadcast.title, 'New Broadcast Title');
  assert.strictEqual(createBData.broadcast.latencyPreference, 'low');

  // Verify DB got updated with selected_broadcast_id
  const targetCheck = queryOne('SELECT selected_broadcast_id, broadcast_snapshot FROM provider_targets WHERE id = ?', [targetId]);
  assert.strictEqual(targetCheck.selected_broadcast_id, 'b-new-created');
  assert.ok(targetCheck.broadcast_snapshot);

  // 3. POST select broadcast
  const selectBRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts/select`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ broadcastId: 'b-existing-1' })
  });
  assert.strictEqual(selectBRes.status, 200);
  const selectBData = await selectBRes.json();
  assert.ok(selectBData.success);
  assert.strictEqual(selectBData.broadcast.id, 'b-existing-1');

  // 4. POST update broadcast
  const updateBRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Brand New Title',
      description: 'Brand New Desc'
    })
  });
  assert.strictEqual(updateBRes.status, 200);
  const updateBData = await updateBRes.json();
  assert.ok(updateBData.success);
  assert.strictEqual(updateBData.broadcast.title, 'Brand New Title');

  // 5. POST thumbnail too large (> 2MB)
  const tooLargeBase64 = 'A'.repeat(3 * 1024 * 1024);
  const thTooLargeRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts/thumbnail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/jpeg', dataBase64: tooLargeBase64 })
  });
  assert.strictEqual(thTooLargeRes.status, 400);

  // POST thumbnail safe size (< 2MB)
  const safeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const thSafeRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts/thumbnail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: safeBase64 })
  });
  assert.strictEqual(thSafeRes.status, 200);

  // 6. POST transition broadcast
  const transRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'live' })
  });
  assert.strictEqual(transRes.status, 200);

  // 7. GET setup
  const setupRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/setup`, {
    headers: { Authorization: `Bearer ${deviceToken}` }
  });
  assert.strictEqual(setupRes.status, 200);
  const setupData = await setupRes.json();
  assert.ok(setupData.success);
  assert.ok(setupData.ingestServer);
  assert.ok(setupData.devices.length > 0);
  assert.ok(setupData.destinations.length > 0);
  const destYt = setupData.destinations.find(d => d.id === targetId);
  assert.ok(destYt);
  assert.strictEqual(destYt.broadcast.id, 'b-existing-1');
  for (const device of setupData.devices) {
    for (const field of ['link_code', 'ingest_key_hash', 'refresh_token_hash']) {
      assert.equal(Object.hasOwn(device, field), false, `setup must not expose ${field}`);
    }
  }

  // 8. Test Conflict (active streaming session)
  // Let's publish first
  const pubRes = await fetch(`${baseUrl}/api/streams/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: key, clientid: 'my-unique-client-123' })
  });
  assert.strictEqual(pubRes.status, 200);

  // Wait a moment for preflight and streaming activation
  const activeSession = await waitForValue(() => {
    const s = queryOne("SELECT * FROM stream_sessions WHERE device_id = ? AND status IN ('reserved', 'streaming')", [deviceId]);
    return s;
  });
  assert.ok(activeSession);

  // Try to deselect target while active -> should return 409
  const deselRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/deselect`, {
    method: 'POST',
    headers: { ...webHeaders }
  });
  assert.strictEqual(deselRes.status, 409);

  // Try to create/select/update broadcast while active -> should return 409
  const selectActiveRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/providers/targets/${targetId}/broadcasts/select`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ broadcastId: 'b-existing-1' })
  });
  assert.strictEqual(selectActiveRes.status, 409);

  // 9. NGINX stale clientid publish_done callback
  // Try sending a publish_done with a different clientid (stale)
  const staleDoneRes = await fetch(`${baseUrl}/api/streams/publish_done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: key, clientid: 'stale-client-999' })
  });
  assert.strictEqual(staleDoneRes.status, 200);
  const staleData = await staleDoneRes.json();
  assert.strictEqual(staleData.message, 'Stale done callback ignored (clientid mismatch)');

  // Stream session should still be active
  const checkActiveSession = queryOne("SELECT * FROM stream_sessions WHERE id = ?", [activeSession.id]);
  assert.notStrictEqual(checkActiveSession.status, 'stopped');

  // Now send publish_done with matching clientid -> should stop the session
  const validDoneRes = await fetch(`${baseUrl}/api/streams/publish_done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: key, clientid: 'my-unique-client-123' })
  });
  assert.strictEqual(validDoneRes.status, 200);
  const validData = await validDoneRes.json();
  assert.strictEqual(validData.message, 'Session stopped and workers terminated');

  // Verify session is now stopped
  const checkStoppedSession = queryOne("SELECT * FROM stream_sessions WHERE id = ?", [activeSession.id]);
  assert.strictEqual(checkStoppedSession.status, 'stopped');

  // The next broadcast must not be replaced by the previous session snapshot.
  const nextBroadcast = { ...mockBroadcasts[0], id: 'b-next', title: 'Next broadcast' };
  db.run('UPDATE provider_targets SET selected_broadcast_id = ?, broadcast_snapshot = ? WHERE id = ?',
    [nextBroadcast.id, JSON.stringify(nextBroadcast), targetId]);
  // A stored active flag without a progressing process is not delivery proof.
  db.run("UPDATE stream_session_destinations SET status = 'active' WHERE stream_session_id = ?", [activeSession.id]);
  const { workerManager } = await import('../src/worker-manager.js');
  t.mock.method(workerManager, 'getDeliveryStatus', () => null);
  const nextSetupRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/setup`, {
    headers: { Authorization: `Bearer ${deviceToken}`, Origin: 'null' }
  });
  assert.equal(nextSetupRes.status, 200);
  assert.equal(nextSetupRes.headers.get('access-control-allow-origin'), 'null');
  const nextSetup = await nextSetupRes.json();
  const nextDestination = nextSetup.destinations.find(d => d.id === targetId);
  assert.equal(nextDestination.broadcast.id, 'b-next');
  assert.equal(nextDestination.delivery.relayState, 'stopped');
  const broadcastRequests = mockYoutubeApiRequest.mock.calls.filter(call => call.arguments[1].includes('/liveBroadcasts'));
  assert.match(broadcastRequests.at(-1).arguments[1], /id=b-next$/);
});

test('YouTube Auto-start and Admission Edge Cases', async (t) => {
  const wsId = 'ws_youtube_autostart';
  const targetId = 'target_youtube_autostart';
  const connectionId = 'connection_youtube_autostart';
  const now = new Date().toISOString();
  db.run("INSERT INTO workspaces (id, name, stripe_status, created_at) VALUES (?, 'YouTube autostart test', 'trialing', ?)", [wsId, now]);
  
  const { deviceId, token } = createActiveDeviceToken(wsId, 'youtube_autostart');
  const key = crypto.randomBytes(24).toString('base64url');
  db.run('UPDATE devices SET ingest_key_hash = ? WHERE id = ?', [crypto.createHash('sha256').update(key).digest('hex'), deviceId]);
  
  db.run("INSERT INTO provider_connections (id, workspace_id, provider, status, updated_at) VALUES (?, ?, 'youtube', 'connected', ?)", [connectionId, wsId, now]);
  
  db.run(`INSERT INTO provider_targets 
    (id, workspace_id, provider_connection_id, provider, external_id, name, selected, selected_broadcast_id, broadcast_snapshot, created_at) 
    VALUES (?, ?, ?, 'youtube', 'autostart-channel', 'Autostart Channel', 1, 'autostart-b-id', ?, ?)`
    , [targetId, wsId, connectionId, JSON.stringify({id: 'autostart-b-id', title: 'Test Autostart', boundStreamId: 'stream-id-1', lifeCycleStatus: 'ready'}), now]
  );

  let updateBroadcastCalled = false;
  let updateParams = null;
  const activationOrder = [];
  t.mock.method(nangoClient, 'isConfigured', () => true);
  t.mock.method(nangoClient, 'updateYoutubeBroadcast', async (workspace, externalId, broadcastId, params) => {
    activationOrder.push('auto-start');
    assert.equal(broadcastId, 'autostart-b-id');
    updateBroadcastCalled = true;
    updateParams = params;
    return { id: broadcastId };
  });

  t.mock.method(nangoClient, 'resolveDestination', async (workspace, provider, externalId, broadcastId) => {
    activationOrder.push('resolve');
    assert.equal(broadcastId, 'autostart-b-id');
    return { streamUrl: 'rtmp://youtube.test/live', streamKey: 'synthetic-youtube-key' };
  });

  // 1. Admission: Disconnected Provider Target rejection
  db.run("UPDATE provider_connections SET status = 'disconnected' WHERE id = ?", [connectionId]);
  const preflightRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/preflight`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinations: [targetId] })
  });
  assert.equal(preflightRes.status, 400);
  const preflightData = await preflightRes.json();
  assert.match(preflightData.error, /disconnected/);

  // Restore connection
  db.run("UPDATE provider_connections SET status = 'connected' WHERE id = ?", [connectionId]);

  // 2. Admission: Completed broadcast rejection
  db.run('UPDATE provider_targets SET broadcast_snapshot = ? WHERE id = ?', [JSON.stringify({id: 'autostart-b-id', title: 'Test Autostart', boundStreamId: 'stream-id-1', lifeCycleStatus: 'complete'}), targetId]);
  const preflightRes2 = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/preflight`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinations: [targetId] })
  });
  assert.equal(preflightRes2.status, 400);
  const preflightData2 = await preflightRes2.json();
  assert.match(preflightData2.error, /completed/);

  // Restore snapshot to ready
  db.run('UPDATE provider_targets SET broadcast_snapshot = ? WHERE id = ?', [JSON.stringify({id: 'autostart-b-id', title: 'Test Autostart', boundStreamId: 'stream-id-1', lifeCycleStatus: 'ready'}), targetId]);

  // 3. Admission: Cross-channel / missing broadcast is handled. Let's start the stream session with a valid snapshot.
  const preflightRes3 = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/preflight`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinations: [targetId] })
  });
  assert.equal(preflightRes3.status, 200);

  // Reserve and publish to trigger activation
  const publishRes = await publishIngestKey(key);
  assert.equal(publishRes.status, 200);

  // Wait for activation to be complete
  const destination = await waitForValue(() => {
    const d = queryOne("SELECT d.* FROM stream_session_destinations d JOIN stream_sessions s ON s.id = d.stream_session_id WHERE s.device_id = ? AND d.status = 'pending'", [deviceId]);
    if (!d) return null;
    const w = queryOne("SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ?", [d.stream_session_id]);
    return w && w.count > 0 ? d : null;
  });

  assert.ok(destination);
  // Verify that updateYoutubeBroadcast was called with enableAutoStart: true BEFORE starting
  assert.equal(updateBroadcastCalled, true);
  assert.equal(updateParams.enableAutoStart, true);
  assert.deepEqual(activationOrder, ['resolve', 'auto-start']);

  // Verify "no early live status inference" - status is 'pending', not 'active'
  assert.equal(destination.status, 'pending');

  // Stop the session
  await fetch(`${baseUrl}/api/streams/publish_done`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: key })
  });
});

test('Facebook streaming integration: discovery, preflight, publish, start, stop, and clean up failures', async () => {
  const wsId = 'ws-fb-test';
  const connectionId = 'pc-fb-test';
  const targetId = 'pt-fb-test';
  const key = 'stream_key_fb_test';
  const now = new Date().toISOString();

  // Create workspace, device, connection, target
  db.run("INSERT INTO workspaces (id, name, stripe_status, created_at) VALUES (?, 'Facebook Test Workspace', 'trialing', ?)", [wsId, now]);
  const { deviceId, token: deviceToken } = createActiveDeviceToken(wsId, 'fb_device');
  db.run('UPDATE devices SET ingest_key_hash = ? WHERE id = ?', [crypto.createHash('sha256').update(key).digest('hex'), deviceId]);

  db.run("INSERT INTO provider_connections (id, workspace_id, provider, status, updated_at) VALUES (?, ?, 'facebook', 'connected', ?)", [connectionId, wsId, now]);
  db.run('INSERT INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', [targetId, wsId, connectionId, 'facebook', 'page-123', 'FB Page 123', now]);

  // Authenticate web client for this workspace
  const userToken = cryptoUtils.generateRandomToken(32);
  const userId = 'usr-fb-test';
  db.run('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [userId, 'fbuser@example.test', 'mock_hash', now]);
  db.run('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)', [wsId, userId, 'owner']);
  db.run('INSERT INTO web_sessions (id, user_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)', [userToken, userId, 'mock_csrf', new Date(Date.now() + 3600 * 1000).toISOString()]);

  // Mock facebook APIs on nangoClient
  const originalIsConfigured = nangoClient.isConfigured;
  const originalResolve = nangoClient.resolveDestination;
  const originalEnd = nangoClient.endFacebookLiveVideo;
  const originalStatus = nangoClient.getFacebookLiveVideoStatus;
  const { workerManager } = await import('../src/worker-manager.js');
  const originalStart = workerManager.startWorker;
  let snapshotBeforeWorker;
  let remoteState = null;
  let createCount = 0;
  let endCount = 0;

  nangoClient.isConfigured = () => true;
  let resolveCalled = false;
  let endCalled = false;
  let endErrorToThrow = null;

  nangoClient.resolveDestination = async (workspaceId, provider, externalId, broadcastId) => {
    if (provider === 'facebook') {
      resolveCalled = true;
      createCount++;
      assert.equal(workspaceId, wsId);
      assert.equal(externalId, 'page-123');
      return {
        streamUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
        streamKey: 'fb-stream-key-abc?s_bl=1',
        liveVideoId: 'fb-live-video-123',
        connectionId: 'fb-nango-connection'
      };
    }
    return originalResolve.call(nangoClient, workspaceId, provider, externalId, broadcastId);
  };

  nangoClient.endFacebookLiveVideo = async (workspaceId, pageId, liveVideoId, nangoConnectionId) => {
    endCalled = true;
    endCount++;
    assert.equal(workspaceId, wsId);
    assert.equal(pageId, 'page-123');
    assert.equal(liveVideoId, 'fb-live-video-123');
    assert.equal(nangoConnectionId, 'fb-nango-connection');
    if (endErrorToThrow) {
      throw endErrorToThrow;
    }
    return { success: true };
  };
  nangoClient.getFacebookLiveVideoStatus = async () => {
    if (!remoteState) throw new Error('SECRET_PROVIDER_ERROR');
    return { id: 'fb-live-video-123', status: remoteState, permalink_url: null };
  };
  workerManager.startWorker = async function (...args) {
    snapshotBeforeWorker = JSON.parse(queryOne('SELECT broadcast_snapshot FROM stream_session_destinations WHERE stream_session_id = ? AND target_id = ?', [args[0], args[1]]).broadcast_snapshot);
    return originalStart.apply(this, args);
  };
  const webHeaders = { Cookie: `session_id=${userToken}; _csrf=mock_csrf`, 'x-csrf-token': 'mock_csrf' };
  const disconnect = () => fetch(`${baseUrl}/api/workspaces/${wsId}/providers/facebook/disconnect`, { method: 'POST', headers: webHeaders });

  try {
    // 1. GET destinations endpoint includes Facebook
    const destRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/destinations`, {
      headers: { 'Cookie': `session_id=${userToken}` }
    });
    assert.equal(destRes.status, 200);
    const destData = await destRes.json();
    const fbDest = destData.destinations.find(d => d.id === targetId);
    assert.ok(fbDest);
    assert.equal(fbDest.provider, 'facebook');
    assert.equal(fbDest.ready, true);
    assert.equal(fbDest.status, 'ready');

    // 2. Preflight endpoint selects Facebook target via Device token
    const preflightRes = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/preflight`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinations: [targetId] })
    });
    assert.equal(preflightRes.status, 200);
    const preflightData = await preflightRes.json();
    assert.equal(preflightData.eligible, true);
    assert.equal(createCount, 0, 'status and preflight must not create a live video');

    // 3. Publish triggers session creation and activation
    const publishRes = await fetch(`${baseUrl}/api/streams/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: key, clientid: 'fb-client-id' })
    });
    assert.equal(publishRes.status, 200);

    // Get the newly created session from database
    const session = queryOne("SELECT * FROM stream_sessions WHERE device_id = ?", [deviceId]);
    assert.ok(session);
    const sessionId = session.id;
    assert.equal((await disconnect()).status, 409, 'reserved destination protects connection');

    // Verify session destination is reserved/pending
    const savedDest = queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ?', [sessionId]);
    assert.ok(savedDest);
    assert.equal(savedDest.target_id, targetId);

    // Wait for the worker to start and activation to complete
    const activatedDest = await waitForValue(() => {
      const d = queryOne("SELECT * FROM stream_session_destinations WHERE stream_session_id = ? AND broadcast_snapshot IS NOT NULL", [sessionId]);
      return d;
    });

    assert.ok(activatedDest);
    assert.equal(resolveCalled, true);

    // Verify broadcast_snapshot was persisted BEFORE worker start
    const snap = JSON.parse(activatedDest.broadcast_snapshot);
    assert.equal(snap.id, 'fb-live-video-123');
    assert.equal(snap.status, 'created');
    assert.equal(snap.pageId, 'page-123');
    assert.equal(snapshotBeforeWorker.id, 'fb-live-video-123');
    assert.equal(snapshotBeforeWorker.sessionId, sessionId);
    assert.equal(snapshotBeforeWorker.workspaceId, wsId);
    assert.ok(!JSON.stringify(snap).includes('fb-stream-key'));
    assert.equal((await publishIngestKey(key)).status, 200);
    assert.equal(createCount, 1, 'duplicate publish creates no second live object');
    assert.equal((await disconnect()).status, 409, 'streaming destination protects connection');
    const statusUrl = `${baseUrl}/api/workspaces/${wsId}/streams/${sessionId}/status`;
    let payload = await (await fetch(statusUrl, { headers: { Authorization: `Bearer ${deviceToken}` } })).json();
    assert.equal(payload.destinations[0].delivery.broadcastState, 'unknown');
    assert.equal(payload.destinations[0].delivery.receiving, 'unknown');
    remoteState = 'LIVE';
    payload = await (await fetch(`${baseUrl}/api/device/stream-status`, { headers: { Authorization: `Bearer ${deviceToken}` } })).json();
    assert.equal(payload.destinations[0].delivery.broadcastState, 'LIVE');
    assert.equal(payload.destinations[0].delivery.receiving, 'unknown');
    assert.equal(payload.destinations[0].broadcast_snapshot, undefined);
    assert.ok(!JSON.stringify(payload).includes('fb-stream-key'));
    const portal = await (await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/setup`, { headers: webHeaders })).json();
    assert.equal(portal.destinations.find(d => d.id === targetId).delivery.broadcastState, 'LIVE');

    // 4. Stop stream session fails when remote Facebook end fails (to make it retryable)
    endErrorToThrow = new Error('Meta API Rate Limit');
    const stopResFail = await fetch(`${baseUrl}/api/workspaces/${wsId}/streams/${sessionId}/stop`, {
      method: 'POST',
      headers: {
        'Cookie': `session_id=${userToken}; _csrf=mock_csrf`,
        'x-csrf-token': 'mock_csrf'
      }
    });
    assert.equal(stopResFail.status, 400);
    const stopFailData = await stopResFail.json();
    assert.match(stopFailData.error, /Facebook live cleanup pending/);
    assert.ok(!JSON.stringify(stopFailData).includes('Meta API Rate Limit'));

    // Verify destination state is failed and stores error
    const failedDest = queryOne('SELECT * FROM stream_session_destinations WHERE id = ?', [activatedDest.id]);
    assert.equal(failedDest.status, 'failed');
    assert.match(failedDest.error_message, /Facebook live cleanup pending/);
    assert.equal((await disconnect()).status, 409, 'stopped session with pending cleanup protects connection');
    assert.equal((await publishIngestKey(key)).status, 409, 'pending cleanup prevents another live video');
    payload = await (await fetch(`${baseUrl}/api/device/stream-status`, { headers: { Authorization: `Bearer ${deviceToken}` } })).json();
    assert.equal(payload.destinations[0].cleanupPending, true);

    // 5. Retry stop session with successful Meta API call
    endErrorToThrow = null;
    db.run('DELETE FROM provider_targets WHERE id = ?', [targetId]);
    assert.equal((await disconnect()).status, 409, 'snapshot protects connection even when target was removed');
    const retryStop = () => fetch(`${baseUrl}/api/workspaces/${wsId}/streams/${sessionId}/stop`, {
      method: 'POST',
      headers: {
        'Cookie': `session_id=${userToken}; _csrf=mock_csrf`,
        'x-csrf-token': 'mock_csrf'
      }
    });
    const [stopResSuccess, concurrentStop] = await Promise.all([retryStop(), retryStop()]);
    assert.equal(stopResSuccess.status, 200);
    assert.equal(concurrentStop.status, 400, 'second stop observes already stopped');
    assert.equal(endCount, 2, 'concurrent stops cause only one successful retry');

    // Verify destination status is stopped now
    const stoppedDest = queryOne('SELECT * FROM stream_session_destinations WHERE id = ?', [activatedDest.id]);
    assert.equal(stoppedDest.status, 'stopped');
    assert.equal(stoppedDest.error_message, null);
    assert.equal((await disconnect()).status, 200, 'confirmed end permits disconnect');

  } finally {
    // Restore original methods
    nangoClient.isConfigured = originalIsConfigured;
    nangoClient.resolveDestination = originalResolve;
    nangoClient.endFacebookLiveVideo = originalEnd;
    nangoClient.getFacebookLiveVideoStatus = originalStatus;
    workerManager.startWorker = originalStart;
  }
});

test('Facebook activation failure and concurrent stop retain exact cleanup binding before any worker', async () => {
  const { workerManager } = await import('../src/worker-manager.js');
  const originals = { configured: nangoClient.isConfigured, resolve: nangoClient.resolveDestination, end: nangoClient.endFacebookLiveVideo, start: workerManager.startWorker };
  const now = new Date().toISOString();
  let mode = 'worker-fail';
  let release;
  let entered;
  let endFail = false;
  let creates = 0;
  let starts = 0;
  const ends = [];
  nangoClient.isConfigured = () => true;
  nangoClient.resolveDestination = async (workspaceId, provider, externalId) => {
    assert.equal(provider, 'facebook');
    assert.equal(externalId, `page-${workspaceId}`);
    creates++;
    if (mode === 'race') {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    if (mode === 'parse-fail') {
      const error = new Error('Malformed stream URL; cleanup pending');
      Object.assign(error, { liveVideoId: `live-${workspaceId}`, pageId: externalId, connectionId: `connection-${workspaceId}` });
      throw error;
    }
    return { streamUrl: 'rtmps://live-api-s.facebook.com/rtmp/', streamKey: 'SECRET_RELAY_KEY', liveVideoId: `live-${workspaceId}`, connectionId: `connection-${workspaceId}` };
  };
  nangoClient.endFacebookLiveVideo = async (...args) => {
    ends.push(args);
    assert.deepEqual(args, [args[0], `page-${args[0]}`, `live-${args[0]}`, `connection-${args[0]}`]);
    if (endFail) throw new Error('SECRET_META_ERROR');
    return { success: true };
  };
  workerManager.startWorker = async function (...args) {
    starts++;
    const d = queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ?', [args[0]]);
    const snapshot = JSON.parse(d.broadcast_snapshot);
    assert.equal(snapshot.destinationId, d.id);
    assert.equal(snapshot.id, `live-${snapshot.workspaceId}`);
    assert.ok(!JSON.stringify(snapshot).includes('SECRET_'));
    if (mode === 'worker-fail') throw new Error('SECRET_ENCODER_ERROR');
    return originals.start.apply(this, args);
  };
  const fixture = async id => {
    db.run("INSERT INTO workspaces (id, name, stripe_status, created_at) VALUES (?, ?, 'trialing', ?)", [id, id, now]);
    const device = createActiveDeviceToken(id, id);
    const key = `key-${id}`;
    db.run('UPDATE devices SET ingest_key_hash = ? WHERE id = ?', [crypto.createHash('sha256').update(key).digest('hex'), device.deviceId]);
    db.run("INSERT INTO provider_connections (id, workspace_id, provider, status, updated_at) VALUES (?, ?, 'facebook', 'connected', ?)", [id, id, now]);
    db.run("INSERT INTO provider_targets (id, workspace_id, provider_connection_id, provider, external_id, name, selected, created_at) VALUES (?, ?, ?, 'facebook', ?, ?, 1, ?)", [`target-${id}`, id, id, `page-${id}`, id, now]);
    const response = await publishIngestKey(key);
    assert.equal(response.status, 200);
    const { streamId } = await response.json();
    return { id, streamId, key, stop: () => fetch(`${baseUrl}/api/workspaces/${id}/streams/${streamId}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${device.token}` } }) };
  };
  try {
    const failed = await fixture('fb-worker-start-failure');
    await waitForValue(() => queryOne("SELECT id FROM stream_sessions WHERE id = ? AND status = 'stopped'", [failed.streamId]));
    assert.equal(starts, 1);
    assert.equal(ends.length, 1);
    let destination = queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ?', [failed.streamId]);
    assert.equal(JSON.parse(destination.broadcast_snapshot).cleanupState, 'ended');
    assert.ok(!JSON.stringify(destination).includes('SECRET_'));

    mode = 'parse-fail';
    endFail = true;
    const malformed = await fixture('fb-malformed-pending');
    await waitForValue(() => queryOne("SELECT id FROM stream_sessions WHERE id = ? AND status = 'stopped'", [malformed.streamId]));
    destination = queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ?', [malformed.streamId]);
    assert.equal(destination.status, 'failed');
    assert.equal(JSON.parse(destination.broadcast_snapshot).id, 'live-fb-malformed-pending');
    assert.equal(JSON.parse(destination.broadcast_snapshot).cleanupState, 'pending');
    assert.equal(starts, 1, 'malformed URL never starts worker');
    endFail = false;
    assert.equal((await malformed.stop()).status, 200);

    mode = 'race';
    const resolving = new Promise(resolve => { entered = resolve; });
    const racing = await fixture('fb-activation-stop-race');
    await resolving;
    const stopPromise = racing.stop();
    // Duplicate publish while resolution is in flight must not create another remote object.
    assert.equal((await publishIngestKey(racing.key)).status, 200);
    release();
    assert.equal((await stopPromise).status, 200);
    assert.equal(creates, 3);
    assert.equal(ends.length, 4, 'one end per creation, plus one explicit failed-cleanup retry');
    destination = queryOne('SELECT * FROM stream_session_destinations WHERE stream_session_id = ?', [racing.streamId]);
    assert.equal(JSON.parse(destination.broadcast_snapshot).cleanupState, 'ended');
    assert.equal(queryOne("SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ? AND status = 'running'", [racing.streamId]).count, 0);
    mode = 'shutdown';
    const shutdown = await fixture('fb-shutdown-before-timer');
    const { drainStreamOperations } = await import('../src/server.js');
    await drainStreamOperations();
    await workerManager.reconcileAfterRestart();
    assert.equal(queryOne('SELECT status FROM stream_sessions WHERE id = ?', [shutdown.streamId]).status, 'stopped');
    assert.equal(creates, 3, 'shutdown cancels unstarted activation timers');
  } finally {
    if (release) release();
    nangoClient.isConfigured = originals.configured;
    nangoClient.resolveDestination = originals.resolve;
    nangoClient.endFacebookLiveVideo = originals.end;
    workerManager.startWorker = originals.start;
  }
});

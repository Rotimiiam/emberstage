import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = ':memory:';
process.env.FAKE_WORKERS = 'true';
process.env.ENCRYPTION_SECRET = 'synthetic-only-admission-encryption-secret';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_synthetic';
process.env.PAYSTACK_PLAN_CODE = 'PLN_synthetic';
delete process.env.NANGO_BASE_URL;
delete process.env.NANGO_SECRET_KEY;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error('EXTERNAL_FETCH_FORBIDDEN'); };

const { handleRequest, drainStreamOperations, expireStreamingSessions } = await import('../src/server.js');
const { db, initDatabase } = await import('../src/db.js');
const { workerManager } = await import('../src/worker-manager.js');
const { encrypt } = await import('../src/crypto-utils.js');
initDatabase();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const future = () => new Date(Date.now() + 86400000).toISOString();
let sequence = 0;

function fixture({ paid = true, targets = 1, payment = true } = {}) {
  const id = 'synthetic_' + (++sequence);
  const workspaceId = 'ws_' + id;
  const deviceId = 'dev_' + id;
  const token = 'access_' + id;
  const persistentKey = 'ember_' + id;
  const now = new Date().toISOString();
  const paidUntil = future();
  db.run(`INSERT INTO workspaces (id,name,created_at,paystack_status,paid_until)
    VALUES (?, ?, ?, ?, ?)`, [workspaceId, id, now, paid ? 'active' : 'none', paid ? paidUntil : null]);
  if (paid && payment) db.run(`INSERT INTO paystack_payments
    (reference,transaction_id,workspace_id,customer_code,plan_code,mode,paid_at,paid_until)
    VALUES (?, ?, ?, 'CUS_synthetic', 'PLN_synthetic', 'test', ?, ?)`, [id, id, workspaceId, now, paidUntil]);
  db.run(`INSERT INTO devices (id,workspace_id,name,status,ingest_key_hash,created_at)
    VALUES (?, ?, ?, 'active', ?, ?)`, [deviceId, workspaceId, id, hash(persistentKey), now]);
  db.run(`INSERT INTO device_sessions (id,device_id,refresh_token_hash,expires_at,refresh_token_expires_at,created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [hash(token), deviceId, hash('refresh_' + id), future(), future(), now]);
  for (let n = 0; n < targets; n++) db.run(`INSERT INTO custom_rtmp_targets
    (id,workspace_id,name,stream_url,encrypted_stream_key,selected,created_at)
    VALUES (?, ?, 'synthetic', 'rtmps://synthetic.invalid/live', ?, 1, ?)`,
  ['crt_' + id + '_' + n, workspaceId, encrypt('destination-secret-' + id, process.env.ENCRYPTION_SECRET), now]);
  const userId = 'usr_' + id;
  const sessionId = 'web_' + id;
  db.run('INSERT INTO users (id,email,password_hash,created_at) VALUES (?, ?, ?, ?)', [userId, id + '@example.invalid', 'not-used', now]);
  db.run("INSERT INTO memberships (workspace_id,user_id,role) VALUES (?, ?, 'owner')", [workspaceId, userId]);
  db.run('INSERT INTO web_sessions (id,user_id,csrf_secret,expires_at) VALUES (?, ?, ?, ?)', [sessionId, userId, id, future()]);
  return { workspaceId, deviceId, token, persistentKey, cookie: `session_id=${sessionId}; _csrf=${id}`, csrf: id };
}

async function request(path, { f, method = 'GET', body = '', headers = {} } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = path;
  req.method = method;
  req.headers = { host: 'localhost', ...(f ? { authorization: 'Bearer ' + f.token } : {}), ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const responseHeaders = {};
  let status;
  let data;
  const res = {
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    writeHead(code, values = {}) { status = code; for (const [k, v] of Object.entries(values)) this.setHeader(k, v); },
    end(value) { data = value ? JSON.parse(String(value)) : null; }
  };
  await handleRequest(req, res);
  return { status, data, headers: responseHeaders };
}
const admission = (f, body = '') => request('/api/device/publish-admission', { f, method: 'POST', body });
const callback = (name, clientid = 'synthetic-client', done = false) => request('/api/streams/' + (done ? 'publish_done' : 'publish'), {
  method: 'POST', body: JSON.stringify({ name, clientid })
});
const session = id => db.queryOne('SELECT * FROM stream_sessions WHERE id = ?', [id]);
const sessions = f => db.queryAll('SELECT * FROM stream_sessions WHERE device_id = ?', [f.deviceId]);
async function settleActivation() { await new Promise(resolve => setTimeout(resolve, 320)); }
async function stop(f, streamId) {
  return request(`/api/workspaces/${f.workspaceId}/streams/${streamId}/stop`, { f, method: 'POST' });
}
test.after(async () => {
  await drainStreamOperations();
  for (const row of db.queryAll('SELECT id FROM stream_sessions')) await workerManager.stopWorkersForSession(row.id);
  assert.equal(externalCalls, 0);
  db.close();
});

test('Free fails 402 without reservation; paid_until alone is not payment proof', async () => {
  for (const f of [fixture({ paid: false }), fixture({ payment: false })]) {
    const result = await admission(f);
    assert.equal(result.status, 402);
    assert.equal(result.data.error, 'ADMISSION_PAYMENT_REQUIRED');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(sessions(f).length, 0);
  }
});

test('no selected destination fails 400 without row', async () => {
  const f = fixture({ targets: 0 });
  assert.equal((await admission(f)).status, 400);
  assert.equal(sessions(f).length, 0);
});

test('custom-only grant returns one ephemeral name and stores hash only, no usage/audit grant', async () => {
  const f = fixture();
  const start = Date.now();
  const result = await admission(f);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data).sort(), ['expiresAt', 'publishName', 'streamId', 'success']);
  assert.match(result.data.publishName, /^ep_[a-f0-9]{64}$/);
  assert.ok(Date.parse(result.data.expiresAt) >= start + 90000);
  assert.ok(Date.parse(result.data.expiresAt) <= Date.now() + 90000);
  const row = session(result.data.streamId);
  assert.equal(row.stream_key_hash, hash(result.data.publishName));
  assert.equal(row.publish_capability_expires_at, result.data.expiresAt);
  assert.ok(!JSON.stringify(row).includes(result.data.publishName));
  assert.equal(db.queryAll('SELECT * FROM usage_counters WHERE workspace_id = ?', [f.workspaceId]).length, 0);
  assert.equal(db.queryAll('SELECT * FROM audit_records WHERE workspace_id = ?', [f.workspaceId]).length, 0);
  assert.equal(db.queryOne('SELECT ingest_key_hash FROM devices WHERE id = ?', [f.deviceId]).ingest_key_hash, hash(f.persistentKey));
  await stop(f, result.data.streamId);
});

test('concurrent admission replay gives 409, one row and no name, preserves access family', async () => {
  const f = fixture();
  const results = await Promise.all([admission(f), admission(f)]);
  const grant = results.find(r => r.status === 200);
  const replay = results.find(r => r.status === 409);
  assert.ok(grant && replay);
  assert.deepEqual(replay.data, { error: 'ADMISSION_ALREADY_OPEN', streamId: grant.data.streamId });
  assert.equal(sessions(f).length, 1);
  assert.equal((await request('/api/device/publish-status', { f })).status, 200);
  await stop(f, grant.data.streamId);
});

test('expired 90-second reservation is reaped, hash nulled; old name cannot publish', async () => {
  const f = fixture();
  const { data } = await admission(f);
  db.run('UPDATE stream_sessions SET publish_capability_expires_at = ? WHERE id = ?', [new Date(Date.now() - 1).toISOString(), data.streamId]);
  const status = await request('/api/device/publish-status', { f });
  assert.equal(status.data.stream, null);
  assert.equal(session(data.streamId).status, 'stopped');
  assert.equal(session(data.streamId).stream_key_hash, null);
  assert.equal((await callback(data.publishName)).status, 401);
  const next = await admission(f);
  assert.equal(next.status, 200);
  assert.notEqual(next.data.publishName, data.publishName);
  await stop(f, next.data.streamId);
});

test('first callback needs clientid, duplicate same-client creates one worker and one usage', async () => {
  const f = fixture();
  const { data } = await admission(f);
  assert.equal((await callback(data.publishName, '')).status, 400);
  assert.equal(session(data.streamId).publisher_identity, null);
  assert.deepEqual((await Promise.all([callback(data.publishName), callback(data.publishName)])).map(r => r.status), [200, 200]);
  assert.equal((await callback(data.publishName, 'foreign')).status, 409);
  await settleActivation();
  assert.equal(session(data.streamId).status, 'streaming');
  assert.equal(db.queryOne('SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ?', [data.streamId]).count, 1);
  assert.equal(db.queryOne("SELECT value FROM usage_counters WHERE workspace_id = ? AND metric = 'stream_sessions_count'", [f.workspaceId]).value, 1);
  await stop(f, data.streamId);
});

test('expired callback itself reaps capability before accepting publisher', async () => {
  const f = fixture();
  const { data } = await admission(f);
  db.run('UPDATE stream_sessions SET publish_capability_expires_at = ? WHERE id = ?', [new Date(Date.now() - 1).toISOString(), data.streamId]);
  assert.equal((await callback(data.publishName)).status, 401);
  assert.equal(session(data.streamId).stream_key_hash, null);
  assert.equal(db.queryOne('SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ?', [data.streamId]).count, 0);
});

test('lost capability hash before delayed activation fails closed without usage or worker', async () => {
  const f = fixture();
  const { data } = await admission(f);
  assert.equal((await callback(data.publishName)).status, 200);
  db.run('UPDATE stream_sessions SET stream_key_hash = NULL WHERE id = ?', [data.streamId]);
  await settleActivation();
  assert.equal(session(data.streamId).status, 'stopped');
  assert.equal(db.queryOne('SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ?', [data.streamId]).count, 0);
  assert.equal(db.queryAll('SELECT * FROM usage_counters WHERE workspace_id = ?', [f.workspaceId]).length, 0);
});

test('persistent key cannot consume or stop Desk reservation, ep cannot resolve as device key', async () => {
  const f = fixture();
  const { data } = await admission(f);
  assert.equal((await callback(f.persistentKey)).status, 409);
  assert.equal((await callback(f.persistentKey, 'synthetic-client', true)).status, 200);
  assert.equal(session(data.streamId).status, 'reserved');
  // Even a contrived device hash match does not let ep names enter the legacy branch.
  db.run('UPDATE devices SET ingest_key_hash = ? WHERE id = ?', [hash('ep_' + 'a'.repeat(64)), f.deviceId]);
  assert.equal((await callback('ep_' + 'a'.repeat(64))).status, 401);
  await stop(f, data.streamId);
});

test('done uses exact capability hash and client identity despite persistent-key changes', async () => {
  const f = fixture();
  const { data } = await admission(f);
  assert.equal((await callback(data.publishName)).status, 200);
  await settleActivation();
  db.run('UPDATE devices SET ingest_key_hash = ? WHERE id = ?', [hash('new-persistent'), f.deviceId]);
  await callback(data.publishName, 'foreign', true);
  await callback(data.publishName, '', true);
  assert.equal(session(data.streamId).status, 'streaming');
  assert.equal((await callback(data.publishName, 'synthetic-client', true)).status, 200);
  assert.equal(session(data.streamId).stream_key_hash, null);
  assert.equal(session(data.streamId).status, 'stopped');
  assert.equal((await callback(data.publishName)).status, 401);
});

test('explicit stop and web revoke both null capability hash', async () => {
  const f = fixture();
  const first = (await admission(f)).data;
  assert.equal((await stop(f, first.streamId)).status, 200);
  assert.equal(session(first.streamId).stream_key_hash, null);
  const second = (await admission(f)).data;
  const result = await request(`/api/workspaces/${f.workspaceId}/devices/${f.deviceId}/revoke`, {
    method: 'POST', headers: { cookie: f.cookie, 'x-csrf-token': f.csrf }
  });
  assert.equal(result.status, 200);
  assert.equal(session(second.streamId).stream_key_hash, null);
  assert.equal((await admission(f)).status, 401);
});

test('streaming reconnect after admission expiry keeps fixed paid deadline and worker count', async () => {
  const f = fixture();
  const { data } = await admission(f);
  await callback(data.publishName);
  await settleActivation();
  const deadline = session(data.streamId).expires_at;
  db.run('UPDATE stream_sessions SET publish_capability_expires_at = ? WHERE id = ?', [new Date(Date.now() - 1).toISOString(), data.streamId]);
  assert.equal((await callback(data.publishName)).status, 200);
  await expireStreamingSessions();
  assert.equal(session(data.streamId).expires_at, deadline);
  assert.equal(db.queryOne('SELECT COUNT(*) AS count FROM stream_workers WHERE stream_session_id = ?', [data.streamId]).count, 1);
  // The fixed deadline is not renewed by monitor or reconnect, even with Pro.
  db.run('UPDATE stream_sessions SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1).toISOString(), data.streamId]);
  await expireStreamingSessions();
  assert.equal(session(data.streamId).stream_key_hash, null);
});

test('four selected targets exceed existing three-target ceiling; second broadcast denied', async () => {
  const over = fixture({ targets: 4 });
  assert.equal((await admission(over)).status, 400);
  assert.equal(sessions(over).length, 0);
  const f = fixture();
  const { data } = await admission(f);
  const other = fixture({ targets: 0 });
  db.run('UPDATE devices SET workspace_id = ? WHERE id = ?', [f.workspaceId, other.deviceId]);
  assert.equal((await admission(other)).status, 409);
  // Change selection to a fresh target to prove workspace ceiling independently.
  db.run('UPDATE custom_rtmp_targets SET selected = 0 WHERE workspace_id = ?', [f.workspaceId]);
  db.run(`INSERT INTO custom_rtmp_targets (id,workspace_id,name,stream_url,encrypted_stream_key,selected,created_at)
    VALUES (?, ?, 'new', 'rtmps://synthetic.invalid/live', ?, 1, ?)`, ['crt_second_' + sequence, f.workspaceId, encrypt('synthetic', process.env.ENCRYPTION_SECRET), new Date().toISOString()]);
  assert.equal((await admission(other)).status, 400);
  await stop(f, data.streamId);
});

test('each selected unconfigured Nango provider rejects entire grant with no external call', async () => {
  for (const provider of ['twitch', 'youtube', 'facebook']) {
    const f = fixture();
    const now = new Date().toISOString();
    const connection = 'conn_' + f.deviceId;
    db.run("INSERT INTO provider_connections (id,workspace_id,provider,status,updated_at) VALUES (?, ?, ?, 'connected', ?)", [connection, f.workspaceId, provider, now]);
    db.run(`INSERT INTO provider_targets (id,workspace_id,provider_connection_id,provider,external_id,name,selected,created_at)
      VALUES (?, ?, ?, ?, 'synthetic-id', 'synthetic', 1, ?)`, ['pt_' + f.deviceId, f.workspaceId, connection, provider, now]);
    assert.equal((await admission(f)).status, 400);
    assert.equal(sessions(f).length, 0);
  }
  assert.equal(externalCalls, 0);
});

test('URL/key/destination choices and malformed bodies are rejected', async () => {
  const f = fixture();
  for (const body of ['{"url":"rtmps://synthetic.invalid"}', '{"key":"synthetic"}', '{"destinations":[]}', 'null', '[]', 'bad']) {
    assert.equal((await admission(f, body)).status, 400);
  }
  assert.equal((await request('/api/device/publish-admission?destination=synthetic', { f, method: 'POST' })).status, 400);
  assert.equal(sessions(f).length, 0);
});

test('cookies denied, pending/invalid-expiry access denied, device rotate denied, retired start web-only', async () => {
  const f = fixture();
  for (const path of ['/api/device/publish-admission', '/api/device/publish-status']) {
    const method = path.endsWith('admission') ? 'POST' : 'GET';
    assert.equal((await request(path, { method, headers: { cookie: f.cookie, 'x-csrf-token': f.csrf } })).status, 401);
    assert.equal((await request(path, { f, method, headers: { cookie: f.cookie } })).status, 401);
  }
  assert.equal((await request(`/api/workspaces/${f.workspaceId}/devices/${f.deviceId}/ingest-key/rotate`, { f, method: 'POST' })).status, 403);
  assert.equal((await request(`/api/workspaces/${f.workspaceId}/streams/start`, { f, method: 'POST' })).status, 403);
  assert.equal((await request(`/api/workspaces/${f.workspaceId}/streams/start`, { method: 'POST', headers: { cookie: f.cookie, 'x-csrf-token': f.csrf } })).status, 410);
  db.run("UPDATE devices SET status = 'pending' WHERE id = ?", [f.deviceId]);
  assert.equal((await admission(f)).status, 401);
  db.run("UPDATE devices SET status = 'active' WHERE id = ?", [f.deviceId]);
  db.run("UPDATE device_sessions SET expires_at = 'invalid' WHERE device_id = ?", [f.deviceId]);
  assert.equal((await admission(f)).status, 401);
});

test('adversarial status exposes only enum counts, id/status and containment boolean', async () => {
  const f = fixture();
  const { data } = await admission(f);
  const poison = 'secret-rtmps-url-token-grant-last4';
  db.run("UPDATE stream_session_destinations SET status = 'failed', error_message = ?, broadcast_snapshot = ? WHERE stream_session_id = ?",
    [poison, JSON.stringify({ provider: 'facebook', cleanupState: 'pending', id: poison, streamKey: data.publishName }), data.streamId]);
  const original = workerManager.getDeliveryStatus;
  workerManager.getDeliveryStatus = () => ({ relayState: poison, bytesWritten: poison, lastProgressAt: poison });
  try {
    const result = await request('/api/device/publish-status', { f });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.data).sort(), ['cleanupPending', 'relay', 'stream', 'success']);
    assert.deepEqual(result.data.stream, { id: data.streamId, status: 'reserved' });
    assert.equal(result.data.relay.unknown, 1);
    assert.equal(result.data.cleanupPending, true);
    assert.ok(!JSON.stringify(result.data).includes(poison));
    assert.ok(!JSON.stringify(result.data).includes(data.publishName));
    assert.ok(!JSON.stringify(result.data).includes(hash(data.publishName)));
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(externalCalls, 0);
  } finally { workerManager.getDeliveryStatus = original; }
  // Synthetic poisoned cleanup data is not a real remote object; remove only in-memory test state.
  db.run('UPDATE stream_session_destinations SET broadcast_snapshot = NULL WHERE stream_session_id = ?', [data.streamId]);
  await stop(f, data.streamId);
});

test('migration allows duplicate stopped legacy hashes; open ephemeral hashes are unique', () => {
  const f = fixture({ targets: 0 });
  const now = new Date().toISOString();
  for (const suffix of ['a', 'b']) db.run(`INSERT INTO stream_sessions (id,workspace_id,device_id,status,stream_key_hash,created_at)
    VALUES (?, ?, ?, 'stopped', ?, ?)`, ['legacy_' + f.deviceId + suffix, f.workspaceId, f.deviceId, hash(f.persistentKey), now]);
  initDatabase();
  assert.equal(sessions(f).length, 2);
  const capHash = hash('ep_unique_synthetic');
  db.run(`INSERT INTO stream_sessions (id,workspace_id,device_id,status,stream_key_hash,publish_capability_expires_at,created_at)
    VALUES (?, ?, ?, 'reserved', ?, ?, ?)`, ['unique_' + f.deviceId, f.workspaceId, f.deviceId, capHash, future(), now]);
  assert.throws(() => db.run(`INSERT INTO stream_sessions (id,workspace_id,device_id,status,stream_key_hash,publish_capability_expires_at,created_at)
    VALUES (?, ?, ?, 'reserved', ?, ?, ?)`, ['duplicate_' + f.deviceId, f.workspaceId, f.deviceId, capHash, future(), now]));
  db.run("UPDATE stream_sessions SET status = 'stopped' WHERE id = ?", ['unique_' + f.deviceId]);
  assert.equal(session('unique_' + f.deviceId).stream_key_hash, null);
});

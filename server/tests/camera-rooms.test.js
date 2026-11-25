import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { CameraRooms, cameraSecurity } from '../src/camera-rooms.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = ':memory:';
process.env.ENCRYPTION_SECRET = 'synthetic-camera-test-secret-not-a-real-credential';
process.env.FAKE_WORKERS = 'true';
process.env.APP_BASE_URL = 'https://camera.example';
process.env.CAMERA_ROOMS_ENABLED = 'true';
const { handleRequest } = await import('../src/server.js');
const database = await import('../src/db.js');
database.initDatabase();
const fingerprint = Array(32).fill('AB').join(':');
const otherFingerprint = Array(32).fill('CD').join(':');
const sdp = fp => `v=0\r\na=fingerprint:sha-256 ${fp}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n`;
const device = { id: 'synthetic-camera-device', workspace_id: 'synthetic-camera-workspace', status: 'active' };
const deviceToken = 'synthetic-device-token';
const now = new Date().toISOString(), expires = new Date(Date.now() + 3600000).toISOString();
database.run("INSERT INTO workspaces (id,name,created_at) VALUES (?, 'Synthetic', ?)", [device.workspace_id, now]);
database.run("INSERT INTO devices (id,workspace_id,name,status,created_at) VALUES (?,?,'Synthetic','active',?)", [device.id, device.workspace_id, now]);
database.run('INSERT INTO device_sessions (id,device_id,refresh_token_hash,expires_at,refresh_token_expires_at,created_at) VALUES (?,?,?,?,?,?)',
  [crypto.createHash('sha256').update(deviceToken).digest('hex'), device.id, 'synthetic-refresh-hash', expires, expires, now]);

function fixture(options) {
  const store = new CameraRooms(options);
  const created = store.create(device, 'https://camera.example').room;
  return { store, created, room: store.get(created.id) };
}
function approved() { const f = fixture(); f.claim = f.store.claim(f.room, fingerprint); f.store.approve(f.room, f.claim); return f; }
function rejects(fn, marker) { assert.throws(fn, error => error.message === marker); }
async function request(url, { method = 'GET', body, headers = {}, native = false } = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  req.url = url; req.method = method;
  req.headers = { host: 'camera.example', origin: 'https://camera.example', ...headers };
  req.socket = { encrypted: !native, remoteAddress: '192.0.2.1' };
  const res = { headers: {}, status: 0, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers = {}) { this.status = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); },
    end(body = '') { this.body = String(body); } };
  await handleRequest(req, res);
  return { ...res, data: res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : null };
}
const auth = { authorization: `Bearer ${deviceToken}` };

test('room creation binds tenant/device, five-minute expiry, fragment-only capability', () => {
  let clock = 1000; const { store, room, created } = fixture({ now: () => clock });
  assert.equal(room.workspaceId, device.workspace_id); assert.equal(room.deviceId, device.id);
  assert.equal(Date.parse(created.expires_at), 301000);
  assert.equal(new URL(created.join_url).search, '');
  assert.equal(new URLSearchParams(new URL(created.join_url).hash.slice(1)).get('capability'), created.capability);
  assert.equal(room.capability, undefined);
  clock = 301000; rejects(() => store.get(created.id), 'CAMERA_ROOM_UNAVAILABLE'); assert.equal(store.rooms.size, 0);
});
test('room inventory and per-device pending generations are bounded', () => {
  const { store } = fixture({ maxRooms: 2 });
  rejects(() => store.create(device, 'https://camera.example'), 'CAMERA_ROOM_EXISTS');
  store.create({ ...device, id: 'second' }, 'https://camera.example');
  rejects(() => store.create({ ...device, id: 'third' }, 'https://camera.example'), 'CAMERA_CAPACITY');
});
test('retained room references cannot authorize claims or signaling after expiry', () => {
  let clock = 0;
  const { store, room, created } = fixture({ now: () => clock });
  const claim = store.claim(room, fingerprint); store.approve(room, claim);
  clock = 300000;
  for (const action of [() => store.claim(room, fingerprint), () => store.approve(room, claim),
    () => store.publisher(room, created.capability, claim.claim_id), () => store.signal(room, 'publisher', 'offer', { sdp: sdp(fingerprint) }),
    () => store.status(room, 'device'), () => store.revoke(room)]) rejects(action, 'CAMERA_ROOM_UNAVAILABLE');
});
test('single pending publisher rejects second claims and invalid fingerprints', () => {
  const { store, room } = fixture();
  rejects(() => store.claim(room, 'secret-like-untrusted-input'), 'CAMERA_FINGERPRINT_INVALID');
  const claim = store.claim(room, fingerprint); assert.match(claim.code, /^\d{6}$/);
  rejects(() => store.claim(room, fingerprint), 'CAMERA_CLAIM_CONFLICT');
  rejects(() => store.claim(room, otherFingerprint), 'CAMERA_CLAIM_CONFLICT');
});
test('approval binds exact claim and fingerprint, rejects replay', () => {
  const { store, room } = fixture(); const claim = store.claim(room, fingerprint);
  rejects(() => store.approve(room, { ...claim, fingerprint: otherFingerprint }), 'CAMERA_APPROVAL_MISMATCH');
  rejects(() => store.approve(room, { ...claim, claim_id: 'stale' }), 'CAMERA_APPROVAL_MISMATCH');
  assert.deepEqual(store.approve(room, claim), { ok: true });
  rejects(() => store.approve(room, claim), 'CAMERA_APPROVAL_MISMATCH');
});
test('capability alone cannot authorize signaling or recover winning claim', () => {
  const { store, room, created } = fixture(); const claim = store.claim(room, fingerprint);
  store.publisher(room, created.capability, claim.claim_id);
  rejects(() => store.publisher(room, created.capability), 'CAMERA_UNAUTHORIZED');
  rejects(() => store.publisher(room, 'wrong', claim.claim_id), 'CAMERA_UNAUTHORIZED');
  assert.equal(store.status(room, 'publisher').claim_id, undefined);
  assert.equal(store.status(room, 'device').code, claim.code);
  rejects(() => store.signal(room, 'publisher', 'offer', { sdp: sdp(fingerprint) }), 'CAMERA_NOT_APPROVED');
});
test('stale generations and revoked claims cannot be reused', () => {
  const { store, room, created, claim } = approved(); store.revoke(room);
  rejects(() => store.publisher(room, created.capability, claim.claim_id), 'CAMERA_REVOKED');
  rejects(() => store.approve(room, claim), 'CAMERA_APPROVAL_MISMATCH');
  const replacement = store.create(device, 'https://camera.example').room;
  assert.notEqual(replacement.id, created.id);
  rejects(() => store.publisher(store.get(replacement.id), created.capability, claim.claim_id), 'CAMERA_UNAUTHORIZED');
  assert.equal(room.offer, null); assert.deepEqual(room.candidates.publisher, []);
});
test('cross-device and cross-workspace access is forbidden', () => {
  const { store, room } = fixture();
  for (const wrong of [{ ...device, id: 'other' }, { ...device, workspace_id: 'other' }, { ...device, status: 'revoked' }]) rejects(() => store.device(room, wrong), 'CAMERA_FORBIDDEN');
});
test('SDP is limited to 32KiB bytes and approved DTLS fingerprint; no replay or reversed roles', () => {
  const { store, room } = approved();
  rejects(() => store.signal(room, 'publisher', 'offer', { sdp: sdp(otherFingerprint) }), 'CAMERA_APPROVAL_MISMATCH');
  rejects(() => store.signal(room, 'publisher', 'offer', { sdp: 'é'.repeat(17000) }), 'CAMERA_SDP_INVALID');
  rejects(() => store.signal(room, 'publisher', 'offer', { sdp: 'v=0\r\n' }), 'CAMERA_SDP_FINGERPRINT_INVALID');
  rejects(() => store.signal(room, 'device', 'answer', { sdp: sdp(otherFingerprint) }), 'CAMERA_SIGNAL_REPLAY');
  rejects(() => store.signal(room, 'device', 'offer', { sdp: sdp(fingerprint) }), 'CAMERA_FORBIDDEN');
  const exact = sdp(fingerprint) + ' '.repeat(32768 - Buffer.byteLength(sdp(fingerprint)));
  store.signal(room, 'publisher', 'offer', { sdp: exact });
  rejects(() => store.signal(room, 'publisher', 'offer', { sdp: exact }), 'CAMERA_SIGNAL_REPLAY');
  store.signal(room, 'device', 'answer', { sdp: sdp(otherFingerprint) }); assert.equal(room.phase, 'answered');
  rejects(() => store.signal(room, 'device', 'answer', { sdp: sdp(otherFingerprint) }), 'CAMERA_SIGNAL_REPLAY');
});
test('candidate queues, payloads, cursors and embedded SDP candidates are bounded', () => {
  const { store, room } = approved();
  store.signal(room, 'publisher', 'offer', { sdp: sdp(fingerprint) });
  const candidate = { candidate: 'candidate:synthetic', sdpMid: '0', sdpMLineIndex: 0 };
  for (const side of ['device', 'publisher']) {
    for (let i = 0; i < 64; i++) store.signal(room, side, 'candidate', { candidate });
    rejects(() => store.signal(room, side, 'candidate', { candidate }), 'CAMERA_CANDIDATE_LIMIT');
  }
  assert.equal(store.candidates(room, 'device', '0').candidates.length, 64);
  assert.deepEqual(store.candidates(room, 'publisher', '64'), { candidates: [], next: 64 });
  for (const cursor of ['65', '-1', '1.1', '01', 'NaN']) rejects(() => store.candidates(room, 'device', cursor), 'CAMERA_CURSOR_INVALID');
  rejects(() => store.signal(room, 'device', 'candidate', { candidate: { ...candidate, candidate: 'x'.repeat(2049) } }), 'CAMERA_CANDIDATE_INVALID');
  const f = approved();
  rejects(() => f.store.signal(f.room, 'publisher', 'offer', { sdp: sdp(fingerprint) + 'a=candidate:synthetic\r\n'.repeat(65) }), 'CAMERA_CANDIDATE_LIMIT');
  f.store.signal(f.room, 'publisher', 'offer', { sdp: sdp(fingerprint) + 'a=candidate:synthetic\r\n'.repeat(64) });
  rejects(() => f.store.signal(f.room, 'publisher', 'candidate', { candidate }), 'CAMERA_CANDIDATE_LIMIT');
});
test('strict Origin and HTTPS reject null, foreign, missing mutation origin and forged forwarding', () => {
  const req = { method: 'POST', headers: { host: 'camera.example', origin: 'https://camera.example' }, socket: { encrypted: true, remoteAddress: '192.0.2.1' } };
  assert.equal(cameraSecurity(req, process.env.APP_BASE_URL), process.env.APP_BASE_URL);
  for (const origin of [undefined, 'null', 'https://evil.example']) rejects(() => cameraSecurity({ ...req, headers: { ...req.headers, origin } }, process.env.APP_BASE_URL), 'CAMERA_ORIGIN_DENIED');
  rejects(() => cameraSecurity(req, 'http://camera.example'), 'CAMERA_HTTPS_REQUIRED');
  rejects(() => cameraSecurity({ ...req, headers: { ...req.headers, host: 'evil.example' } }, process.env.APP_BASE_URL), 'CAMERA_HTTPS_REQUIRED');
  rejects(() => cameraSecurity({ ...req, socket: { encrypted: false, remoteAddress: '192.0.2.1' }, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, process.env.APP_BASE_URL), 'CAMERA_HTTPS_REQUIRED');
  assert.equal(cameraSecurity({ ...req, socket: { encrypted: false, remoteAddress: '127.0.0.1' }, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, process.env.APP_BASE_URL), process.env.APP_BASE_URL);
  assert.equal(cameraSecurity({ ...req, method: 'GET', headers: { host: 'camera.example', 'sec-fetch-site': 'same-origin' } }, process.env.APP_BASE_URL), process.env.APP_BASE_URL);
  const split = { ...req, headers: { host: 'live.example', origin: 'https://account.example' } };
  assert.equal(cameraSecurity(split, 'https://live.example', false, 'https://account.example'), 'https://live.example');
  rejects(() => cameraSecurity({ ...split, headers: { ...split.headers, origin: 'https://evil.example' } }, 'https://live.example', false, 'https://account.example'), 'CAMERA_ORIGIN_DENIED');
});
test('HTTP contract with synthetic streams: auth, claim, code, approval, signaling, revoke', async () => {
  assert.equal((await request('/api/device/camera-rooms', { method: 'POST', body: {} })).status, 401);
  const created = await request('/api/device/camera-rooms', { method: 'POST', body: {}, headers: auth });
  assert.equal(created.status, 200); const room = created.data.room, base = `/api/camera/rooms/${room.id}`;
  const publisher = { authorization: `Bearer ${room.capability}` };
  const claiming = await request(`${base}/claim`, { method: 'POST', body: { fingerprint }, headers: publisher });
  assert.equal(claiming.status, 200); const claim = claiming.data;
  const pub = { ...publisher, 'x-camera-claim': claim.claim_id };
  assert.equal((await request(`${base}/claim`, { method: 'POST', body: { fingerprint }, headers: publisher })).status, 409);
  assert.equal((await request(`${base}/offer`, { method: 'POST', body: { sdp: sdp(fingerprint) }, headers: pub })).status, 409);
  assert.equal((await request(`${base}/status`, { headers: publisher })).status, 401);
  const status = await request(`${base}/status`, { headers: auth }); assert.equal(status.data.code, claim.code);
  assert.equal((await request(`${base}/approve`, { method: 'POST', body: { ...claim, fingerprint: otherFingerprint }, headers: auth })).status, 409);
  assert.equal((await request(`${base}/approve`, { method: 'POST', body: claim, headers: auth })).status, 200);
  assert.equal((await request(`${base}/offer`, { method: 'POST', body: { sdp: sdp(fingerprint) }, headers: pub })).status, 202);
  assert.equal((await request(`${base}/offer`, { headers: auth })).data.sdp, sdp(fingerprint));
  assert.equal((await request(`${base}/answer`, { method: 'POST', body: { sdp: sdp(otherFingerprint) }, headers: auth })).status, 202);
  assert.equal((await request(`${base}/answer`, { headers: pub })).data.sdp, sdp(otherFingerprint));
  assert.equal((await request(`${base}/candidate`, { method: 'POST', body: { candidate: { candidate: 'synthetic', sdpMid: '0', sdpMLineIndex: 0 } }, headers: pub })).status, 202);
  assert.equal((await request(`${base}/candidates?from=0`, { headers: auth })).data.next, 1);
  assert.equal((await request(`${base}/revoke`, { method: 'POST', body: {}, headers: auth })).status, 200);
  assert.equal((await request(`${base}/status`, { headers: auth })).data.phase, 'revoked');
  assert.equal((await request(`${base}/answer`, { headers: pub })).status, 410);
});
test('static join page is uncredentialed, strict CSP, no secrets embedded; script safety contract', async () => {
  const created = await request('/api/device/camera-rooms', { method: 'POST', body: {}, headers: auth });
  assert.equal(created.status, 200);
  const { id, capability } = created.data.room;
  const page = await request(`/camera/join/${id}`, { headers: { origin: undefined } });
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['permissions-policy'], 'camera=(self), microphone=()');
  for (const secret of [capability, deviceToken, 'NANGO_SECRET_KEY', 'contribution_key', 'provider_token']) assert.ok(!page.body.includes(secret));
  assert.match(page.body, /id="start"/); assert.match(page.body, /id="stop"/);
  assert.equal((await request('/camera/join/missing')).status, 404);
  const script = await request('/camera/camera.js'); assert.equal(script.status, 200);
  for (const pattern of [/getUserMedia/, /video\/h264/, /redirect: 'error'/, /credentials: 'omit'/, /pagehide/, /track\.stop\(\)/, /history\.replaceState/, /iceServers: \[\]/]) assert.match(script.body, pattern);
  assert.ok(!script.body.includes(capability));
  await request(`/api/camera/rooms/${id}/revoke`, { method: 'POST', body: {}, headers: auth });
});
test('marker-only failures, body limits, absent/cross origins and disabled gate do not leak input', async () => {
  const logs = []; const original = console.error; console.error = (...args) => logs.push(args);
  try {
    for (const options of [
      { method: 'POST', body: '{"private": secret-SDP-token-fingerprint', headers: auth },
      { method: 'POST', body: { private: 'secret'.repeat(10000) }, headers: auth },
      { method: 'POST', body: {}, headers: { ...auth, origin: 'null' } },
      { method: 'POST', body: {}, headers: { ...auth, origin: 'https://evil.example' } },
      { method: 'POST', body: {}, headers: { ...auth, origin: undefined } },
      { method: 'POST', body: {}, headers: { authorization: 'Bearer secret-SDP-token-fingerprint' } }
    ]) {
      const response = await request('/api/device/camera-rooms', options);
      assert.ok(response.status >= 400); assert.match(response.data.error, /^CAMERA_[A-Z_]+$/);
      assert.ok(!response.body.includes('secret')); assert.equal(response.headers['cache-control'], 'no-store');
    }
    process.env.CAMERA_ROOMS_ENABLED = 'false';
    assert.deepEqual((await request('/api/device/camera-rooms', { method: 'POST', body: {}, headers: auth })).data, { error: 'CAMERA_DISABLED' });
    assert.deepEqual(logs, []);
  } finally { console.error = original; process.env.CAMERA_ROOMS_ENABLED = 'true'; }
  for (const file of ['camera-rooms.js']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(!/console\.|nangoClient|workerManager|ffmpeg|child_process/.test(source));
  }
});
test('revoked owner device invalidates publisher access immediately', async () => {
  const created = await request('/api/device/camera-rooms', { method: 'POST', body: {}, headers: auth });
  assert.equal(created.status, 200); const room = created.data.room;
  database.run("UPDATE devices SET status = 'revoked' WHERE id = ?", [device.id]);
  assert.equal((await request(`/api/camera/rooms/${room.id}/claim`, { method: 'POST', body: { fingerprint }, headers: { authorization: `Bearer ${room.capability}` } })).status, 404);
});

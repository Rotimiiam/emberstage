import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { CameraRooms, cameraSecurity, installCameraRoutes } from '../src/camera-rooms.js';

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
async function request(url, { method = 'GET', body, headers = {}, native = false, peer = '192.0.2.1', handler = handleRequest } = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  req.url = url; req.method = method;
  req.headers = { host: 'camera.example', origin: 'https://camera.example', ...headers };
  req.socket = { encrypted: !native, remoteAddress: peer };
  const res = { headers: {}, status: 0, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers = {}) { this.status = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); },
    end(body = '') { this.body = String(body); } };
  await handler(req, res);
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

const liveHeaders = { host: 'live.emberstage.live', origin: 'https://live.emberstage.live' };
function guestHarness(options) {
  const store = new CameraRooms(options), routes = [];
  installCameraRoutes({ store, config: { CAMERA_PUBLIC_ORIGIN: 'https://camera.example', APP_BASE_URL: 'https://account.example' },
    addRoute: (method, path, handler) => routes.push({ method, regex: new RegExp(`^${path.replace(':id', '([^/]+)')}$`), handler }),
    authAndAuthorize: () => { throw new Error('Guest must not invoke account/device authentication'); },
    deviceActive: () => { throw new Error('Guest must not read device/workspace state'); },
    json: (res, data, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data));
    } });
  const handler = async (req, res) => {
    const pathname = new URL(req.url, 'https://live.emberstage.live').pathname;
    const route = routes.find(r => r.method === req.method && r.regex.test(pathname));
    assert.ok(route); req.params = { id: route.regex.exec(pathname)[1] }; await route.handler(req, res);
  };
  const send = (url, options = {}) => request(url, { ...options, handler, headers: { ...liveHeaders, ...options.headers } });
  const create = () => send('/api/camera/guest-rooms', { method: 'POST', body: {} });
  return { store, send, create };
}
const publisherCapability = room => new URLSearchParams(new URL(room.join_url).hash.slice(1)).get('capability');

test('guest creation has exactly two independent 256-bit capabilities, hashes only, no identity', async () => {
  const { store, create } = guestHarness({ now: () => 1000 });
  const response = await create(); assert.equal(response.status, 200);
  const room = response.data.room, publisher = publisherCapability(room);
  assert.deepEqual(Object.keys(response.data), ['room']);
  assert.deepEqual(Object.keys(room).sort(), ['expires_at', 'id', 'join_url', 'operator_capability']);
  for (const cap of [room.operator_capability, publisher]) assert.equal(Buffer.from(cap, 'base64url').length, 32);
  assert.notEqual(room.operator_capability, publisher); assert.notEqual(room.id, publisher);
  assert.equal(Date.parse(room.expires_at), 301000); assert.equal(new URL(room.join_url).search, '');
  const state = store.get(room.id);
  assert.equal(state.deviceId, undefined); assert.equal(state.workspaceId, undefined);
  assert.equal(state.operatorHash.length, 32); assert.equal(state.capabilityHash.length, 32);
  for (const cap of [room.operator_capability, publisher]) assert.ok(!JSON.stringify([...store.rooms]).includes(cap));
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('guest creation rejects ambient authority, untrusted origins/hosts and every nonempty body with markers only', async () => {
  const { send, store } = guestHarness(); const logs = [];
  const originals = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...args) => logs.push(args);
  try {
    for (const options of [
      { headers: { origin: undefined } }, { headers: { origin: 'null' } },
      { headers: { origin: 'https://account.example' } }, { headers: { origin: 'https://evil.example' } },
      { headers: { host: 'live.emberstage.live:443' } }, { headers: { host: 'account.example' } },
      { headers: { cookie: '' } }, { headers: { cookie: 'session=secret' } },
      { headers: { authorization: '' } }, { headers: { authorization: `Bearer ${deviceToken}` } },
      ...[undefined, '', 'null', '[]', '{"private":secret}', { device: 'secret' }, { workspace: 'secret' },
        { ip: '192.0.2.8' }, { url: 'https://evil.example' }, { key: 'secret' }].map(body => ({ body }))
    ]) {
      const response = await send('/api/camera/guest-rooms', { method: 'POST', body: {}, ...options });
      assert.ok(response.status >= 400); assert.match(response.data.error, /^CAMERA_[A-Z_]+$/);
      assert.ok(!response.body.includes('secret')); assert.equal(response.headers['cache-control'], 'no-store');
    }
    const created = await send('/api/camera/guest-rooms', { method: 'POST', body: {} });
    const room = created.data.room;
    await send(`/api/camera/rooms/${room.id}/status`, { headers: { authorization: `Bearer ${publisherCapability(room)}` } });
    assert.deepEqual(logs, []); assert.equal(store.rooms.size, 1);
  } finally { [console.log, console.warn, console.error] = originals; }
});

test('guest roles bind approval, code/status, offer/answer and candidate exchange without device authority', async () => {
  const { send, create } = guestHarness(); const room = (await create()).data.room;
  const base = `/api/camera/rooms/${room.id}`, op = { authorization: `Bearer ${room.operator_capability}` };
  const publisher = { authorization: `Bearer ${publisherCapability(room)}` };
  const claim = (await send(`${base}/claim`, { method: 'POST', body: { fingerprint }, headers: publisher })).data;
  assert.match(claim.code, /^\d{6}$/);
  const pub = { ...publisher, 'x-camera-claim': claim.claim_id };
  for (const headers of [publisher, pub, auth, {}]) {
    const status = await send(`${base}/status`, { headers }); assert.equal(status.status, 401);
    assert.ok(!status.body.includes(claim.code)); assert.ok(!status.body.includes(claim.claim_id));
    assert.equal((await send(`${base}/approve`, { method: 'POST', body: claim, headers })).status, 401);
    assert.equal((await send(`${base}/revoke`, { method: 'POST', body: {}, headers })).status, 401);
  }
  assert.equal((await send(`${base}/claim`, { method: 'POST', body: { fingerprint }, headers: op })).status, 403);
  assert.equal((await send(`${base}/claim`, { method: 'POST', body: { fingerprint }, headers: publisher })).status, 409);
  assert.equal((await send(`${base}/status`, { headers: op })).data.code, claim.code);
  assert.equal((await send(`${base}/offer`, { method: 'POST', body: { sdp: sdp(fingerprint) }, headers: pub })).status, 409);
  assert.equal((await send(`${base}/approve`, { method: 'POST', body: { ...claim, fingerprint: otherFingerprint }, headers: op })).status, 409);
  assert.equal((await send(`${base}/approve`, { method: 'POST', body: claim, headers: op })).status, 200);
  assert.equal((await send(`${base}/offer`, { method: 'POST', body: { sdp: sdp(fingerprint) }, headers: op })).status, 403);
  assert.equal((await send(`${base}/offer`, { method: 'POST', body: { sdp: sdp(otherFingerprint) }, headers: pub })).status, 409);
  assert.equal((await send(`${base}/offer`, { method: 'POST', body: { sdp: sdp(fingerprint) }, headers: publisher })).status, 401);
  assert.equal((await send(`${base}/offer`, { method: 'POST', body: { sdp: sdp(fingerprint) }, headers: pub })).status, 202);
  assert.equal((await send(`${base}/offer`, { headers: op })).data.sdp, sdp(fingerprint));
  assert.equal((await send(`${base}/offer`, { headers: pub })).status, 401);
  assert.equal((await send(`${base}/answer`, { method: 'POST', body: { sdp: sdp(otherFingerprint) }, headers: pub })).status, 401);
  assert.equal((await send(`${base}/answer`, { method: 'POST', body: { sdp: sdp(otherFingerprint) }, headers: op })).status, 202);
  assert.equal((await send(`${base}/answer`, { headers: pub })).data.sdp, sdp(otherFingerprint));
  const candidate = { candidate: 'candidate:1 1 udp 123 192.0.2.8 9000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  for (const headers of [pub, op]) assert.equal((await send(`${base}/candidate`, { method: 'POST', body: { candidate }, headers })).status, 202);
  for (const headers of [pub, op]) assert.equal((await send(`${base}/candidates?from=0`, { headers })).data.next, 1);
  assert.equal((await send(`${base}/status`, { headers: { ...op, origin: 'https://account.example' } })).status, 403);
});

test('guest ICE accepts only numeric UDP host candidates in trickle and embedded SDP', async () => {
  const { send, create } = guestHarness();
  const ready = async () => {
    const room = (await create()).data.room;
    const base = `/api/camera/rooms/${room.id}`;
    const publisher = { authorization: `Bearer ${publisherCapability(room)}` };
    const claim = (await send(`${base}/claim`, { method: 'POST', body: { fingerprint }, headers: publisher })).data;
    const pub = { ...publisher, 'x-camera-claim': claim.claim_id };
    const op = { authorization: `Bearer ${room.operator_capability}` };
    await send(`${base}/approve`, { method: 'POST', body: claim, headers: op });
    return { room, base, pub };
  };
  const live = await ready();
  await send(`${live.base}/offer`, { method: 'POST', body: { sdp: sdp(fingerprint) }, headers: live.pub });
  const host = { candidate: 'candidate:1 1 udp 2130706431 192.0.2.8 9000 typ host generation 0 network-id 1 network-cost 999', sdpMid: '0', sdpMLineIndex: 0 };
  assert.equal((await send(`${live.base}/candidate`, { method: 'POST', body: { candidate: host }, headers: live.pub })).status, 202);
  for (const candidate of [
    'candidate:1 1 udp 123 192.0.2.8 9000 typ srflx raddr 198.51.100.1 rport 8999',
    'candidate:1 1 udp 123 192.0.2.8 9000 typ prflx',
    'candidate:1 1 udp 123 192.0.2.8 9000 typ relay raddr 198.51.100.1 rport 8999',
    'candidate:1 1 udp 123 192.0.2.8 9000 typ host raddr 198.51.100.1 rport 8999',
    'candidate:1 1 tcp 123 192.0.2.8 9000 typ host tcptype active',
    'candidate:1 1 udp 123 phone.local 9000 typ host',
  ]) {
    const result = await send(`${live.base}/candidate`, { method: 'POST', body: { candidate: { ...host, candidate } }, headers: live.pub });
    assert.equal(result.status, 400, candidate);
    assert.deepEqual(result.data, { error: 'CAMERA_CANDIDATE_INVALID' });
    assert.ok(!result.body.includes('192.0.2.8'));
  }

  const embeddedRelay = await ready();
  const relaySdp = sdp(fingerprint).replace('m=video', 'a=candidate:1 1 udp 123 192.0.2.8 9000 typ relay raddr 198.51.100.1 rport 8999\r\nm=video');
  const rejected = await send(`${embeddedRelay.base}/offer`, { method: 'POST', body: { sdp: relaySdp }, headers: embeddedRelay.pub });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.data, { error: 'CAMERA_CANDIDATE_INVALID' });

  const embeddedHost = await ready();
  const hostSdp = sdp(fingerprint).replace('m=video', 'a=candidate:1 1 udp 2130706431 192.0.2.8 9000 typ host generation 0\r\nm=video');
  assert.equal((await send(`${embeddedHost.base}/offer`, { method: 'POST', body: { sdp: hostSdp }, headers: embeddedHost.pub })).status, 202);
});

test('guest unknown, expired and revoked are identical 404s; join HTML never reveals phase/capabilities', async () => {
  let clock = 0; const { send, create } = guestHarness({ now: () => clock });
  const expired = (await create()).data.room;
  clock = 1000; const revoked = (await create()).data.room;
  const headers = { authorization: `Bearer ${revoked.operator_capability}` };
  const page = await send(`/camera/join/${revoked.id}`, { headers: { origin: undefined } });
  assert.equal(page.status, 200);
  for (const value of ['waiting', revoked.operator_capability, publisherCapability(revoked)]) assert.ok(!page.body.includes(value));
  assert.equal((await send(`/api/camera/rooms/${revoked.id}/revoke`, { method: 'POST', body: {}, headers })).status, 200);
  clock = 300000;
  for (const id of [revoked.id, expired.id, 'missing']) {
    for (const [url, options] of [[`/camera/join/${id}`, {}], [`/api/camera/rooms/${id}/status`, { headers }],
      [`/api/camera/rooms/${id}/claim`, { method: 'POST', body: { fingerprint }, headers }],
      [`/api/camera/rooms/${id}/revoke`, { method: 'POST', body: {}, headers }]]) {
      const response = await send(url, options); assert.equal(response.status, 404);
      assert.deepEqual(response.data, { error: 'CAMERA_ROOM_UNAVAILABLE' });
    }
  }
});

test('guest cap, coarse-prefix rate bounds, map expiry and spoofed forwarding are bounded', () => {
  let clock = 0; const store = new CameraRooms({ now: () => clock });
  const peer = (ip, forwarded = '198.51.100.1') => ({ socket: { remoteAddress: ip }, headers: { 'x-forwarded-for': forwarded } });
  for (let i = 1; i <= 4; i++) store.createGuest(peer(`192.0.2.${i}`));
  rejects(() => store.createGuest(peer('192.0.2.99')), 'CAMERA_RATE_LIMIT');
  for (let i = 0; i < 4; i++) store.createGuest(peer(i % 2 ? '2001:db8:0:0::1' : '2001:0db8::2'));
  rejects(() => store.createGuest(peer('2001:db8::3')), 'CAMERA_RATE_LIMIT');
  for (let i = 1; i <= 4; i++) store.createGuest(peer('127.0.0.1', `198.51.100.${i}`));
  rejects(() => store.createGuest(peer('127.0.0.1', '198.51.100.99')), 'CAMERA_RATE_LIMIT');
  for (let i = 1; i <= 4; i++) store.createGuest(peer('127.0.0.1', `203.0.113.${i}`));
  rejects(() => store.createGuest(peer('127.0.0.1', '203.0.113.99')), 'CAMERA_RATE_LIMIT');
  for (let i = 1; i <= 4; i++) store.createGuest(peer('198.18.0.1', `192.0.2.${i}`));
  rejects(() => store.createGuest(peer('198.18.0.99', '203.0.113.8')), 'CAMERA_RATE_LIMIT');
  for (const key of store.guestClients.keys()) assert.match(key, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify([...store.guestClients]).includes('192.0.2'));
  clock = 300000; store.sweep(); assert.equal(store.guestClients.size, 0); assert.equal(store.rooms.size, 0);
  store.create(device, 'https://camera.example');
  for (let i = 0; i < 127; i++) store.createGuest(peer(`198.18.${i}.1`));
  rejects(() => store.createGuest(peer('203.0.113.1')), 'CAMERA_CAPACITY'); assert.equal(store.rooms.size, 128);
  const limiter = new CameraRooms();
  for (let i = 0; i < 128; i++) { const room = limiter.createGuest(peer(`198.19.${i}.1`)); limiter.rooms.delete(room.room.id); }
  rejects(() => limiter.createGuest(peer('203.0.113.1')), 'CAMERA_RATE_LIMIT'); assert.equal(limiter.guestClients.size, 128);
});

test('live vhost forwards only the phone camera control API through loopback TLS', () => {
  const deploy = readFileSync(new URL('../deploy/personal-aws/guest.sh', import.meta.url), 'utf8');
  const live = deploy.split("server_name live.emberstage.live;").at(-1)?.split("\n}")[0];
  assert.ok(live, 'live HTTPS vhost is present');
  assert.match(live, /location \^~ \/api\/camera\/\s*\{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3000;[\s\S]*?proxy_set_header Host live\.emberstage\.live;[\s\S]*?proxy_set_header X-Forwarded-Proto https;[\s\S]*?proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(live, /location \^~ \/camera\//);
});

test('main handler preserves guest credential rejection, live-origin admission and disabled gate', async () => {
  for (const headers of [{ ...liveHeaders, cookie: '' }, { ...liveHeaders, authorization: `Bearer ${deviceToken}` },
    { ...liveHeaders, origin: undefined }, { ...liveHeaders, origin: 'https://camera.example' }]) {
    assert.ok((await request('/api/camera/guest-rooms', { method: 'POST', body: {}, headers })).status >= 400);
  }
  const created = await request('/api/camera/guest-rooms', { method: 'POST', body: {}, headers: liveHeaders });
  assert.equal(created.status, 200);
  const room = created.data.room, headers = { ...liveHeaders, authorization: `Bearer ${room.operator_capability}` };
  assert.equal((await request(`/api/camera/rooms/${room.id}/status`, { headers })).status, 200);
  assert.equal((await request(`/api/camera/rooms/${room.id}/revoke`, { method: 'POST', body: {}, headers })).status, 200);
  assert.equal((await request(`/api/camera/rooms/${room.id}/status`, { headers })).status, 404);
  process.env.CAMERA_ROOMS_ENABLED = 'false';
  try {
    const response = await request('/api/camera/guest-rooms', { method: 'POST', body: {}, headers: liveHeaders });
    assert.equal(response.status, 503); assert.deepEqual(response.data, { error: 'CAMERA_DISABLED' });
  } finally { process.env.CAMERA_ROOMS_ENABLED = 'true'; }
});

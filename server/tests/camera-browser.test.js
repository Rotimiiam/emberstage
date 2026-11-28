import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { CameraRooms, installCameraRoutes } from '../src/camera-rooms.js';

const source = readFileSync(new URL('../public/camera.js', import.meta.url), 'utf8');
const origin = 'https://live.emberstage.live';
const fingerprint = Array(32).fill('AB').join(':');
const sdp = `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n`;
const candidate = { candidate: 'candidate:1 1 udp 2130706431 192.0.2.8 9000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
process.env.CAMERA_ROOMS_ENABLED = 'true';

async function fixture({ permissionDenied = false, ice = candidate, candidateCount = 1 } = {}) {
  let clock = 0;
  const store = new CameraRooms({ now: () => clock }), routes = [], requests = [];
  installCameraRoutes({ store, config: {},
    addRoute: (method, path, handler) => routes.push({ method, regex: new RegExp(`^${path.replace(':id', '([^/]+)')}$`), handler }),
    authAndAuthorize: () => assert.fail('Guest must not use account authentication'),
    deviceActive: () => assert.fail('Guest must not use device state'),
    json: (res, data, status = 200) => { res.writeHead(status); res.end(JSON.stringify(data)); }
  });
  async function send(url, { method = 'GET', headers = {}, body } = {}) {
    const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.method = method; req.url = url;
    req.headers = { host: new URL(origin).host, origin, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.socket = { encrypted: true, remoteAddress: '192.0.2.1' };
    const path = new URL(url, origin).pathname;
    const route = routes.find(r => r.method === method && r.regex.test(path));
    assert.ok(route, 'Only real installed camera routes are callable');
    req.params = { id: route.regex.exec(path)[1] };
    const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler(req, res);
    return { status: res.status, data: JSON.parse(res.body) };
  }
  const room = (await send('/api/camera/guest-rooms', { method: 'POST', body: {} })).data.room;
  const elements = Object.fromEntries(['start', 'stop', 'facing', 'status', 'code', 'preview'].map(id => [id, {
    disabled: false, textContent: '', value: 'environment', srcObject: null, listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }]));
  const timers = new Map(), windows = {}, peers = [], logs = [], historyCalls = [];
  let timerId = 0, stops = 0, offerCreates = 0;
  const track = { stop() { stops++; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  class Peer {
    constructor(config) { this.config = config; this.events = {}; this.remoteDescription = null; this.connectionState = 'new'; this.received = []; peers.push(this); }
    addEventListener(name, fn) { this.events[name] = fn; }
    addTransceiver(_, options) { this.transceiver = options; return { setCodecPreferences: codecs => { this.codecs = codecs; } }; }
    async createOffer() { offerCreates++; return { type: 'offer', sdp }; }
    async setLocalDescription(value) {
      this.localDescription = value;
      if (ice) for (let i = 0; i < candidateCount; i++) this.events.icecandidate({ candidate: { toJSON: () => ice } });
    }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate(value) { this.received.push(value); }
    close() { this.closed = true; }
  }
  let override, winningClaim;
  function browser() {
    const context = vm.createContext({
      document: { getElementById: id => elements[id] }, location: new URL(room.join_url),
      history: { replaceState: (...args) => historyCalls.push(args) }, URLSearchParams, AbortController,
      window: { isSecureContext: true, addEventListener: (name, fn) => { windows[name] = fn; } },
      navigator: { mediaDevices: { getUserMedia: async constraints => {
        assert.equal(constraints.audio, false);
        if (permissionDenied) throw Object.assign(new Error('private device detail'), { name: 'NotAllowedError' });
        return stream;
      } } },
      RTCPeerConnection: Peer, RTCRtpSender: { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }] }) },
      setTimeout: (fn, delay) => { assert.equal(delay, 1000); timers.set(++timerId, fn); return timerId; },
      clearTimeout: id => timers.delete(id),
      console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
      fetch: async (url, options) => {
        assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
        assert.ok(!url.includes('#') && !url.includes('capability'));
        assert.equal(options.headers.Authorization, `Bearer ${new URL(room.join_url).hash.slice('#capability='.length)}`);
        if (!url.endsWith('/claim')) assert.equal(options.headers['X-Camera-Claim'], winningClaim);
        if (options.signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' });
        const result = override ? override(url, options) : await send(url, options);
        if (url.endsWith('/claim') && result.status === 200) winningClaim = result.data.claim_id;
        requests.push({ action: url.split('/').pop(), method: options.method, status: result.status, signal: options.signal });
        return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.data };
      }
    });
    vm.runInContext(source, context, { filename: 'camera.js' });
    return elements.start.listeners.click();
  }
  const base = `/api/camera/rooms/${room.id}`;
  const operator = (action, body) => send(`${base}/${action}`, { method: body === undefined ? 'GET' : 'POST', body, headers: { authorization: `Bearer ${room.operator_capability}` } });
  return { browser, store, room, elements, requests, peers, timers, windows, logs, historyCalls, operator,
    get stops() { return stops; }, get offerCreates() { return offerCreates; },
    expire() { clock = 300000; }, override(fn) { override = fn; },
    async tick() { assert.equal(timers.size, 1); const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); }
  };
}

test('actual browser keeps claimed code and waits on answer approval, never operator status', async () => {
  const f = await fixture(); await f.browser();
  assert.match(f.elements.code.textContent, /^\d{6}$/);
  assert.deepEqual(f.requests.map(r => [r.action, r.status]), [['claim', 200], ['answer', 409]]);
  assert.match(f.elements.status.textContent, /Waiting for explicit approval/);
  assert.equal(f.stops, 0);
  await f.tick();
  assert.equal(f.requests.filter(r => r.action === 'offer').length, 0);
  assert.equal(f.store.get(f.room.id).candidates.publisher.length, 0);
  const claim = (await f.operator('status')).data;
  assert.equal((await f.operator('approve', claim)).status, 200);
  await f.tick();
  assert.equal(f.requests.filter(r => r.action === 'offer').length, 1);
  assert.equal(f.store.get(f.room.id).candidates.publisher.length, 1);
  assert.equal(f.offerCreates, 1);
  assert.equal((await f.operator('answer', { sdp })).status, 202);
  assert.equal((await f.operator('candidate', { candidate })).status, 202);
  await f.tick(); await f.tick();
  assert.equal(f.peers[0].remoteDescription.type, 'answer');
  assert.equal(f.peers[0].received.length, 1);
  assert.equal(f.requests.filter(r => r.action === 'offer').length, 1);
  assert.ok(f.requests.every(r => r.action !== 'status'));
  assert.equal(f.peers[0].codecs[0].mimeType, 'video/H264');
  assert.equal(f.peers[0].transceiver.direction, 'sendonly');
  assert.equal(f.peers[0].config.iceServers.length, 0);
  assert.equal(f.historyCalls[0][2], new URL(f.room.join_url).pathname);
  assert.deepEqual(f.logs, []);
});

for (const phase of ['waiting', 'answered']) for (const ending of ['expiry', 'revoke']) {
  test(`authoritative ${ending} stops tracks while ${phase}`, async () => {
    const f = await fixture(); await f.browser();
    if (phase === 'answered') {
      await f.operator('approve', (await f.operator('status')).data); await f.tick();
      await f.operator('answer', { sdp }); await f.tick();
    }
    if (ending === 'expiry') f.expire(); else await f.operator('revoke', {});
    await f.tick();
    assert.equal(f.requests.at(-1).status, 404);
    assert.equal(f.stops, 1); assert.ok(f.peers[0].closed);
    assert.equal(f.elements.preview.srcObject, null); assert.equal(f.timers.size, 0);
    assert.ok(f.requests.at(-1).signal.aborted);
    assert.match(f.elements.status.textContent, /Room ended or expired/);
  });
}

test('camera permission denied is distinct and never claims', async () => {
  const f = await fixture({ permissionDenied: true }); await f.browser();
  assert.match(f.elements.status.textContent, /Camera permission denied/);
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.logs, []);
});

test('a second actual browser claim is terminal, not permission failure or retry', async () => {
  const f = await fixture(); await f.browser();
  const firstCode = f.elements.code.textContent;
  f.windows.pagehide();
  await f.browser();
  assert.equal(f.requests.at(-1).status, 409);
  assert.match(f.elements.status.textContent, /already claimed/);
  assert.equal(f.stops, 2); assert.equal(f.timers.size, 0);
  assert.equal(f.store.get(f.room.id).claim.code, firstCode);
  assert.equal(f.requests.filter(r => r.action === 'claim').length, 2);
});

test('64 pending candidates flush only after approval; overflow stops before claiming', async () => {
  const f = await fixture({ candidateCount: 64 }); await f.browser();
  assert.equal(f.store.get(f.room.id).candidates.publisher.length, 0);
  await f.operator('approve', (await f.operator('status')).data); await f.tick();
  assert.equal(f.requests.filter(r => r.action === 'candidate').length, 64);
  assert.equal(f.store.get(f.room.id).candidates.publisher.length, 64);
  assert.equal(f.requests.filter(r => r.action === 'offer').length, 1);
  const overflow = await fixture({ candidateCount: 65 }); await overflow.browser();
  assert.equal(overflow.stops, 1); assert.equal(overflow.requests.length, 0);
  assert.equal(overflow.timers.size, 0); assert.match(overflow.elements.status.textContent, /Candidate limit/);
});

for (const [status, error] of [[409, 'CAMERA_APPROVAL_MISMATCH'], [400, 'CAMERA_NOT_APPROVED'], [401, 'CAMERA_UNAUTHORIZED'], [410, 'CAMERA_REVOKED'], [500, 'private payload']]) {
  test(`only exact answer 409/not-approved waits, not ${status}/${error}`, async () => {
    const f = await fixture(); await f.browser();
    f.override(() => ({ status, data: { error } })); await f.tick();
    assert.equal(f.stops, 1); assert.equal(f.timers.size, 0);
    assert.ok(!f.elements.status.textContent.includes(error)); assert.deepEqual(f.logs, []);
  });
}

test('lost approval after the one offer is terminal, never replayed', async () => {
  const f = await fixture(); await f.browser();
  await f.operator('approve', (await f.operator('status')).data); await f.tick();
  f.override(() => ({ status: 409, data: { error: 'CAMERA_NOT_APPROVED' } })); await f.tick();
  assert.equal(f.stops, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.requests.filter(r => r.action === 'offer').length, 1);
});

test('network failures stop without retries or raw diagnostic text', async () => {
  const f = await fixture(); await f.browser();
  f.override(() => { throw new Error('private transport diagnostic'); }); await f.tick();
  assert.equal(f.stops, 1); assert.equal(f.timers.size, 0);
  assert.match(f.elements.status.textContent, /Camera signaling failed/);
  assert.ok(!f.elements.status.textContent.includes('private')); assert.deepEqual(f.logs, []);
});

test('numeric LAN ICE policy is unchanged: mDNS candidate rejection is terminal', async () => {
  const f = await fixture({ ice: { ...candidate, candidate: candidate.candidate.replace('192.0.2.8', 'phone.local') } });
  await f.browser(); await f.operator('approve', (await f.operator('status')).data); await f.tick();
  assert.equal(f.requests.at(-1).status, 400); assert.equal(f.stops, 1);
  assert.match(f.elements.status.textContent, /numeric LAN ICE candidate/);
  assert.equal(f.store.get(f.room.id).candidates.publisher.length, 0);
});

for (const event of ['pagehide', 'beforeunload']) test(`${event} releases camera and aborts signaling`, async () => {
  const f = await fixture(); await f.browser(); f.windows[event]();
  assert.equal(f.stops, 1); assert.ok(f.peers[0].closed); assert.equal(f.timers.size, 0);
  assert.equal(f.elements.preview.srcObject, null); assert.ok(f.requests.at(-1).signal.aborted);
});

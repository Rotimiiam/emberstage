import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

const TTL = 5 * 60 * 1000;
const GUEST_ORIGIN = 'https://live.emberstage.live';
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const digest = value => crypto.createHash('sha256').update(value).digest();
const token = () => crypto.randomBytes(32).toString('base64url');
class CameraError extends Error {
  constructor(marker, status = 400) { super(marker); this.status = status; }
}
const fail = (marker, status) => { throw new CameraError(marker, status); };
// Guest media has no STUN/TURN path. Numeric host addresses are subsequently
// checked against the receiver's OS-selected on-link prefix by Desk.
function guestCandidate(text) {
  if (typeof text !== 'string' || text.length > 2048 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(text)) fail('CAMERA_CANDIDATE_INVALID');
  const p = text.split(' ');
  const decimal = (s, max, allowZero = false) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) && (allowZero || Number(s) > 0) && Number(s) <= max;
  if (p.length < 8 || (p.length - 8) % 2 || !/^candidate:[a-zA-Z0-9+/]{1,32}$/.test(p[0]) ||
      p[1] !== '1' || p[2].toLowerCase() !== 'udp' || !decimal(p[3], 0xffffffff) ||
      !net.isIP(p[4]) || p[4].includes('%') || !decimal(p[5], 65535) || p[6] !== 'typ' || p[7] !== 'host') fail('CAMERA_CANDIDATE_INVALID');
  const seen = new Set();
  for (let i = 8; i < p.length; i += 2) {
    if (seen.has(p[i]) || !['generation', 'network-id', 'network-cost', 'ufrag'].includes(p[i]) ||
        (p[i] === 'ufrag' ? !/^[a-zA-Z0-9+/]{4,256}$/.test(p[i + 1]) : !decimal(p[i + 1], 0xffffffff, p[i] === 'generation'))) fail('CAMERA_CANDIDATE_INVALID');
    seen.add(p[i]);
  }
}
const equal = (value, expected) => typeof value === 'string' && value.length <= 256 && crypto.timingSafeEqual(digest(value), expected);

// Deliberately volatile: restart invalidates every capability and generation.
export class CameraRooms {
  constructor({ now = Date.now, maxRooms = 128 } = {}) {
    this.now = now; this.maxRooms = Math.min(maxRooms, 128); this.rooms = new Map();
    this.guestClients = new Map(); this.prefixSalt = crypto.randomBytes(32);
  }
  sweep() {
    for (const [id, room] of this.rooms) if (room.deadline <= this.now()) this.rooms.delete(id);
    for (const [key, client] of this.guestClients) if (client.deadline <= this.now()) this.guestClients.delete(key);
  }
  guestLimit(req) {
    // The app accepts HTTPS forwarding only from loopback, and guest.sh's live
    // vhost overwrites X-Forwarded-For with nginx's $remote_addr. Trust exactly
    // one validated address only across that verified proxy boundary.
    const peer = req.socket?.remoteAddress;
    let ip = peer;
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && !forwarded.includes(',') && net.isIP(forwarded)) ip = forwarded;
    }
    if (typeof ip !== 'string' || !net.isIP(ip)) return;
    if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
    let prefix;
    if (net.isIP(ip) === 4) prefix = `v4:${ip.split('.').slice(0, 3).join('.')}`;
    else {
      const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
      const [left, right] = canonical.split('::');
      const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
      const parts = canonical.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
      prefix = `v6:${parts.slice(0, 4).map(p => p.padStart(4, '0')).join(':')}`;
    }
    const key = crypto.createHmac('sha256', this.prefixSalt).update(prefix).digest('hex');
    const client = this.guestClients.get(key);
    if (client) {
      if (client.count >= 4) fail('CAMERA_RATE_LIMIT', 429);
      client.count++;
    } else {
      if (this.guestClients.size >= 128) fail('CAMERA_RATE_LIMIT', 429);
      this.guestClients.set(key, { count: 1, deadline: this.now() + TTL });
    }
  }
  createGuest(req) {
    this.sweep();
    if (this.rooms.size >= this.maxRooms) fail('CAMERA_CAPACITY', 429);
    this.guestLimit(req);
    const id = token(), operator = token(), publisher = token(), deadline = this.now() + TTL;
    this.rooms.set(id, { id, guest: true, operatorHash: digest(operator), capabilityHash: digest(publisher), deadline,
      phase: 'waiting', claim: null, offer: null, answer: null, embeddedCandidates: { device: 0, publisher: 0 }, candidates: { device: [], publisher: [] } });
    return { room: { id, join_url: `${GUEST_ORIGIN}/camera/join/${id}#capability=${publisher}`,
      expires_at: new Date(deadline).toISOString(), operator_capability: operator } };
  }
  create(device, origin) {
    this.sweep();
    if (this.rooms.size >= this.maxRooms) fail('CAMERA_CAPACITY', 429);
    // One generation per device. Never silently replace an approved connection.
    if ([...this.rooms.values()].some(r => r.deviceId === device.id && r.phase !== 'revoked')) fail('CAMERA_ROOM_EXISTS', 409);
    const id = token(), capability = token(), deadline = this.now() + TTL;
    this.rooms.set(id, { id, deviceId: device.id, workspaceId: device.workspace_id, capabilityHash: digest(capability), deadline,
      phase: 'waiting', claim: null, offer: null, answer: null, embeddedCandidates: { device: 0, publisher: 0 }, candidates: { device: [], publisher: [] } });
    return { room: { id, join_url: `${origin}/camera/join/${id}#capability=${capability}`, expires_at: new Date(deadline).toISOString(), capability } };
  }
  get(id) { this.sweep(); const room = this.rooms.get(id); if (!room || (room.guest && room.phase === 'revoked')) fail('CAMERA_ROOM_UNAVAILABLE', 404); return room; }
  live(room) { if (this.get(room.id) !== room) fail('CAMERA_ROOM_UNAVAILABLE', 404); }
  device(room, device) {
    this.live(room);
    if (room.guest || !device || device.id !== room.deviceId || device.workspace_id !== room.workspaceId || device.status !== 'active') fail('CAMERA_FORBIDDEN', 403);
  }
  operator(room, capability) {
    this.live(room);
    if (!room.guest || !equal(capability, room.operatorHash)) fail('CAMERA_UNAUTHORIZED', 401);
  }
  publisher(room, capability, claimId, pending = false) {
    this.live(room);
    if (!equal(capability, room.capabilityHash)) fail('CAMERA_UNAUTHORIZED', 401);
    if (room.phase === 'revoked') fail('CAMERA_REVOKED', 410);
    if (!pending && (!room.claim || !equal(claimId, room.claim.idHash))) fail('CAMERA_UNAUTHORIZED', 401);
  }
  claim(room, fingerprint) {
    this.live(room);
    if (room.phase !== 'waiting' || room.claim) fail('CAMERA_CLAIM_CONFLICT', 409);
    if (typeof fingerprint !== 'string' || !fingerprintPattern.test(fingerprint)) fail('CAMERA_FINGERPRINT_INVALID');
    const claimId = token();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    room.claim = { id: claimId, idHash: digest(claimId), fingerprint, code };
    room.phase = 'pending';
    return { claim_id: claimId, code, fingerprint };
  }
  approve(room, body) {
    this.live(room);
    if (room.phase !== 'pending' || !room.claim || body.claim_id !== room.claim.id || body.fingerprint !== room.claim.fingerprint) fail('CAMERA_APPROVAL_MISMATCH', 409);
    room.phase = 'approved'; return { ok: true };
  }
  signal(room, side, kind, body) {
    this.live(room);
    if (!['approved', 'offered', 'answered'].includes(room.phase)) fail('CAMERA_NOT_APPROVED', 409);
    if (kind === 'offer' || kind === 'answer') {
      if ((kind === 'offer' && side !== 'publisher') || (kind === 'answer' && side !== 'device')) fail('CAMERA_FORBIDDEN', 403);
      if (room[kind] !== null || (kind === 'answer' && !room.offer)) fail('CAMERA_SIGNAL_REPLAY', 409);
      if (typeof body.sdp !== 'string' || !body.sdp.length || Buffer.byteLength(body.sdp) > 32768) fail('CAMERA_SDP_INVALID', 413);
      const fingerprints = [...body.sdp.matchAll(/^a=fingerprint:([^\r\n]+)\r?$/gm)].map(m => m[1]);
      if (!fingerprints.length || fingerprints.some(f => !/^sha-256 (?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f))) fail('CAMERA_SDP_FINGERPRINT_INVALID');
      if (kind === 'offer' && fingerprints.some(f => f !== `sha-256 ${room.claim.fingerprint}`)) fail('CAMERA_APPROVAL_MISMATCH', 409);
      if (room.guest) {
        // Split on CR as well as LF: no alternate line ending may conceal ICE.
        if (body.sdp.includes('\0') || /\r(?!\n)/.test(body.sdp)) fail('CAMERA_SDP_INVALID');
        for (const line of body.sdp.split(/\r?\n/)) {
          if (/^\s*a\s*=\s*candidate:/i.test(line)) {
            if (!line.startsWith('a=candidate:')) fail('CAMERA_CANDIDATE_INVALID');
            guestCandidate(line.slice(2));
          }
        }
      }
      const embedded = [...body.sdp.matchAll(/^a=candidate:/gm)].length;
      if (embedded + room.candidates[side].length > 64) fail('CAMERA_CANDIDATE_LIMIT', 429);
      room.embeddedCandidates[side] = embedded;
      room[kind] = body.sdp; room.phase = kind === 'offer' ? 'offered' : 'answered';
    } else {
      const c = body.candidate;
      if (!room.offer) fail('CAMERA_SIGNAL_ORDER', 409);
      if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || Buffer.byteLength(c.candidate) > 2048 ||
          !(c.sdpMid === null || (typeof c.sdpMid === 'string' && c.sdpMid.length <= 64)) ||
          !(c.sdpMLineIndex === null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 32))) fail('CAMERA_CANDIDATE_INVALID');
      if (room.candidates[side].length + room.embeddedCandidates[side] >= 64) fail('CAMERA_CANDIDATE_LIMIT', 429);
      if (room.guest) guestCandidate(c.candidate);
      room.candidates[side].push({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
    }
    return { ok: true };
  }
  candidates(room, side, from) {
    this.live(room);
    if (!['approved', 'offered', 'answered'].includes(room.phase)) fail('CAMERA_NOT_APPROVED', 409);
    if (!/^(?:0|[1-9][0-9]?)$/.test(from) || Number(from) > 64) fail('CAMERA_CURSOR_INVALID');
    const queue = room.candidates[side === 'device' ? 'publisher' : 'device'];
    if (Number(from) > queue.length) fail('CAMERA_CURSOR_INVALID');
    return { candidates: queue.slice(Number(from)), next: queue.length };
  }
  status(room, side) {
    this.live(room);
    return { phase: room.phase, expires_at: new Date(room.deadline).toISOString(),
      ...(side === 'device' && room.claim && room.phase !== 'revoked' ? { claim_id: room.claim.id, code: room.claim.code, fingerprint: room.claim.fingerprint } : {}) };
  }
  revoke(room) { this.live(room); room.phase = 'revoked'; room.claim = null; room.offer = room.answer = null; room.candidates = { device: [], publisher: [] }; return { ok: true }; }
}

export function cameraPath(pathname) { return pathname === '/api/device/camera-rooms' || pathname.startsWith('/api/camera/') || pathname.startsWith('/camera/'); }

export function guestCameraSecurity(req, navigation = false) {
  cameraSecurity(req, GUEST_ORIGIN, navigation, GUEST_ORIGIN);
  const sameOriginRead = req.method === 'GET' && req.headers.origin === undefined && req.headers['sec-fetch-site'] === 'same-origin';
  if (!navigation && req.headers.origin !== GUEST_ORIGIN && !sameOriginRead) fail('CAMERA_ORIGIN_DENIED', 403);
  return GUEST_ORIGIN;
}

export function guestCreateSecurity(req) {
  const origin = guestCameraSecurity(req);
  if (req.headers.cookie !== undefined || req.headers.authorization !== undefined) fail('CAMERA_UNAUTHORIZED', 401);
  return origin;
}

// Only trust TLS forwarding from a local TLS terminator, never arbitrary clients.
export function cameraSecurity(req, appBaseUrl, navigation = false, deviceOrigin = appBaseUrl) {
  let url;
  try { url = new URL(appBaseUrl); } catch { fail('CAMERA_HTTPS_REQUIRED', 503); }
  let device;
  try { device = new URL(deviceOrigin); } catch { fail('CAMERA_HTTPS_REQUIRED', 503); }
  if (device.protocol !== 'https:' || device.username || device.password || device.pathname !== '/' || device.search || device.hash) fail('CAMERA_HTTPS_REQUIRED', 503);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('CAMERA_HTTPS_REQUIRED', 503);
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  if (req.headers.host !== url.host || !(req.socket?.encrypted || (local && req.headers['x-forwarded-proto'] === 'https'))) fail('CAMERA_HTTPS_REQUIRED', 403);
  const origin = req.headers.origin;
  const allowed = new Set([url.origin, device.origin]);
  if (origin !== undefined && !allowed.has(origin)) fail('CAMERA_ORIGIN_DENIED', 403);
  if (!navigation && !allowed.has(origin) && !(req.method === 'GET' && req.headers['sec-fetch-site'] === 'same-origin')) fail('CAMERA_ORIGIN_DENIED', 403);
  return url.origin;
}

export function cameraError(res, error, json) {
  return json(res, { error: error instanceof CameraError ? error.message : 'CAMERA_INTERNAL_FAILURE' }, error instanceof CameraError ? error.status : 500, { 'Cache-Control': 'no-store' });
}

export function installCameraRoutes({ addRoute, authAndAuthorize, json, config, deviceActive, store = new CameraRooms() }) {
  const page = fs.readFileSync(new URL('../public/camera.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('../public/camera.js', import.meta.url), 'utf8');
  const font = fs.readFileSync(new URL('../public/camera-inter.ttf', import.meta.url));
  const fontLicense = fs.readFileSync(new URL('../public/camera-inter-license.txt', import.meta.url), 'utf8');
  const style = page.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  if (!style) throw new Error('CAMERA_STYLE_MISSING');
  const styleSource = `'sha256-${crypto.createHash('sha256').update(style).digest('base64')}'`;
  const wrap = (side, action, navigation = false) => async (req, res) => {
    try {
      if (process.env.CAMERA_ROOMS_ENABLED !== 'true') fail('CAMERA_DISABLED', 503);
      const room = req.params.id ? store.get(req.params.id) : undefined;
      const guestStatic = ['script', 'font', 'font-license'].includes(action) && req.headers.host === new URL(GUEST_ORIGIN).host;
      const origin = action === 'guest-create' ? guestCreateSecurity(req) : room?.guest || guestStatic ? guestCameraSecurity(req, navigation)
        : cameraSecurity(req, config.CAMERA_PUBLIC_ORIGIN, navigation, config.APP_BASE_URL);
      let device, guestOperator = false;
      if (room?.guest && side !== 'public') {
        const capability = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
        guestOperator = equal(capability, room.operatorHash);
        if (guestOperator) {
          if (side === 'publisher') fail('CAMERA_FORBIDDEN', 403);
          store.operator(room, capability);
        } else {
          if (side === 'device' || action === 'status') fail('CAMERA_UNAUTHORIZED', 401);
          store.publisher(room, capability, req.headers['x-camera-claim'], action === 'claim');
        }
      } else if (side === 'device' || (side === 'both' && !req.headers['x-camera-claim'])) {
        // Explicit bearer-only admission: cookies cannot fall back to operator authority.
        if (!/^Bearer [^\s]+$/.test(req.headers.authorization || '')) fail('CAMERA_UNAUTHORIZED', 401);
        const ctx = authAndAuthorize(req, res, { authRequired: true, authKind: 'device', rolesAllowed: ['operator'] });
        if (!ctx) return;
        if (ctx.type !== 'device' || ctx.device.status !== 'active') fail('CAMERA_FORBIDDEN', 403);
        device = ctx.device;
      }
      if (req.params.id) {
        if (!room.guest && !deviceActive(room.deviceId, room.workspaceId)) fail('CAMERA_ROOM_UNAVAILABLE', 404);
        if (device) store.device(room, device);
        else if (!room.guest && side !== 'public') {
          const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
          store.publisher(room, match?.[1], req.headers['x-camera-claim'], action === 'claim');
        }
      }
      let body = {};
      if (req.method === 'POST') {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 48 * 1024) fail('CAMERA_BODY_LIMIT', 413); chunks.push(Buffer.from(chunk)); }
        const raw = Buffer.concat(chunks).toString();
        if (action === 'guest-create' && !raw.trim()) fail('CAMERA_BODY_INVALID');
        try { body = JSON.parse(raw || '{}'); } catch { fail('CAMERA_BODY_INVALID'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('CAMERA_BODY_INVALID');
        if (action === 'guest-create' && Object.keys(body).length) fail('CAMERA_BODY_INVALID');
      }
      // Body reads yield: expiry, device revocation and bearer expiry must be
      // checked again immediately before synchronous state changes.
      if (room) {
        store.live(room);
        if (!room.guest && !deviceActive(room.deviceId, room.workspaceId)) fail('CAMERA_ROOM_UNAVAILABLE', 404);
      }
      if (device && req.method === 'POST') {
        const fresh = authAndAuthorize(req, res, { authRequired: true, authKind: 'device', rolesAllowed: ['operator'] });
        if (!fresh) return;
        if (fresh.type !== 'device' || fresh.device.status !== 'active') fail('CAMERA_FORBIDDEN', 403);
        device = fresh.device;
        if (room) store.device(room, device);
      }
      const actor = device || guestOperator ? 'device' : 'publisher';
      if (action === 'guest-create') return json(res, store.createGuest(req), 200, { 'Cache-Control': 'no-store' });
      if (action === 'create') return json(res, store.create(device, origin), 200, { 'Cache-Control': 'no-store' });
      if (['page', 'script', 'font', 'font-license'].includes(action)) {
        if (room?.phase === 'revoked') fail('CAMERA_REVOKED', 410);
        const types = { page: 'text/html; charset=utf-8', script: 'text/javascript; charset=utf-8', font: 'font/ttf', 'font-license': 'text/plain; charset=utf-8' };
        res.writeHead(200, { 'Content-Type': types[action],
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
          'Permissions-Policy': 'camera=(self), microphone=()', 'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src ${styleSource}; font-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
        return res.end(action === 'page' ? page : action === 'script' ? script : action === 'font' ? font : fontLicense);
      }
      let data, status = 200;
      if (action === 'claim') data = store.claim(room, body.fingerprint);
      else if (action === 'approve') data = store.approve(room, body);
      else if (action === 'revoke') data = store.revoke(room);
      else if (action === 'status') data = store.status(room, actor);
      else if (action === 'candidates') data = store.candidates(room, actor, new URL(req.url, origin).searchParams.get('from') ?? '0');
      else if (req.method === 'GET') {
        if (!['approved', 'offered', 'answered'].includes(room.phase)) fail('CAMERA_NOT_APPROVED', 409);
        data = { sdp: room[action] };
      } else { data = store.signal(room, actor, action, body); status = 202; }
      return json(res, data, status, { 'Cache-Control': 'no-store' });
    } catch (error) { return cameraError(res, error, json); }
  };
  // Custom wrappers use the existing device validator and disallow cookie auth.
  // Feature flag is the explicit authorization gate for the new device allowlist.
  const route = (method, path, side, action, nav = false) => addRoute(method, path, wrap(side, action, nav), null, false);
  route('POST', '/api/device/camera-rooms', 'device', 'create');
  route('POST', '/api/camera/guest-rooms', 'public', 'guest-create');
  route('GET', '/camera/join/:id', 'public', 'page', true);
  route('GET', '/camera/camera.js', 'public', 'script', true);
  route('GET', '/camera/inter.ttf', 'public', 'font', true);
  route('GET', '/camera/inter-license.txt', 'public', 'font-license', true);
  for (const [method, action, side] of [['POST','claim','publisher'], ['POST','approve','device'], ['POST','offer','publisher'],
    ['GET','offer','device'], ['POST','answer','device'], ['GET','answer','publisher'], ['POST','candidate','both'],
    ['GET','candidates','both'], ['POST','revoke','device'], ['GET','status','both']]) route(method, `/api/camera/rooms/:id/${action}`, side, action);
  return store;
}

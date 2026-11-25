import crypto from 'node:crypto';
import fs from 'node:fs';

const TTL = 5 * 60 * 1000;
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const digest = value => crypto.createHash('sha256').update(value).digest();
const token = () => crypto.randomBytes(32).toString('base64url');
class CameraError extends Error {
  constructor(marker, status = 400) { super(marker); this.status = status; }
}
const fail = (marker, status) => { throw new CameraError(marker, status); };
const equal = (value, expected) => typeof value === 'string' && value.length <= 256 && crypto.timingSafeEqual(digest(value), expected);

// Deliberately volatile: restart invalidates every capability and generation.
export class CameraRooms {
  constructor({ now = Date.now, maxRooms = 128 } = {}) { this.now = now; this.maxRooms = maxRooms; this.rooms = new Map(); }
  sweep() { for (const [id, room] of this.rooms) if (room.deadline <= this.now()) this.rooms.delete(id); }
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
  get(id) { this.sweep(); const room = this.rooms.get(id); if (!room) fail('CAMERA_ROOM_UNAVAILABLE', 404); return room; }
  live(room) { if (this.get(room.id) !== room) fail('CAMERA_ROOM_UNAVAILABLE', 404); }
  device(room, device) {
    this.live(room);
    if (!device || device.id !== room.deviceId || device.workspace_id !== room.workspaceId || device.status !== 'active') fail('CAMERA_FORBIDDEN', 403);
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
  const wrap = (side, action, navigation = false) => async (req, res) => {
    try {
      if (process.env.CAMERA_ROOMS_ENABLED !== 'true') fail('CAMERA_DISABLED', 503);
      const origin = cameraSecurity(req, config.CAMERA_PUBLIC_ORIGIN, navigation, config.APP_BASE_URL);
      let room, device;
      if (side === 'device' || (side === 'both' && !req.headers['x-camera-claim'])) {
        // Explicit bearer-only admission: cookies cannot fall back to operator authority.
        if (!/^Bearer [^\s]+$/.test(req.headers.authorization || '')) fail('CAMERA_UNAUTHORIZED', 401);
        const ctx = authAndAuthorize(req, res, { authRequired: true, authKind: 'device', rolesAllowed: ['operator'] });
        if (!ctx) return;
        if (ctx.type !== 'device' || ctx.device.status !== 'active') fail('CAMERA_FORBIDDEN', 403);
        device = ctx.device;
      }
      if (req.params.id) {
        room = store.get(req.params.id);
        if (!deviceActive(room.deviceId, room.workspaceId)) fail('CAMERA_ROOM_UNAVAILABLE', 404);
        if (device) store.device(room, device);
        else if (side !== 'public') {
          const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
          store.publisher(room, match?.[1], req.headers['x-camera-claim'], action === 'claim');
        }
      }
      let body = {};
      if (req.method === 'POST') {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 48 * 1024) fail('CAMERA_BODY_LIMIT', 413); chunks.push(Buffer.from(chunk)); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail('CAMERA_BODY_INVALID'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('CAMERA_BODY_INVALID');
      }
      // Body reads yield: expiry, device revocation and bearer expiry must be
      // checked again immediately before synchronous state changes.
      if (room) {
        store.live(room);
        if (!deviceActive(room.deviceId, room.workspaceId)) fail('CAMERA_ROOM_UNAVAILABLE', 404);
      }
      if (device && req.method === 'POST') {
        const fresh = authAndAuthorize(req, res, { authRequired: true, authKind: 'device', rolesAllowed: ['operator'] });
        if (!fresh) return;
        if (fresh.type !== 'device' || fresh.device.status !== 'active') fail('CAMERA_FORBIDDEN', 403);
        device = fresh.device;
        if (room) store.device(room, device);
      }
      const actor = device ? 'device' : 'publisher';
      if (action === 'create') return json(res, store.create(device, origin), 200, { 'Cache-Control': 'no-store' });
      if (action === 'page' || action === 'script') {
        if (room?.phase === 'revoked') fail('CAMERA_REVOKED', 410);
        res.writeHead(200, { 'Content-Type': action === 'page' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
          'Permissions-Policy': 'camera=(self), microphone=()', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        return res.end(action === 'page' ? page : script);
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
  route('GET', '/camera/join/:id', 'public', 'page', true);
  route('GET', '/camera/camera.js', 'public', 'script', true);
  for (const [method, action, side] of [['POST','claim','publisher'], ['POST','approve','device'], ['POST','offer','publisher'],
    ['GET','offer','device'], ['POST','answer','device'], ['GET','answer','publisher'], ['POST','candidate','both'],
    ['GET','candidates','both'], ['POST','revoke','device'], ['GET','status','both']]) route(method, `/api/camera/rooms/:id/${action}`, side, action);
  return store;
}

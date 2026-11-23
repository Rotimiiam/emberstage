# Phone camera — hosted signaling contract (build only)

**Not deployed. Disabled by default.** This backend only brokers bounded WebRTC
signaling. Phone video travels directly to the desk, which remains the RTMP
encoder. These routes never invoke relay workers, Nango or provider APIs. Camera
access/approval is independent of paid broadcast entitlement and cannot authorize
Program selection or publishing an RTMP stream.

## Shared contract for desk-io

Use the exact configured HTTPS `APP_BASE_URL` origin, with no trailing slash.
Every native desk API request must supply `Origin: https://<approved-host>` and
`Authorization: Bearer <existing-device-access-token>`. Only the room's active
device, in the same workspace, can approve/read offers/write answers/revoke.
Web-session cookies are never authority for camera routes.

Publisher requests use `Authorization: Bearer <room-capability>`. The claim request
is the **only** API request allowed without `X-Camera-Claim`. All later publisher
requests require `X-Camera-Claim: <claim_id>`, the unguessable winning claim handle;
the room capability alone cannot read status/signaling or impersonate the winner.
Never expose these values in diagnostics. Browser requests omit cookies and
reject all HTTP redirects. POSTs require exact Origin. Same-origin browser GETs
may omit Origin only with `Sec-Fetch-Site: same-origin`; native desk GETs must send
Origin. No CORS access for null, foreign, or arbitrary desk-file origins.

| Method/path | Authority | Request → response |
| --- | --- | --- |
| `POST /api/device/camera-rooms` | Device bearer | `{}` → `200 {room:{id,join_url,expires_at,capability}}` |
| `GET /camera/join/:id` | Public navigation | Existing, unexpired, non-revoked room → static HTML |
| `POST /api/camera/rooms/:id/claim` | Room capability | `{fingerprint}` → `200 {claim_id,code,fingerprint}` |
| `POST /api/camera/rooms/:id/approve` | Device bearer | `{claim_id,fingerprint}` → `200 {ok:true}` |
| `POST /api/camera/rooms/:id/offer` | Publisher + claim handle | `{sdp}` → `202 {ok:true}` |
| `GET /api/camera/rooms/:id/offer` | Device bearer | `200 {sdp:string|null}` |
| `POST /api/camera/rooms/:id/answer` | Device bearer | `{sdp}` → `202 {ok:true}` |
| `GET /api/camera/rooms/:id/answer` | Publisher + claim handle | `200 {sdp:string|null}` |
| `POST /api/camera/rooms/:id/candidate` | Either authenticated side | `{candidate:{candidate,sdpMid,sdpMLineIndex}}` → `202 {ok:true}` |
| `GET /api/camera/rooms/:id/candidates?from=0` | Either authenticated side | `200 {candidates:[...],next:number}`; reads the **other** side's queue |
| `POST /api/camera/rooms/:id/revoke` | Device bearer | `{}` → `200 {ok:true}` |
| `GET /api/camera/rooms/:id/status` | Either authenticated side | `200 {phase,expires_at}`; device additionally receives `{claim_id,code,fingerprint}` while a claim exists |

`GET /camera/camera.js` serves only fixed, uncredentialed application code.
No endpoint accepts a redirect URL or fetches a signaling/media URL supplied by
a client. `join_url` is built exclusively from the approved HTTPS origin. Its
capability is in the **fragment**, never the path/query/server access log; the page
immediately strips the fragment from browser history. Treat the complete QR/join
URL as sensitive. The HTML response never embeds a capability or device credential.

`fingerprint` is the phone peer's SHA-256 DTLS certificate fingerprint, exactly 32
uppercase hex byte pairs separated by colons. Before claiming, the phone creates
a local send-only video offer, then submits this fingerprint. The backend returns
a six-digit matching code. The desk must poll status and **display the code and
require explicit human comparison/approval**, sending the exact claim ID and
fingerprint obtained from device-authenticated status. No automatic approval.
The backend accepts the offer only when every SDP fingerprint is SHA-256 and
matches that approved phone fingerprint. A leaked join capability permits at most
one pending claim/denial of service, never silent takeover.

Phases: `waiting → pending → approved → offered → answered`; device revocation
sets `revoked`. `answered` proves only signaling exchange, **not** media delivery.
The phone must not submit an offer or candidates before approval. The desk waits
for a non-null offer, applies it, creates its answer and exchanges ICE candidates.
Queue ICE until the appropriate remote description exists. Retain the returned
`next` cursor; responses are non-destructive and bounded (no queue acknowledgments).
No renegotiation, second claim, second offer/answer or repeated approval is allowed.
Stop/revoke and create a fresh room for camera switching, reconnect or retries.

## Security/lifecycle decisions

- In-memory, single-process state only; no SQLite migration, signaling on disk or
  room recovery. Process restart invalidates all rooms/capabilities. Multi-node
  deployment requires separately reviewed shared state or affinity, not this build.
- Hard five-minute room/signaling lifetime, enforced again after asynchronous body
  reads. A room ID is its unique random generation; stale IDs/claims cannot authorize
  a replacement. One non-revoked room per device, one claim and one approved publisher
  per room; maximum 128 retained rooms globally. Expired entries are swept on access.
- 256-bit capability/room/claim randomness; only hashed capabilities and constant-time
  secret comparison. The device-only status supplies the winning claim to the desk.
- Every access checks owner device is still active. Device bearer expiry/revocation is
  rechecked immediately before mutations; tenant and device bindings are exact.
- SDP at most **32,768 UTF-8 bytes** each; request envelope at most 48 KiB; ICE at most
  **64 candidates per side**, including candidates embedded in SDP. Candidate text at
  most 2 KiB, mid at most 64 characters, line index 0–32. Cursors must be integers 0–64
  within the current remote queue. Unknown candidate fields are discarded.
- TLS is mandatory, including local tests via synthetic transport. TLS terminator
  forwarding is trusted only from loopback and only for exact `X-Forwarded-Proto:
  https`, with Host equal to the configured HTTPS origin. Never trust public client
  forwarding headers; do not broaden this gate without review.
- No camera CORS preflight bypass, cookie fallback, open redirects or null origins.
  Strict CSP (`script-src/connect-src 'self'`, no inline/eval), no framing, no referrer,
  no-store responses; microphone denied. No incoming media endpoints or TURN relay.
- New-path failures are fixed `CAMERA_*` markers. No capability, fingerprint, matching
  code, SDP, ICE, token, raw exception or media logging/auditing. Successful authenticated
  responses intentionally carry signaling and approval data; these are not diagnostics.
  Deployment must likewise suppress request/response body and Authorization logging.
- Phone Start explicitly requests selected rear/front camera, no audio. H.264 is
  preferred if available, not guaranteed. Stop/exit/expiry stops tracks and closes
  the peer. Stop is terminal for that page; request a fresh room. The desk must also
  close/remove its camera source on revoke, room expiry, disconnect or app exit.
  Revoking signaling cannot forcibly terminate an already established direct peer;
  both clients own media teardown. Expiry must never leave an orphan Program source.
- No configured STUN/TURN servers in this build. Direct host connectivity (usually
  same LAN) is all that can be assumed. Cross-NAT/mobile data connectivity, physical
  camera behavior, codec negotiation and desk rendering remain **unproven**. A future
  approved STUN configuration may aid NAT discovery; hosted media relay is excluded.

## Tests

`node --test tests/camera-rooms.test.js`: synthetic clocks, in-memory SQLite,
Readable request streams and mock response objects. No listeners, external network,
browser, camera, WebRTC execution, Nango or relay worker invocation.

## DEPLOY NOTICE — explicit operator authorization required

Nothing was deployed, committed or pushed. `CAMERA_ROOMS_ENABLED` defaults to disabled;
enabling it is a security-policy change, not a consequence of build authorization.

The exact extension needed to the device bearer allowlist in `README.md:42–52` is:

- `POST /api/device/camera-rooms`
- `POST /api/camera/rooms/:id/approve`
- `GET /api/camera/rooms/:id/offer`
- `POST /api/camera/rooms/:id/answer`
- `POST /api/camera/rooms/:id/candidate`
- `GET /api/camera/rooms/:id/candidates`
- `POST /api/camera/rooms/:id/revoke`
- `GET /api/camera/rooms/:id/status`

The build contains these gated handlers using the existing device bearer validator,
but **does not assume permission to enable this allowlist on a running service**.
An operator must authorize source publication/deployment, the explicit allowlist
extension and `CAMERA_ROOMS_ENABLED=true`, the exact HTTPS origin/TLS proxy exposure,
and a service restart (which invalidates all camera rooms). Stage and independently
review these controls first. No cloud resources, DNS, production secrets, Nango
configuration, RTMP keys, billing entitlements or production media paths need changing
for this design; any such mutation requires separate authorization.

Desk approval UI and preview-only camera-source integration must be reviewed before
enablement: match codes, do not auto-approve, and require a separate explicit desk
action for Program selection. Then authorize isolated physical-phone/desk connectivity
and H.264/media teardown testing. Synthetic passing tests do not prove those paths.
For visual/layout changes, use `@designer` with `public/camera.html` and the intended goal.

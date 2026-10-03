# Emberstage Commercial Control-Plane Server MVP

Emberstage is a robust, lightweight commercial control-plane server built to coordinate hardware pairing, billing, multi-tenant workspace management, and streaming setup/discovery.

## Static Account & Onboarding Portal
Emberstage includes a built-in, same-origin user and onboarding portal to visually manage your workspace.
- **Portal URL**: `http://127.0.0.1:3000/app` (or your local configured port)
- **Features**:
  - Sign up, register workspaces, and sign in.
  - View workspace plans, limits, and subscription states.
  - Upgrade to Pro through Paystack Checkout or open Paystack's hosted subscription management page.
  - Generate single-use, 10-minute device link pairing codes.
  - Review and revoke paired hardware encoders.
  - Manage streaming-provider connection setup separately from product sign-in.
  - Configure Custom RTMP destinations for the working relay MVP.

---

## Architectural & Infrastructure Design

### Managed-streaming boundary
Emberstage includes a single-node managed relay path:
- Each paired device uses a reusable contribution key, generated or rotated in the portal.
- NGINX-RTMP accepts the OBS publisher only after a loopback callback authorizes that key.
- One supervised `ffmpeg` process forwards the contribution to each selected destination.
- Nango manages Twitch, YouTube, and Facebook Page connections. OBS publishing automatically starts approved destinations; YouTube uses the selected bound broadcast, and Facebook creates a Page live video at activation and ends it on stop.
- Facebook provider lifecycle tests use mocked Meta responses. A real Page publishing test still requires Meta app setup, eligible Page permissions, and explicit approval; see [Facebook setup](../deploy/nango/README.md#facebook-pages).

### Single-Node SQLite-Only Architecture
- Emberstage is designed as a lightweight single-node server utilizing Node's native `node:sqlite` engine.
- To prevent database lockups and block states during concurrent transactions, the SQLite database is initialized with a robust `busy_timeout = 5000` configuration, automatically queuing read/write operations safely.
- **Dynamic Test Sandboxing**: Outside testing environments, Emberstage defaults to persistent SQLite storage (`navecue.db` / `emberstage.db`). During automated tests, database-URL configurations are overridden dynamically to run cleanly in memory.

### Host Binding & Deployment Architecture
- **Development**: The server defaults to binding exclusively to local loopback (`127.0.0.1`) to guarantee secure, sandboxed local-only operations.
- **Production**: In `NODE_ENV=production`, the server allows binding to public interfaces (`0.0.0.0`) **only when** the configured `APP_BASE_URL` is an HTTPS scheme and the configured `ENCRYPTION_SECRET` is set to a non-default secure secret. This validates deployment architecture configuration before opening network listeners.

---

## Security Framework

### 1. Restricted Authorization (Device Bearer Tokens)
- Device Bearer tokens are **denied by default** across all workspace administration, members, billing, audit records, and provider connection routes.
- Devices can only authorize on specific designated runtime routes:
  - GET `/api/device/bootstrap`
  - POST `/api/device/heartbeat`
  - GET `/api/workspaces/:workspaceId/streams/destinations`
  - POST `/api/workspaces/:workspaceId/streams/preflight`
  - POST `/api/workspaces/:workspaceId/streams/start`
  - POST `/api/workspaces/:workspaceId/streams/:streamId/stop`
  - GET `/api/workspaces/:workspaceId/streams/:streamId/status`
- All other endpoints require active same-origin web-sessions.

### 2. Double-Submit Cookie CSRF Validation
- Validates both the `_csrf` cookie and custom `X-CSRF-Token` headers securely against the web-session's encrypted `csrf_secret` using standard Node `crypto.timingSafeEqual`.

### 3. Hashed Credentials and Session Security
- User passwords are encrypted with `crypto.scrypt` with secure salts.
- Device authorization tokens are stored exclusively as `SHA-256` hashes at-rest.
- Rotating refresh tokens use transactional family validation; any replay attempt revokes the entire token family and terminates sessions instantly.

### 4. Google OpenID Connect (OIDC) Sign-In
- Supports fully compliant Google product-auth login, completely separate from streaming-provider OAuths.
- Uses Authorization Code Flow + PKCE S256 challenge validation + one-use state + nonce mapping.
- Verifies RS256 ID Token signatures against Google JWKS certificates natively using Node's `crypto.createPublicKey` format `jwk`.
- Rigorously validates standard claims (`iss`, `aud`, `exp`, `nonce`, and `email_verified`).
- Auto-provisions user profile + memberships + workspace atomically upon the first successful Google login if the email is entirely unique.
- **Never Auto-Links Accounts**: If the email is already registered on password-auth, auto-linking is strictly prohibited. Users must explicitly authenticate and link their Google profiles under their session settings.
- Provides dynamic unlinking to delete identity credentials.

---

## Getting Started

### Prerequisites
- Node.js v24.18.0 or later (uses native `node:sqlite` and ES Modules).
- NGINX with the nginx-rtmp module and FFmpeg for managed streaming.
- A dedicated OS service account for the control plane and relay workers.

### Local Installation & Start
1. Copy the example configuration to your local environment file:
   ```bash
   cp .env.example .env
   ```
2. Launch the loopback-bound server:
   ```bash
   npm start
   ```
3. Navigate your browser to:
   ```
   http://127.0.0.1:3000/app
   ```

### Managed streaming setup

1. Start with `../docs/nginx-rtmp.conf.example`; keep its callback endpoints on loopback.
2. Set `CONTRIBUTION_INGEST_URL` to the local NGINX application and `RTMP_INGEST_BASE_URL` to the endpoint OBS can reach.
3. Set `FFMPEG_PATH` to an absolute production path. `FAKE_WORKERS=true` is test-only and never sends media.
4. Terminate TLS in front of NGINX for a public deployment and advertise an `rtmps://` ingest URL. Port 1935 by itself is plain RTMP.
5. In the Emberstage Streaming dock, pair the device with a short link code from the Emberstage Portal, select ready destinations, and choose **Prepare Stream**.
6. For the current browser-dock integration, open OBS **Settings → Stream**, choose **Custom**, and paste the one-time server and stream key shown by the dock. Start Streaming in OBS; the dock detects the ingest callback, changes to **Live**, and enables **End**. A future native OBS account integration can automate this one-time handoff without changing the control-plane flow.

### Paystack billing setup

**Product boundary:** Free Local Core includes the offline Scripture/text, media,
camera and OBS output tools. Pro is **NGN 3,000 per month per workspace**, with up to
three paired OBS devices and one active broadcast distributed to up to three
destinations. It pays for software/control-service access, **not unlimited hosted
relay bandwidth**. Provider approval and platform streaming eligibility are
separate from an Emberstage subscription.

1. Confirm that the intended Paystack merchant account is approved to collect
   **NGN recurring payments**. International-card acceptance alone does not prove
   NGN collection or NGN subscription eligibility. Do not reuse another
   business's credentials.
2. Create a **monthly NGN plan for 300000 minor units** in Paystack test mode. Configure
   `PAYSTACK_PLAN_CODE`, `PAYSTACK_PLAN_AMOUNT=300000`, `PAYSTACK_CURRENCY=NGN`, and
   the corresponding `PAYSTACK_SECRET_KEY` in the private server environment.
   Never put the secret key in the site, OBS assets, screenshots or source control.
3. Set `APP_BASE_URL` to the control plane's public HTTPS origin. Configure the
   Paystack webhook URL as `https://<control-plane-host>/api/billing/webhook`.
   A localhost URL, or the separate Nango OAuth redirect, is not a publicly
   reachable Paystack webhook endpoint.
4. Verify checkout, the server-side return verification, signed webhooks,
   cancellation and renewal with the test key and matching test plan. The
   provider's plan amount overrides the transaction initialization amount, so
   both must match the advertised price. Do not silently substitute a USD plan
   or perform an undisclosed exchange-rate conversion.
5. Before enabling live checkout, verify merchant ownership, NGN subscription
   eligibility, the live key/plan environment, the exact amount and monthly
   interval, and public webhook reachability. Live charges require separate
   approval; passing mocked tests does not establish live-payment readiness.

#### Enforcement and operational safety

- Billing belongs to a workspace. Only owners and finance members can initiate
  checkout or manage its subscription; operators can inspect its status.
- A browser redirect and `subscription.create` are not proof of payment.
  Entitlement requires a server-verified successful transaction bound to a
  stored checkout reference or an already correlated subscription. Customer
  email/code alone must never select a workspace.
- Payment amount, currency, plan and test/live environment must match. Duplicate
  notifications cannot extend access twice. Uncorrelated subscription events
  remain pending rather than guessing which workspace they belong to.
- Access is bounded by a paid-through timestamp, not a permanent `active` flag.
  Cancellation preserves paid time; failed renewal does not erase time already
  purchased. Missing billing evidence must not silently migrate a legacy
  `stripe_status=active` row into an indefinite paid entitlement.
- Admission must be enforced at actual OBS publishing, not just in the portal.
  Stream keys identify devices; they are not perpetual licenses. Device and
  broadcast slots require atomic reservations.
- After paid access expires, no new paid broadcasts are admitted. An already
  live broadcast may finish for at most two hours after expiry; an unused
  reservation does not qualify. Reconnects within the same active session
  must not renew that deadline. Stopping must use the normal relay/provider
  cleanup path, never terminate OBS or interrupt local recording/output tools.
- Keep sign-in, billing recovery, status, stopping and disconnection available
  after expiry. Preserve settings and device registrations for reactivation.
- Enforcement is authoritative only on a service Emberstage controls. An owner
  with editable self-hosted code/database can remove local license checks;
  signed grants cannot make an owner-controlled relay tamper-proof.

Before rolling this out to a running installation, stop its broadcasts, back up
the database, and verify migration and expiry behaviour against an isolated
copy. Do not infer paid entitlement from previous synthetic streaming tests.

Official integration reference: [Paystack subscriptions](https://paystack.com/docs/payments/subscriptions/).

### Auth0 OpenID Connect (OIDC) Sign-In Setup

To configure Auth0 as your product authentication provider:

1. Create a regular web application in your Auth0 tenant.
2. Set the Allowed Callback URLs to:
   `http://127.0.0.1:3000/api/auth/auth0/callback` (for local development)
3. Set the following environment variables in your server `.env` file:
   - `AUTH0_DOMAIN`: Your Auth0 domain (e.g. `your-tenant.us.auth0.com`). Do not include protocol prefixes (`https://`) or trailing slashes.
   - `AUTH0_CLIENT_ID`: Your Auth0 client ID.
   - `AUTH0_CLIENT_SECRET`: Your Auth0 client secret.
   - `AUTH0_REDIRECT_URI`: The callback URI registered in Auth0 (e.g. `http://127.0.0.1:3000/api/auth/auth0/callback`).

NGINX callback routes reject non-loopback clients. Relay stdout/stderr is discarded to prevent pipe backpressure, and startup/shutdown reconciliation terminates only FFmpeg processes bearing Emberstage's per-worker ownership marker. Run the service under a dedicated user; same-user process inspection is within that host trust boundary.

### Running Integration Tests
Execute the comprehensive test suite locally:
```bash
npm test
```

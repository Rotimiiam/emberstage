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

1. Create a recurring Paystack plan and set `PAYSTACK_PLAN_CODE`, `PAYSTACK_PLAN_AMOUNT` (currency subunit), and `PAYSTACK_CURRENCY`.
2. Set `PAYSTACK_SECRET_KEY` and a public HTTPS `APP_BASE_URL`.
3. Configure the Paystack webhook URL as `https://<control-plane-host>/api/billing/webhook`.
4. Test-mode checkout and signed webhooks use the same flow as production; only the Paystack key and plan code change.

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

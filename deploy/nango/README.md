# Emberstage self-hosted Nango

This is a local/private Nango Community deployment for evaluating managed OAuth credentials without Nango Cloud's connection quota. It uses Nango Server, PostgreSQL, and Redis; Elasticsearch logging is disabled.

## Local start

```bash
cp .env.example .env
# Fill the three blank secrets, then:
docker compose -p emberstage-nango up -d
```

The API binds to `127.0.0.1:3003` and Connect UI to `127.0.0.1:3009`. PostgreSQL and Redis are not exposed on the host.

If Compose is unavailable locally, run from this directory with a containerized CLI:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" docker:29-cli \
  compose -p emberstage-nango up -d
```

Keep the host and container paths identical: Compose resolves `./nango-data` for the Docker daemon, not the CLI container. Mapping this directory to `/workspace` would store the database under `/workspace/nango-data` on the Docker host instead. On Apple Silicon the pinned AMD64 image runs under emulation and can take several minutes to start. Check `http://127.0.0.1:3003/health` before using it.

## Production boundary

- Put both public endpoints behind HTTPS before provider callbacks are configured.
- Back up `nango-data/` and the encryption key together; neither is useful without the other.
- Keep `NANGO_ENCRYPTION_KEY` stable for the life of the database.
- Replace the pinned Nango image digest only through a reviewed upgrade.
- This stack does not expose Nango directly to Emberstage devices. Only the Emberstage control plane may use Nango's secret API.

Emberstage's control plane uses Nango for Twitch, YouTube, and Facebook Page connections. Set `NANGO_BASE_URL`, `NANGO_CONNECT_BASE_URL`, and the server-only `NANGO_SECRET_KEY` as described in `server/.env.example`. Self-hosting removes the Nango Cloud connection quota, not provider approval requirements or infrastructure limits.

## Facebook Pages

1. Create/configure a Meta developer app with Facebook Login and the Page/Live Video capabilities required by your app's use case. Use an account with permission to create content on the intended Page; personal-profile and Group streaming are not supported by this connector.
2. Add the exact callback URL shown by your self-hosted Nango integration to Meta's valid OAuth redirect URIs. The local Nango callback is `http://127.0.0.1:3003/oauth/callback`; if Meta rejects loopback HTTP for your configuration, use an HTTPS Nango endpoint and update its public URL consistently. Never substitute the Emberstage portal callback.
3. In Nango, create a Facebook integration with ID `facebook` (or set `NANGO_FACEBOOK_INTEGRATION_ID` to its ID), and enter the Meta app ID and secret there—not in a dock or browser storage. Request `pages_show_list,pages_read_engagement,pages_manage_posts`.
4. From the Emberstage portal, connect Facebook, approve the intended Pages, and select the Page destination. Reconnect if the existing grant is missing a required Page or permission.
5. **Starting Streaming in OBS publishes to selected Facebook Pages automatically.** Discovery and selection do not create a live video. Use a dedicated test Page and explicitly approve a publishing test; do not assume a Page broadcast is private. Stopping the stream ends the associated Facebook live video.

`FACEBOOK_API_VERSION` defaults to `v25.0` and is configurable server-side. Meta controls account/Page eligibility, Live access, app roles in Development mode, and App Review/Advanced Access for use by people outside the app's roles; business verification may also be required. Successful mocked tests do not establish that an app or Page has these approvals.

### Page lifecycle and recovery

- Discovery reads only `id,name,tasks` from `/me/accounts`, using the workspace-owned Nango User token in an Authorization header. Only the documented `CREATE_CONTENT` Page task qualifies; `MODERATE`, `ANALYZE`, and historical profile permissions do not. Pagination is bounded to 20 requests and reconstructed from cursors on `graph.facebook.com`, never followed directly from `paging.next`.
- On admitted OBS publish—not connect, select, preflight, or polling—the server freshly verifies Page membership and publishing permission, obtains **only that Page's** token via `/{page-id}?fields=id,access_token`, and creates `/{page-id}/live_videos` with `status=LIVE_NOW`. **Each new streaming session creates a new Page broadcast; this is not a reconnect/resume system.**
- Before starting FFmpeg, the session destination stores an authenticated, immutable binding of workspace, session, destination, local target, external Page ID, Nango connection ID, and live-video ID. Its initial status is `created`, not proof of being live. No User/Page token, stream key, or ingest URL is stored in that snapshot. Keep `ENCRYPTION_SECRET` stable: it also authenticates these ownership bindings.
- Stop, failed activation, unexpected relay exit, startup recovery, and graceful shutdown attempt to end only the bound session-created video, using the original workspace-owned Nango connection and the snapshot's Page ID even if a target was removed. A malformed ingest URL with a returned video ID is ended using the same in-memory Page token; failed cleanup preserves that non-secret ID for retry.
- Cleanup failure leaves the destination `failed` with its snapshot and a sanitized pending-cleanup error, even if local streaming is already stopped. Retry the stream's **Stop** action after restoring the original connection/Page permission. Startup retries pending cleanup even when no worker was ever spawned. Provider disconnect is blocked while reserved/streaming or cleanup is pending; another broadcast for the affected Page is blocked until cleanup succeeds.
- Invalid/copied/legacy unsigned snapshots fail closed rather than guessing a Page from mutable targets. They require operator verification and recovery. A hard crash/network timeout between Meta accepting creation and the server receiving/persisting the ID cannot be automatically recovered; inspect the Page in Meta before retrying. This implementation does not claim atomicity with Meta or verified end-to-end media delivery.

### Status contract for the portal and OBS dock

Use the existing `/streams/setup`, `/streams/:streamId/status`, and `/api/device/stream-status` responses. Facebook `delivery.broadcastState` (also `broadcastStatus`) comes only from a scoped `GET /{live-video-id}?fields=id,status,permalink_url`; failure or an unrecognized state yields `unknown`. `relayState` is local encoder progress; **`receiving` remains `unknown`**, including when the Meta object reports `LIVE`. Responses expose only allowlisted remote fields, never the full provider payload or signed snapshot. Display `cleanupPending` distinctly from a locally stopped encoder, and retain the Stop/retry action. Surface `goLiveWarning` before selecting/starting a Page; a Page broadcast must not be presented as private.

LiveVideo read-field names are also defined in Meta's [generated SDK](https://github.com/facebook/facebook-php-business-sdk/blob/main/src/FacebookAds/Object/Fields/LiveVideoFields.php). Direct Meta reference fetches may be unavailable; the mocked tests verify our request/response handling, **not** live app approval or Page eligibility. No external Meta, Nango, or OBS changes are made by these tests.

References: [Page live videos](https://developers.facebook.com/docs/graph-api/reference/page/live_videos/), [Live Video API](https://developers.facebook.com/docs/video-api/guides/live-api/), [permissions](https://developers.facebook.com/docs/permissions/), [Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/).

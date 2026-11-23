# Dedicated personal AWS account portal

## Live ANIMATION_37 release (2026-11-23)

Current release: `eb562d6c51dfabc39dbc07ed1c1082fbec2e57796d45a161e4d6a68a311dc542`.
User authorized latest Stitch mark, screen `f7283884e7bb4fb7b4ea8f45c18dd926`,
ANIMATION_37 SVG/CSS3.6s. Strict-host SSH verified ec825031 current before OLD
update. Manager105.127.9.4/32 unchanged; all prior ingress retained/no SG mutation.
Guest-built23-file bundle overlaid only local app.html/css/js; app.js already
matched live, so only app.html/css actually differed. All other21 files exact.
Executed bounded transaction once; script SHA256
`44cfdc5fdb49efc5f88d999d15abc6a0d9edfe3b5912c7665d5153066205cd84`.
All backup/source/DB-secret-config/asset-hash/COMMITTED markers accepted; independent
DB inode/integrity, root secret/config and exact manifests preserved. Six public
200+hash and auth/billing-unconfigured/cross-origin403/callback403/camera503/closed
3000/1935/TLS/redirect gates passed. Service stable20seconds/zero automatic restarts;
timers active/enabled; measured restart verification626ms. No customer writes,
server/src changes, feature enablement, commit/push or cloud-to-Mac file relay.
Guest artifacts/previous releases retained; root600 journal:
`/var/backups/emberstage/static-release-eb562d6c51dfabc39dbc07ed1c1082fbec2e57796d45a161e4d6a68a311dc542.json`.
Browser visual acceptance remains parent-owned.

## Live preload correction (2026-11-23)

Historical release: `ec82503100eca6fc37926a6f421dd2e424ae0c9eb554f718aa218fb84be7dab4`.
User authorized the designer's full-screen preload/fade/reduced-motion correction.
Strict-host SSH verified previous current `30acec8d...` before updating OLD.
Manager remains105.127.9.4/32; existing ingress verified, no additional SG mutation.
Built 23-file bundle on guest from that live release, overlaying only local
app.html/css/js. Independent final manifests prove every other file unchanged;
no unfinished server/src/device/camera source shipped, no cloud-to-Mac file relay.
Bounded transaction executed once with script SHA256
`e503234233a588f9ec39a8b3f1ac3e29f11a9dbb78e24a291a8a4ba6a360d4c5`;
all backup/source/DB-secret-config/asset-hash/COMMITTED markers accepted.
Independent final DB inode/integrity, root secret and protected configuration
preservation passed. Six public assets200+exact hashes; auth200/unauthorized401,
foreign-origin403, billing-unconfigured, callback403, camera503, redirect308,
TLS SAN and closed3000/1935 gates passed. Service stable20seconds/zero automatic
restarts; backup/certbot timers active/enabled. Restart verification window669ms.
No customer DB writes or provider/payment/camera/ingest enablement; no commit/push.
Guest-only root600 journal:
`/var/backups/emberstage/static-release-ec82503100eca6fc37926a6f421dd2e424ae0c9eb554f718aa218fb84be7dab4.json`.
Prior releases and all transaction artifacts retained; visual acceptance parent-owned.

## Live animation static release (2026-11-23)

Historical release: `30acec8da706eba842c9283b3c1ca432f1680d775b1a32d0afb95ccc46b3604e`.
User explicitly authorized the reviewed login visuals and narrow SSH access repair.
Added only TCP22 `105.127.9.4/32` on `sg-094d6c0cadc76c6f1`; verified every
existing ingress rule retained, including `105.127.6.67/32` and HTTP/HTTPS.
Strict verified-host SSH then proved current was `ab2d01c4...` before updating OLD.

Uploaded only the six local static assets and bounded helpers. Built the 23-file
bundle entirely on guest from the verified previous live release; every file
outside the six-file ALLOWED set is byte-identical. No cloud file relay through
the Mac, no local unfinished server/device/camera source shipped, no commit/push.
Favicon/logo/brand CSS already matched the previous release; app.html/css/js changed.
Exact SHA256SUMS checked before and after deployment.

Executed `release-static.py` once, SHA256
`de64b1ee777c8f1cd198644e192f56d2bcc8178ef4284f9a8d5bf5e500b8dadb`.
Accepted all `EMBERSTAGE_STATIC_RELEASE_` markers: BACKUP_VERIFIED, SOURCE_EXACT,
DB_SECRET_CONFIG_PRESERVED, ASSET_HASHES_VERIFIED, COMMITTED. Independent final
readback proved live DB device/inode/integrity, root runtime secret and protected
nginx/TLS/unit/backup configuration preserved. Journal is root600 guest-only:
`/var/backups/emberstage/static-release-30acec8da706eba842c9283b3c1ca432f1680d775b1a32d0afb95ccc46b3604e.json`.
Old releases and transaction artifacts retained; no database restore or customer writes.

Independent public HTTPS200+SHA256 verification passed for all six asset routes.
`verify.py` passed auth/config200, unauthenticated401, foreign-origin403,
billing200/unconfigured, both callback403, camera503, redirect308, exact TLS SAN
and closed public3000/1935 gates. Guest service stable20seconds, zero automatic
restarts; certbot/backup timers active and enabled. Measured switch/restart/hash
verification window662ms, not a per-user downtime guarantee. No provider/payment,
camera or public-ingest enablement; browser visual acceptance remains parent-owned.

## Live Stitch static release (2026-11-22)

User/parent authorized the online portal redesign. Historical release:
`ab2d01c4bf530b24dcc134b4c3dc5dfffd4372d0cf00f77ab968ed947180a8d9`.
Prior release `2024fd7b52bd986df3b4b67d38082a3c1c2b951f6633bf3f5d965e813774b4d5`
is retained, not deleted. Exactly6 static files changed: app.html/css/js,
favicon.svg, emberstage-logo.svg and emberstage_brand.css. Both local and guest
23-file manifests proved all9 server/src files and every nonstatic file unchanged.

Standalone `release-static.py` is intentionally bound to this exact host and old
release; it is not a reusable bootstrap or broad deployment framework. Script
SHA256 at execution: `950988972a2184784c0e160c443a7c1669a5c90fbe83fcf3425a07a4d0ef91e1`.
It verifies fresh guest instance/account identity and symlink-safe paths, locks,
verifies all old/new hashes, performs a guest online SQLite backup/integrity check,
records root-only rollback/protected-state evidence, stages a fresh root-owned
code tree and atomically replaces only the managed current symlink using
`os.replace`. Graceful systemd restart and exact public asset hashes are checked
while code rollback remains armed. Failure restores old CODE only, never an old
database; all transaction artifacts are retained for reconciliation.

Accepted markers: STATIC_RELEASE_BACKUP_VERIFIED, SOURCE_EXACT,
DB_SECRET_CONFIG_PRESERVED, ASSET_HASHES_VERIFIED and COMMITTED (all prefixed
EMBERSTAGE_STATIC_RELEASE_). Independent final readback proved the current link,
live database device/inode+integrity and exact root secret metadata/hash unchanged,
plus unchanged nginx/TLS/unit/backup configuration. Protected hashes never left
the guest. Journal is root-only at
`/var/backups/emberstage/static-release-ab2d01c4bf530b24dcc134b4c3dc5dfffd4372d0cf00f77ab968ed947180a8d9.json`.

Recorded switch/restart/HTTPS verification window **670ms**; transaction776ms.
This is a measured verification window, not a per-user request downtime guarantee.
Post-release service stayed stable20seconds with zero automatic restarts.
Public HTML references the canonical logo and favicon; all6 static routes returned
200 with exact release hashes and correct MIME types. Logo SHA256
`bb41e930551dc763e63e49f718cc7dc0bf0b56e443ce08ccb8cd379e2a615df3`, favicon
`bc85aaf98b5dcca597de61e6a47ae3a10ecda0a9fe97201d892c56cc54f44137`.
Prior HTTPS/auth200, unauthorized401, cross-origin403, callback403, camera503,
unconfigured billing and closed public3000/1935 gates still passed.

No resources/DNS/config/credentials/provider/payment/Free gates changed. No live
customer account was created/deleted or database restored. Existing DB+secret
retain session authority; real customer-cookie testing was not performed.
Parent owns Work-browser desktop/mobile visual acceptance; this child did not
attach a browser or claim visual verification.

## Live provision milestone (2026-11-22)

Parent authorized reviewed provisioning and bootstrap only. Fresh preflight
re-proved exact STS principal, Canonical AMI owner, root device, subnet/default
internet route, and manager105.127.6.67/32. Provision succeeded once:

- instance `i-0c84a5d8668e47d8b`, EIP `54.166.237.147`
- EIP allocation `eipalloc-0cfb968eb32a7fee2`
- SG `sg-094d6c0cadc76c6f1`, key pair `emberstage-account`
- encrypted16GiB gp3 root `vol-03e48892aecea69e5`, retained on termination
- live no IAM profile, creditsstandard, IMDSv2 hop1, only22/32+80+443 ingress
- manifest `/private/var/folders/vy/_8rk6pcx6055dm_thx7gm8p40000gn/T/opencode/emberstage-aws-live.XjlHF0RJ/resources/resources.json`
- AWS console ED25519 fingerprint matched candidate before scp; verified
  known_hosts lives beside manifest. Only guest.sh staged, SHA256
  `1dc2fc231e6c0ac335bfceb300751e62b1c7558649fb6a7d21712e486a5a7c73`.

Parent reports exact new DNS-only A record
`ae00542693941623cac0f7fcd00446ad`, TTL120, account.emberstage.live→54.166.237.147.
Child performed no DNS mutation. Both authoritative Cloudflare nameservers later
returned exactly54.166.237.147 and noAAAA. Parent Oracle accepted auth/security and
required only the two eagerly read camera web files in the package. Parent then
authorized remaining install, isolated auth smoke and TLS stages.

### Completed deployment evidence

- Public portal **https://account.emberstage.live/app**.
- Bootstrap ran once and returned `EMBERSTAGE_BOOTSTRAP_READY`.
- Final23-file release (plus SHA256SUMS) SHA256
  `2024fd7b52bd986df3b4b67d38082a3c1c2b951f6633bf3f5d965e813774b4d5`.
- Install ran once. Local coordinator expected an extra backup stdout marker,
  but guest intentionally suppresses it; coordinator initially blocked. No guest
  replay: bounded read-only live proof recovered exact completed release, service,
  initialized API, backup and active timer state. Original marker acceptance is
  not claimed. Subsequent independent backup integrity proof passed.
- `EMBERSTAGE_ISOLATED_AUTH_SMOKE_VERIFIED`: production-mode separate in-memory
  app child with guest-generated random credentials/secret and fail-fast external
  fetch. Signup201/login200, session/me200, unauthenticated401, Secure/HttpOnly/
  SameSite cookies, missing/invalid CSRF403, logout200 and revoked session401.
  Free link-code402 preserved. No Pro grant or paid/pairing bypass.
- `EMBERSTAGE_LIVE_DB_EMPTY_UNCHANGED`: permanent DB+WAL hashes identical across
  smoke; users/workspaces/sessions/devices remained empty. Synthetic credentials
  and secret never persisted. `EMBERSTAGE_BACKUP_INTEGRITY_VERIFIED` passed.
- `EMBERSTAGE_TLS_READY` returned once. Public TLS certificate validates exact
  SAN account.emberstage.live, expires **2027-02-20 18:53:05 UTC**.
- `EMBERSTAGE_PUBLIC_READINESS_VERIFIED`: /app, portal files/brand assets,
  /api/auth/config and /api/billing/plan200; billing checkoutAvailablefalse and
  modeunconfigured. /api/auth/me and /api/workspaces401, foreignorigin403,
  /api/streams/publish and publish_done403, /camera503, HTTP→HTTPS308.
  External3000/1935 connection checks denied. No public signup write was performed.
- `EMBERSTAGE_GUEST_READINESS_VERIFIED`: dedicated emberstage UID, zero service
  restarts and unchanged running process across20seconds; Node/RTMP loopback
  listeners; release manifest hashes match; live SQLite integrity and emptiness
  proven; certbot and daily backup timers active/enabled.
- Browser account signup/login is available; **native Desk linking, providers,
  payments, managed streaming and camera are not enabled**. Free has zero paired
  devices until a separately configured and verified paid entitlement.
- Same-disk SQLite backups are not disaster recovery. Root DB+secret retained;
  snapshots/retention/alerts and renewal dry-run were not performed.

Helper `smoke.mjs` is a separately hash-bound guest-only synthetic harness, not in
the runtime package. `verify.py` performs public GET/TLS/closed-port checks and
prints only markers/statuses, never response bodies. No existing personal host,
build VM, desktop source, application route, `.env`, source database, commit or
push was changed. Final permanent host remains running.

## Original preparation boundary (historical)

Preparation initially only, 2026-11-22. User authorization for a fresh dedicated permanent
host is satisfied; execution awaits **parent internal security review**, not another
user approval. No DNS, existing host, application route, desktop code, `.env`,
database, commit or push is included. Scripts default to local packing/dry-run;
provisioning and every guest operation require `--execute`.

## Proven discovery / exact resource envelope

- CLI exclusively `aws --profile personal-plundead --region us-east-1`.
  STS proved `962379336291` / `arn:aws:iam::962379336291:user/personal-plundead`.
  Static profile, no SSO/aws_login, no credential-file reads.
- One new `emberstage-account` Ubuntu24.04 amd64 `t3.small` (2 vCPU/2GiB),
  `ami-0a951420c495183dc` (verified Canonical owner **099720109477**,
  image date20261120), credits **standard**, IMDSv2 hop1,
  encrypted16GiB gp3 retained on termination. No instance profile/IAM role.
- Reuse without modifying default VPC `vpc-0d1c1a3126d9ef07f`, subnet
  `subnet-04c51171b39585dcb` / us-east-1a, existing default internet route through
  `igw-0bb2b14aab4c74411`. t3.small offered there; capacity is not guaranteed.
- New tagged key pair, SG (22 only current publicIP/32, 80/443 IPv4 world),
  primary ENI, encrypted volume and EIP. No IPv6 public ingress. RTMP1935 and
  RTMPS remain closed; Node and RTMP bind loopback. No existing SG changes.
- Read-only instance inventory contained `agent-hold`, `hermes-agent-worker`,
  `grave-shift-beta`. Build VM `i-09bf529e4909ab129` did not appear in this account;
  **do not seek/adopt/change it**. Every guest command verifies exact new instance,
  account and region via IMDS before writes.
- Parent confirmed account.emberstage.live has no DNS record. Parent owns DNS.
  `APP_BASE_URL=https://account.emberstage.live` exactly, no trailing slash.

## Cost / limits

AWS Pricing API proved Linux shared t3.small **$0.0208/hour** (~$15.18/730h).
Public IPv4/EIP **$0.005/hour** (~$3.65/730h), charged even idle; EIP replaces
the ephemeral address, not a second steady-state IPv4. gp3 estimated
16×$0.08=$1.28/month (storage rate not API-verified in this pass).
Total **~$20.11/month before tax, outbound traffic and backups**. Retained EBS/EIP
continue billing after termination/stopping. Standard credits prohibit unlimited
CPU surcharges but throttle sustained load. This is auth/control-plane and
bounded remux capacity, not guaranteed transcoding throughput. AWS account-wide
100GB internet egress allowance may already be consumed; paid egress typically
$0.09/GB in this tier. At6Mbps one destination consumes ~2.7GB/hour; three ~8.1GB/h.
No hosted bandwidth or payment feature is enabled here.

Public prerequisites:
- https://nodejs.org/dist/index.json: **v24.22.3**, Krypton LTS security release,
  2026-11-10; satisfies repo Node24.18+ native SQLite requirement.
- https://nodejs.org/dist/v24.22.3/SHASUMS256.txt:
  linux-x64 tar.xz SHA256 `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb`.
  Guest downloads directly from upstream HTTPS and checks pinned hash before use.
- https://packages.ubuntu.com/noble/libnginx-mod-rtmp: distro module
  1:1.2.2+dfsg-5build1, nginx ABI1.24.0-1. Install nginx and module together via
  signed Ubuntu apt; guest `nginx -t` proves actual runtime compatibility.
- https://aws.amazon.com/vpc/pricing/ and https://aws.amazon.com/ec2/pricing/on-demand/.
- HTTP/2 intentionally absent; existing memory notes a distro HTTP/2 security
  issue. Guest security package status still needs review; don't claim patch parity.

## Exact preparation and execution sequence

Use a fresh approved temp directory; never reuse a provision state directory.
Commands below are reusable instructions; completed live evidence is above.

```sh
ASSETS=/Users/timiiiiiiii/Desktop/randoms/emberstage/server/deploy/personal-aws
WORK=$(mktemp -d /private/var/folders/vy/_8rk6pcx6055dm_thx7gm8p40000gn/T/opencode/emberstage-aws.XXXXXXXX)
chmod 700 "$WORK"
python3 "$ASSETS/deploy.py" pack --out "$WORK/package"
python3 "$ASSETS/deploy.py" provision --out "$WORK/resources" # no AWS calls/mutation
# AFTER PARENT REVIEW, generate a fresh deployment-only local key (never print it):
ssh-keygen -q -t ed25519 -N '' -f "$WORK/ssh-key"
# Re-fetch current managing public IP, validate global IPv4/32. Nov22 read-only
# checkip result was105.127.6.67; it is NOT a permanent allowlist assumption.
MANAGER_IP=$(curl --fail --silent https://checkip.amazonaws.com)
python3 "$ASSETS/deploy.py" provision --execute --out "$WORK/resources" \
  --public-key "$WORK/ssh-key.pub" --ssh-cidr "$MANAGER_IP/32"
```

If a provisioning call fails/transport is ambiguous: keep resources.json, inspect
only exact new tagged resources, reconcile once with parent. **No replay, cleanup,
existing-host adoption or implicit rollback deletion.** Script preserves partial
resource identities but a response-lost create can require tag-based read-only
reconciliation. AMI/subnet/identity/SSH CIDR must be rechecked immediately before use.

Read exact new instance console output via AWS API into private temp capture; parse
only the ED25519 SHA256 fingerprint from Ubuntu's SSH HOST KEY FINGERPRINTS block.
Do not print raw console/user-data/logs. `ssh-keyscan -t ed25519 NEW_EIP` is only a
candidate: compare `ssh-keygen -lf` with **AWS console authenticated fingerprint**,
then store verified candidate in `$WORK/known_hosts`. No TOFU/no
`StrictHostKeyChecking=no`. If console fingerprint missing/ambiguous, stop for parent;
do not guess or use another host. Console capture is local metadata, not cloud-file relay.

Runnable helper (read-only AWS + local known_hosts write, no console bytes printed):
`python3 "$ASSETS/deploy.py" trust-host --out "$WORK/resources"`.
It requires exactly one console ED25519 fingerprint and an exact candidate match;
use `$WORK/resources/known_hosts` only after `EMBERSTAGE_CONSOLE_HOST_KEY_VERIFIED`.
Mismatch fails before writing known_hosts; stop and reconcile, never override it.

```sh
# Set INSTANCE and IP only from reviewed resources.json; DIGEST from release.sha256.
# All scp/ssh calls must use the same verified host binding:
SSH_OPTS=(-i "$WORK/ssh-key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$WORK/resources/known_hosts")
scp "${SSH_OPTS[@]}" "$ASSETS/guest.sh" "$WORK/package/release.tar.gz" "ubuntu@$IP:./"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "sudo bash ./guest.sh --execute bootstrap $INSTANCE"
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "sudo bash ./guest.sh --execute install $INSTANCE /home/ubuntu/release.tar.gz $DIGEST"
# STOP before tls: run parent-approved auth smoke against an ISOLATED database,
# never the new permanent database, while nginx API gate remains closed.
# Parent creates only exact account.emberstage.live A record pointing to new EIP.
# Verify DNS resolves exact EIP, no conflicting AAAA/proxy redirect, then:
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "sudo bash ./guest.sh --execute tls $INSTANCE"
```

Bootstrap is non-replayable. Install is fresh-only, not a general upgrade tool.
Guest scripts emit allowlisted markers only; app stdout/stderr and nginx logs are
discarded. Apt/certbot diagnostics must never be relayed. Certbot internally retains
its own root logs (ACME metadata, no application secret); don't retrieve them.
Certbot currently opts into no renewal email; configure an owner notification
address separately if desired. Node download residue stays guest-only; later bounded
artifact cleanup is parent-owned, no deletes in this preparation pass.

## Auth, provider and TLS gates

- Runtime secret is generated **on guest only**, root-owned mode0600
  `/etc/emberstage/runtime.env`, read by systemd then passed to dedicated UID.
  Same-user environment inspection is within this host trust boundary; no cloud
  credentials or provider/payment/Google/Auth0/Nango credentials are installed.
- Persistence `/var/lib/emberstage/emberstage.db` owned emberstage0700 parent,
  service umask0077; code/root-owned read-only release, no npm install, no Docker.
  The packaged tree never includes `.env`, source DBs, tests,
  desktop app, secrets, or arbitrary root files. Four exact outside-server brand
  files are required by fixed-path reads (not three): favicon, logo, wordmark, CSS.
  Oracle review requires camera.html and camera.js because camera-rooms.js eagerly
  reads them even when disabled. Exactly these two dependencies are now included:
  23 allowlisted files plus SHA256SUMS. Their inclusion never enables camera routes.
- Existing public app routes: **GET/app**, /app/app.js, /app/app.css, fixed brand
  assets; **GET/api/auth/config**, **POST/api/auth/register**, **POST/api/auth/login**.
  There is **no /health, /login or /signup** app static route. `/` nginx redirects
  to/app only after TLS. Readiness checks /app and /api/auth/config, not fabricated
  health endpoints. Parent must not call nginx/static liveness SQLite readiness.
- nginx forwards exact Host, overwrites X-Forwarded-Proto and forwarding source;
  no cross-origin CORS injection or cookie weakening. Public callback namespace
  `/api/streams/` blocked because nginx's loopback proxy could otherwise bypass
  app's socket-only loopback checks. Direct RTMP callbacks go to Node loopback.
- `CAMERA_ROOMS_ENABLED=false` and nginx/camera503; no camera activation.
  `FAKE_WORKERS=false`; ingest advertises plain loopback intentionally, so
  production prepare rejects until separately reviewed RTMPS transport.
- Paystack/Nango/OAuth must report unavailable; no synthetic paid entitlement,
  Pro grants, external provider calls, real payment or managed relay smoke.
- Free workspace limit is zero paired devices: link-code/pair return402. Browser
  signup/login can work, but native Desk linking remains unavailable until an
  independently configured, verified paid plan; never bypass this boundary.
- Before opening TLS API, parent security review must accept login/register
  origin/CSRF behavior, cookie Secure/HttpOnly/SameSite, authorization and
  loopback callback bypass prevention. Smoke signup/login only with isolated DB
  using random ephemeral credentials, marker-only output, no raw cookies/body.
- After TLS: public status-only /app + asset/auth config checks, cross-origin403,
  unauthenticated admin401, callback403, camera503, no Node3000/RTMP1935 external
  exposure, correct certificate/SAN/HTTPS, service stability, timers enabled,
  and direct persistent SQLite integrity/backup markers. `certbot renew --dry-run`
  is a separately approved guest check; not yet performed.

## Backup and recovery / rollback

Guest SQLite online backup uses native sqlite3 backup and integrity_check, daily
systemd timer to root-only `/var/backups/emberstage`. It never reads customer rows
into output; copies remain guest-only. Fail closed if free disk is below2GiB plus
twice DB size. No silent pruning; monitor disk and set reviewed retention before
public operational acceptance. Same-disk backups are **not disaster recovery**.
Retain encrypted root volume; separately reviewed encrypted EBS snapshots provide
off-instance recovery for DB plus exact ENCRYPTION_SECRET. Never restore the DB
without its matching secret. No snapshot/bucket/IAM creation in this plan.

Initial deployment failure: keep public API gate closed, stop only new emberstage
service if required, retain exact release/DB/secret/EIP/volume for reconciliation.
After public writes, never restore an older DB automatically. For later releases,
stop broadcast/new writes, verified guest backup + exact secret retention, stage
new root-owned hash release, atomically replace only managed current symlink,
restart and check; code rollback only if schema compatibility proved. Otherwise
restore backup to isolated new DB first with writers stopped; parent owns final
cutover. No generic terminate/revoke/delete commands supplied.

## Validation scope in this preparation

Assigned original preparation validation: Python compilation without source-side pycache,
`bash -n guest.sh`, dry-run provision, exact local allowlist tar/hash checks,
read-only AWS discovery and public prerequisite fetches. No npm/app test execution
(would risk implicit `.env`/DB loading), cloud dry-run RunInstances, guest command,
DNS mutation, cert issuance, or infrastructure creation was performed during that
preparation pass. Subsequent parent-authorized execution is recorded above.

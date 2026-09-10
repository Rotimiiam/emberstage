# Product design: OBS service operator

Implementation plan, not a statement of shipped capabilities. Local operation comes first; paid cloud streaming is a separately gated release. Validation belongs to the parent. This planning task does not launch OBS, change implementation, connect accounts, or initiate purchases.

## 1. Product boundary and current evidence

- OBS remains the compositor, audio mixer, recorder, and encoder. Do not build a second desktop video compositor. Provide focused OBS docks backed by the existing local HTML/JS UI and a small native OBS integration; no separately installed Node, Python, Electron, or local service runtime.
- Keep Scripture search, the 66-book shorthand vocabulary, imported songs, and transparent text output usable without cloud login or an internet connection. Sell managed streaming capabilities, not permission to finish a local service.
- Current entry points: `control_panel.html`, `browser_source.html`; Scripture logic in `assets/js/control_panel/search_bible.js`; local song library in `load_song.js` (`obs-bible-song-library-v1`). Preserve existing content through a versioned, reversible migration.
- `send_message.js` currently publishes on selection and song initialization; `control_app.js` derives “Live” from a local toggle. Neither behavior is an adequate confirmation of OBS Program output. Replace these contracts before adding more output controls.
- Reviewed supplied `obs-bible-final-698x238.png` and `obs-bib2-operator.png`. The short layout recovers list space, but the status is clipped and nested rounded borders consume room. The larger screenshot illustrates oversized navigation/settings stealing the operating area. Consolidate the existing `cp_style.css`, `cp_themes.css`, and `cp_compact_overrides.css` ownership rather than adding another override layer.

## 2. Vocabulary and information architecture

Use the same labels in docks, dialogs, help, hotkeys, and API-facing status descriptions.

| Term | Exact meaning |
| --- | --- |
| Workspace | One church's membership, devices, provider connections, and subscription. A campus may be a separate workspace. |
| Device | One linked OBS installation; local libraries and scene mappings remain device-specific in MVP. |
| Output scene | The single user-chosen OBS scene shared by all operating docks. Not necessarily the current OBS Program scene. |
| Text overlay | One mapped transparent browser source shared by Scripture, Songs, and announcements; only one text cue is committed at a time. |
| Selected / Next | A draft cue or proposed media action; never evidence that viewers can see it. |
| Take | Explicitly apply the selected cue/action to its mapped output target. Never implicitly switch OBS Program scenes. |
| On Program | OBS reports the mapped item enabled in the Program scene graph and the receiver acknowledges the cue. This is routing evidence, not proof that no other layer covers it. |
| Hidden / Not on Program / Unknown | Distinct output states; never collapse them into a generic “Offline.” |
| Contribution | The single encoded feed sent by OBS to the managed cloud ingest. |
| Destination | A specific provider channel/Page and broadcast receiving a cloud copy of that contribution. |
| Stream session | One server-authorized contribution and its destination attempts; separate from the local worship/service workflow. |

Register separate docks through OBS's Docks menu. Do not repeat six top-level tabs inside every dock. A compact title/menu can open another dock or Setup. All docks share workspace/device context and output state.

| Dock / screen | Main working area | Persistent controls / secondary screens |
| --- | --- | --- |
| Scripture | Reference/content search, translation, results with verse text; shorthand examples `Jn 3:16`, `1 Cor 13`; history and next/previous verse | Selected cue, Take, Hide text; translation details and announcement editor in overflow |
| Songs | Searchable local library, selected song's verse/chorus cues; section or line mode | Next/previous selection, Take, Hide text; import/edit/export/delete on library screen; never start output on import or selection |
| Video Mixer | Discovered cameras/videos in the output scene, filter, selected item's state and transport capabilities | Take selected visibility action; explicit Play/Pause/Restart for supported native media; audio and transforms remain in OBS |
| Pictures | Searchable thumbnail grid/list of discovered OBS image items; supports arbitrary 20+ collections | Select then Take; next/previous selects, not publishes; no cloud image upload or hidden file import |
| Setup / Hotkeys | Connection, output scene, overlay, controlled media sets, hotkeys, appearance, backup | Workspace/device linking, members, account connections, subscription and diagnostics are named subpages |
| Streaming (optional) | Session draft or running-session destination list | Preflight, Start selected, per-destination status/stop, Stop all; link to account connections and billing |

Setup uses a section list followed by one form, with Back and a fixed action footer. At short heights replace the section list with a labeled selector. Billing/account management may open an expanded OBS-owned dialog; provider consent alone uses the system browser. Never require a second operator app to run the local core.

## 3. Layout, visual language, and learnability

- Familiar OBS/EasyWorship sequence: find content, select it, review Next, Take, Hide text. Keep these words on buttons. The first successful selection gets one dismissible hint: “Selection is private. Take updates the output.” No tour during an active session.
- Use restrained charcoal surfaces, amber selection/focus, and a small red On Program indicator. Suggested tokens: canvas `#171A20`, surface `#22262E`, text `#F3F4F6`, muted `#B8BEC8`, selection `#E6B15A`, live `#F17D85`, success `#8BD2B1`. Contrast must be verified; color is never the sole state signal.
- Retain a familiar locally available OBS/system UI font; 13–14px body and clear medium-weight labels. Do not fetch fonts or shrink the whole UI with transforms. Text-output fonts are independent settings. Use one toolbar, one content surface, and separators only where they distinguish functions; no nested card shells, decorative gradients, or animated status pulses.
- **698×238 logical CSS px:** 28px context/status row + 36px search/filter row + approximately 126px scrollable work area + 40px action footer, with remaining space for separators. A Scripture result area can show three compact rows. Put translation inline; move history/style to overflow. Footer: truncated selected reference/title with full accessible name, Previous, Next, Take, Hide text. Status/actions never scroll away. Streaming substitutes contribution summary, destination rows, and its start/stop footer; five rows may scroll, but the aggregate count remains visible.
- **390×720 portrait:** context row, search and filter rows, main list/cue area, selected-cue preview, and pinned action footer. Songs switches between Library and Cues with a Back button preserving search/scroll. No squeezed two-column library. Pictures uses two thumbnail columns; destinations use stacked rows with a details disclosure. Prefer 44px touch targets here, minimum 28px operating targets in the short pointer-oriented dock.
- At short heights, preview is a text excerpt, not another miniature video monitor. Full scene review stays in OBS. A blocking confirmation fills the dock instead of becoming a clipped nested popup. Its content scrolls; Cancel and the named action remain visible.
- Strong keyboard focus, logical Tab order, accessible labels on icon buttons, text-plus-icon status, screen-reader announcements only on meaningful changes, reduced-motion support, and selectable/copyable diagnostics. Escape dismisses a draft/dialog; it never stops output. Enter searches or selects while typing; it is not an accidental Take shortcut.

## 4. First install, secure OBS connection, and source mapping

1. **Install:** an OBS-version-compatible signed package includes native integration and local web assets. With OBS closed, install once; on the next user-initiated OBS start offer “Set up local output” and “Link streaming account later.” Register docks, with Scripture and Songs initially visible. Do not force cloud login, enable streaming, or overwrite the user's dock layout.
2. **Connect:** prefer an in-process native bridge to OBS APIs; show OBS version, connection status, and capabilities. A browser dock must not require an OBS password in its URL, source code, or localStorage. If an obs-websocket adapter is retained, opt in explicitly, use authentication and loopback only in MVP, store its credential in the OS credential store, and show host/port plus a Test action. Never ask users to disable auth or expose a port to the internet. Remote OBS control is later work.
3. **Choose output:** list the current scene collection's scenes with friendly names and identity details. User explicitly selects one output scene. Show whether it is currently on Program. Discover inputs and scene items recursively; inventory includes each occurrence and nested path, input kind, enable state, and supported actions. Names are labels, not keys.
4. **Map text:** choose an existing compatible overlay occurrence, or explicitly approve creation of one transparent browser source and its scene item. Show proposed dimensions, transform, layer position, and affected scene before creation. Verify renderer handshake and alpha transparency without replacing native backgrounds. One overlay handles both Scripture and Songs. Default last text after a fresh application start is hidden; opening another dock must never reset an already running overlay.
5. **Map native media:** users add cameras, video files, and images normally in OBS. The docks discover those items; no default camera names, numbered image slots, or source-count limit. Let users define optional mutually exclusive sets from specific scene-item occurrences. Unassigned sources are read-only in this UI. Preserve unrelated logos, audio, backgrounds, transforms, and scene order.
6. **Rehearse privately:** select a cue and inspect its private text preview; run a connection/receiver test without publishing text. If the scene is on Program, warn before any visible test. Teach Take and Hide text; show Hotkeys next. Then offer workspace/device linking and optional Streaming setup.

Persist mapping as device + scene-collection identity + scene UUID + input UUID + scene-item ID/path, using identities actually available from the supported OBS API. Item IDs are scene-scoped. If an API lacks stable identity, require remapping after ambiguity rather than falling back silently to a name. Renames update labels; deletions, collection changes, and reused IDs invalidate mapping. Subscribe to OBS events and reconcile on reconnect before enabling writes.

## 5. Shared state and safe output behavior

- Native integration owns the local output state, revisions, and command acknowledgments. All docks subscribe to this single state. Replace reliance on bare cross-context `BroadcastChannel("myChannel")`: OBS dock and browser-source storage contexts must not be assumed to share an origin or storage partition. Use a scoped authenticated bridge/receiver transport supported by the shipped OBS browser environment. Prove this in the integration gate.
- Keep `draftByDock`, `committedTextCue`, `textVisibility`, `outputMapping`, `observedObsState`, and `pendingCommand` separate. Every command carries device/workspace context, expected mapping revision, and an idempotency ID. A stale command fails with “Output changed; review selection”; it is not replayed after reconnection.
- Clicking a result, changing translation, importing/editing a song, moving Next/Previous, changing dock, or loading history changes only a draft. Take commits a snapshot of text and style and shows it. Later draft edits do not mutate that snapshot. Hide text is immediate, idempotent, confirmation-free, and never hides native video/pictures or stops streaming. Showing again requires Take, not an ambiguous toggle.
- On a shared overlay, taking a song replaces Scripture and vice versa; all docks immediately show the new committed cue and its origin. MVP has no automatic advance or click-to-live mode. This removes surprise publication from the current song initialization and selection handlers.
- Do not call a draft “OBS Preview.” Studio Mode can share the same source between Preview and Program; mutating it may affect both. Private text preview is rendered separately. Native-media selection only proposes an action; it does not privately play, seek, or change a shared input. Use OBS Preview/Transition for genuine scene rehearsal. Take into an off-Program output scene reports “Applied — not on Program”; the user transitions in OBS.
- Video/Picture Take affects only the selected mapped scene-item visibility set. Enable the chosen item, await acknowledgment, then disable the explicitly assigned peers; avoid a black gap, but do not promise an atomic cross-item cut. Preserve OBS layering. Shared/nested inputs require affected-scene warnings; if a mutation cannot be isolated, disable it and offer “Manage in OBS.” Source playback/seek can affect every occurrence of that input and is labeled accordingly.
- A media command is not a text command. Pictures/video Take never clears lyrics; switching text never replaces native backgrounds. Do not automatically launch a camera, restart a video, change audio mute, or change Program on selection. Display unsupported media controls as unavailable with a reason.
- Display Pending until receiver/OBS acknowledgment; on timeout show Unknown, last-confirmed timestamp, and Recheck. OBS external changes win over stale local assumptions. If the output scene changes externally, update On Program state without choosing a new mapping. Switching mapping/workspace is disabled during an active stream or pending Take; otherwise show exactly what will change and never auto-publish the new workspace's last cue.

## 6. Workspaces, roles, devices, and accounts

| Capability | Owner | Operator | Finance |
| --- | --- | --- | --- |
| Prepare/take local content on an authorized installation | Yes | Yes | No by account role |
| Draft/start/stop streaming on approved destinations | Yes | Yes | No |
| Link/revoke devices; invite members; assign roles | Yes | No | No |
| Connect/revoke provider accounts; approve channels | Yes | No | No |
| View usage, invoices, renew/cancel/change subscription | Yes | Usage/status only | Yes |

- Membership is workspace-specific; an account can have different roles in different churches. One clearly labeled workspace is active per device. Never infer the church from an email domain. Switch lists workspace and device names; require confirmation before swapping local library/mapping namespaces. Cloud membership does not imply automatic access to another church's local songs.
- Product-account login is separate from provider OAuth. The MVP uses email/password sessions for the Emberstage account; OAuth is used only in Streaming Setup to connect YouTube, Facebook Pages, or Twitch. Production provider client IDs and approvals remain unresolved. Invite acceptance must prove the intended identity; prevent removing the last owner and offer an explicit ownership-transfer flow.
- Link from Setup using a short-lived, one-use code plus system-browser OAuth consent. Browser shows church and device name; owner approves. Expired/wrong codes have Retry, never a manual token paste workaround. Native device credentials live in the OS store. Device screen shows last seen, linked workspace, operator lock, and Revoke. Unlink removes cloud credentials, not local songs; local-data deletion is separate and confirmed.
- MVP permits one active cloud contribution per workspace. An operator acquiring session control prevents another device from issuing conflicting Start actions. Explicit owner takeover is audited and attaches to the existing session rather than starting a duplicate. Stop all remains available to authorized operators/owner even if another operator holds the drafting lock.
- Cloud RBAC is server-enforced on every request. Offline local operation uses the last locally authorized operator profile. Revocation cannot be guaranteed on an offline computer; state this limitation and rely on OS access control for physical security. Reconnecting a revoked device denies cloud actions without blanking the local service.

**Provider connection flow:** Owner chooses provider → explain requested permissions → system-browser OAuth with state/PKCE as supported → server exchanges credentials → show authorized channels/Pages → choose and approve exact channel identities → return success to Setup. Request minimum required scopes, show account identity separately from channel identity, and show “No eligible channels” with permission/eligibility guidance. Do not substitute a personal Facebook profile for a Page. Reconnect should retain channel mapping only if provider identity matches.

**Revoke:** show affected channels and active destinations. “Stop affected destinations and revoke” explicitly ends only those outputs; cancel leaves them running. Inactive revocation removes server-held credentials and attempts provider revocation where supported. External provider revocation becomes “Authorization lost”; never repeatedly retry invalid credentials. No provider tokens, stream keys, or cloud secrets in frontend files, browser storage, URLs, analytics, or exported diagnostics. Server stores encrypted refresh/access credentials with managed encryption keys, rotates internal ingest credentials, and returns only scoped status/actions. Native integration receives a short-lived contribution credential directly and handles it without operator copy/paste. Review any OBS profile persistence of stream configuration; redact and clean up managed credentials on session end.

## 7. Managed streaming: one contribution, up to five destinations

OBS sends one contribution to managed ingest; server workers forward it to selected providers. Each destination is one channel/broadcast, including separate channels on the same provider. Hard maximum: five active/reserved destination slots per session, possibly fewer under a plan. Drafts may retain additional saved connections, but selecting a sixth is blocked with a named limit. No arbitrary stream-key fields or custom RTMP fallback in this OAuth-only MVP.

| Provider | Product treatment / release evidence needed |
| --- | --- |
| YouTube | Planned integration; validate official OAuth live-broadcast APIs, channel live eligibility, consent/app review requirements, lifecycle, and test-account end-to-end delivery before advertising support. |
| Facebook Pages | Planned integration; validate official Page live-video access, required permissions/review, eligible Page selection, and lifecycle. Personal-profile streaming is out of scope. |
| Twitch | Planned integration; validate official OAuth channel permissions, internal key retrieval/use, publishing behavior, and platform rules. |
| Instagram | **Gated / not supported.** Show disabled “Not supported yet,” not a connect button. Separate research must establish an official OAuth-only third-party publishing path and approvals. Live Producer/manual keys, scraped sessions, or unofficial APIs do not satisfy this requirement. No launch promise. |

### Operating sequence

1. **Draft:** choose approved destinations, each channel's title, description, audience/privacy options actually supported by that provider. Unsupported options are absent, not silently ignored. Show persistent church/device and “0/5 selected” (or the lower plan cap). Selection and Save draft never create a public broadcast. MVP starts now; scheduling is later.
2. **Preflight:** server checks role, device lease, subscription/capacity, destination eligibility/scopes, provider constraints, ingest readiness, and duplicate session/channel reservations. Local integration checks OBS connection, audio/video settings against the common ingest profile, output mapping, and competing OBS streaming. Never overwrite an unrelated active OBS stream; offer to return after it is stopped in OBS. Recording is independent. Report Ready / Needs action / Checking per destination with remediation. Unknown privacy is a blocker.
3. **Confirm start:** show exact channel names, public/private settings, count, and “OBS Program will be sent to these destinations.” Default blocks on selected failures. Explicit “Start ready destinations only (N)” requires a revised confirmation listing omissions. Do not silently downgrade to partial start.
4. **Start:** reserve server session/slots and snapshot entitlement, configure managed contribution only after approval, request OBS start, wait for actual ingest media, then start provider deliveries. Server coordinates provider-specific broadcast creation/activation and cleans up abandoned drafts. Show each step; an API acceptance is not proof of delivery. Failed requests are idempotent and recover the same session rather than creating duplicate broadcasts.
5. **Status:** contribution health is separate from fanout health. Example: “OBS feed healthy · 2/3 destinations delivering · Facebook needs attention.” Each row has channel, state, time in state, last verified update, Details, and context action. Show provider-confirmed Live only where available; otherwise “Sending — provider confirmation unavailable.” Never report success merely because OBS is streaming.
6. **Stop one:** confirmation names the destination and warns that its public event may end permanently. Other destinations and contribution continue. Retry/restart follows provider capability and requires confirmation if it creates a new event. Starting a previously selected Ready destination during the session repeats its preflight and confirmation; adding a new channel requires a revised draft and available entitlement.
7. **Stop all:** explicit modal lists destinations and “Stop destinations and managed OBS contribution”; default focus is Cancel. Disable repeats while Stopping. Finish provider events and stop the owned contribution, not OBS recording, local overlay, or an unrelated stream. If all destinations are individually stopped, ask whether to end contribution; do not leave an unexplained paid ingest running. Display Ending/Unknown until confirmed, with Recheck and emergency “Stop managed contribution in OBS” guidance if cloud control fails.

### State contract and partial failures

Destination states: `Draft → Checking → Ready → Starting → Sending/Live → Stopping → Ended`; branches `Needs action`, `Retrying`, `Failed`, `Unknown`. Aggregate states: Draft, Checking, Starting, All delivering, Partially delivering, No destinations delivering, Stopping, Ended, Status unknown. An aggregate green state requires every selected destination to have current delivery evidence.

- Retry transient transport/provider failures with bounded backoff and visible next retry; after a proposed two-minute retry window mark Failed and offer Retry. Healthy destinations continue. Permission failures require Reconnect; policy/eligibility failures require Details, not blind Retry. Do not restart an ended provider event automatically.
- Contribution lost: show “OBS feed lost” on every affected destination, preserve the existing session while recovery is possible, and reconcile provider event state before resuming. Never promise uninterrupted cloud streaming when the internet connection is down.
- Dock/API connection lost while cloud may still deliver: mark status Unknown with last update; retain server session ID and reconnect to it. Never enqueue a new Start or report Stop as completed offline. Closing a dock/logging out does not end an active stream; an authorized owner can manage it from the account session screen.
- Stop failure remains actionable as “May still be live”; notify authorized session controllers. Do not drop failed stop work when a dialog closes. Server cleanup/reconciliation records every destination's terminal state and audit event.

## 8. Subscription lifecycle, entitlements, and service-safe limits

This is a capability model, not approved packaging or a working checkout. Prices, currency/tax treatment, payment vendor, paid minute allowances, seat/device allowances, and trial duration remain release decisions. Never render invented prices or a success screen without server-confirmed purchase.

| Offer concept | Capability / limit model |
| --- | --- |
| Local core | Offline Scripture, local Songs, native output controls, mapping, backup. No subscription dependency or forced account login. |
| Cloud subscription | One concurrent contribution per workspace; plan-defined simultaneous destination cap `1..5`; disclosed destination-minute allowance, media-profile limits, member/device allowance, and billing period. |
| Trial | Explicit start/end timestamps and trial-specific cloud allowance; real eligibility verified server-side. Local core unaffected when it ends. Do not imply a trial exists before commercial policy is approved. |
| Later organization package | Central billing and administration across church workspaces; no implication of pooled allowances or extra concurrency in MVP. |

- **Signup:** owner/finance chooses workspace → reviews capability limits and policy → selects billing details through the eventual approved payment flow → server verifies payment/trial grant → entitlements become active. Until billing integration is configured, show “Subscription purchasing is not available yet”; never collect payment data in local HTML.
- **Renewal:** page shows period end, auto-renew status, payment attention state, and next charge information only when known. Invoice history and receipt links come from verified billing records. Payment-update/renew actions require owner/finance and internet. Operators see an unobtrusive warning plus “Ask your workspace owner,” not a purchase popup mid-service.
- **Cancel:** default is cancel renewal at period end. Confirmation states the exact last day for new cloud sessions; local data and core remain. Allow undo before effective cancellation. Expiry does not mean account deletion, provider revocation, or ending a stream. Refund and immediate-cancellation policies are unresolved and must be disclosed before sale.
- **Upgrade:** show the capability difference and server-provided charge/proration quote; commit only after verification. A larger cap permits explicit addition of destinations, not automatic publication. **Downgrade:** next billing period; retain saved channel connections, identify which draft selections exceed the new cap, and require choosing fewer before the next start. Never remove live destinations.
- **Usage:** report contribution minutes separately from destination-minutes (10 minutes to three delivering destinations = 30 destination-minutes). Billable start/stop boundaries and retry treatment must be disclosed; proposed metering counts worker-confirmed forwarding time and excludes known failed/no-media intervals. Server metering is authoritative, displays last updated time, and deduplicates session attempts. Show remaining allowance and projected use, not false precision from browser timers. MVP has no surprise automatic overage purchases.
- **Limits:** server enforces roles, concurrency, `min(plan cap, 5)`, capacity reservations, and allowance on Start/add-destination requests, including direct API calls and racing devices. Show warning thresholds at 80% and 100% of allowance. Exhaustion blocks the next session or added destination, not an ongoing service. Billing state cannot be changed by localStorage, a client clock, or a forged UI role.

### Proposed continuity policy (must be adopted and costed before sale)

1. A cloud session authorized at Start retains its granted destinations until explicit end; renewal failure, cancellation taking effect, trial expiry, quota crossing, or downgrade never terminates it for billing reasons. Continue metering; do not authorize extra destinations after entitlement expires. Provider outages, abuse/security incidents, and technical limits are separate, honestly reported exceptions.
2. Failed renewal of a previously paid subscription enters a **seven-calendar-day renewal grace period** from paid-through time. Existing plan capabilities allow new sessions during grace; show the exact deadline to owner/finance. At its end, deny new cloud sessions until renewal. Scheduled cancellation and trial expiry do not receive renewal grace, but already authorized sessions are still protected.
3. A transient contribution disconnect may resume the **same server session within 15 minutes**, even across entitlement expiry. Explicit Stop ends that right immediately. After 15 minutes without ingest, server finalizes the disconnected session; reconnect requires a new entitlement check. Display this recovery deadline during an outage. An uninterrupted protected session is not killed at a hidden billing timeout.
4. Local output and library use remain available indefinitely, including after logout, cloud outage, expiry, or failed renewal. No watermark, mid-service lock screen, automatic hiding, or forced upgrade. Refresh cloud status on reconnection; never replay queued publish/start commands.

## 9. Safety, recovery, and hotkeys

| Situation | Required behavior |
| --- | --- |
| Empty Scripture search / invalid reference | Show one shorthand example; explain invalid book/chapter/verse or unavailable translation; preserve input and previous committed cue. |
| Empty song library / bad import / storage full | Offer Import text and a format example. Preview parsing, choose duplicate replacement explicitly, show quota/write errors; preserve originals. Export backup before migration; corruption recovery must not silently reset the library. |
| No cameras/images / unsupported source | “Add a source in OBS, then refresh.” Inventory updates live; unsupported kinds remain identifiable with reasons. Missing media files are fixed in OBS, not uploaded elsewhere. |
| OBS disconnected / source deleted / scene collection changed | Keep draft and last committed snapshot; disable writes, show Reconnect/Remap. Do not clear current output or silently attach to a same-named item. |
| Provider consent denied / no eligible channel / token expired | Keep the draft; show Retry, permission guidance, or Reconnect. Never expose raw credentials or fabricate connected status. |
| Billing pending / payment failed / cloud unavailable | Show confirmed entitlement and timestamps separately from pending changes; preserve local operation. Start is blocked with an exact reason when server authorization is unavailable. |
| Destructive library action / revoke / workspace switch | Name affected content/device/channels; offer Cancel. Prefer undo for local song deletion; active output uses its committed snapshot until explicitly replaced/hidden. |

Register OBS-wide commands with the native OBS hotkey system, not browser `keydown` claims. Setup lists action, binding, scope, and conflict status; OBS's existing Hotkeys settings remain authoritative. Offer unbound commands: Take selected Scripture, Take selected Song, Hide text, Next/Previous Scripture selection, Next/Previous Song selection. Explicit dock-specific Take commands avoid focus ambiguity. Start/Stop streaming has no default key binding in MVP.

Detect known duplicate assignments within this integration and inspect OBS assignments where the API permits. Do not claim detection of every OS/other-app conflict; display “Not verified” and provide a non-publishing test. Browser shortcuts are labeled “This dock only” and ignored in editors/search fields. Repeat keydown must not send repeated Take commands. Confirmation dialogs suspend local publishing shortcuts. Native global bindings can still fire outside the dock: provide a clearly visible hotkey arm/disarm control and explicit operator guidance instead of relying on browser focus protection. No destructive one-key defaults.

## 10. Bounded delivery and implementation work graph

Paths below are proposed future work, not files created by this plan. Keep plain HTML/JS unless a specific build requirement justifies change. Introduce one shared component/state layer; do not duplicate each dock or append another CSS override sheet.

| Work package | Files/components | Depends on / completion contract |
| --- | --- | --- |
| A. Contracts and migration | `assets/js/shared/contracts.js`, `local_store.js`, migration fixtures | Define cue/state IDs, revisions, workspace namespaces; preserve/export existing song library and translation preferences. |
| B. Native OBS bridge | `native/obs-service-docks/` for dock registration, discovery, secure bridge, credential store, hotkeys | A; prove renderer/dock transport and source identities on supported OBS/browser versions. No cloud dependency. |
| C. Shared output | `assets/js/shared/output_store.js`, `obs_adapter.js`; refactor `send_message.js`, `toggle_display.js`, `browser_source.html`, `assets/js/browser_source/browser_app.js` | A+B; all writes use Select/Take/Hide and acknowledgments; alpha output and cross-dock consistency proven. |
| D. Dock shells and style ownership | `docks/{scripture,songs,video-mixer,pictures,setup,streaming}.html`; `assets/js/shared/ui/`; consolidate control-panel CSS and entry wiring | A+C; common StatusStrip, SearchToolbar, SelectableList, CuePreview, ActionBar, ConfirmSheet, ErrorNotice. Migrate legacy entry point, retire superseded handlers/styles. |
| E. Local tools | Adapt `search_bible.js`, `suggest_bible_books.js`, `load_song.js`, `shortcuts.js`; add media inventory/mapping and setup controllers | B+C+D; preserve all 66 shorthand books and local library; dynamic OBS inventory; native hotkeys; no implicit Take. |
| F. Cloud identity and authorization | `server/auth/`, `workspaces/`, `devices/`, `connections/`, `entitlements/`; Setup account views | A; server RBAC, secure secrets, scoped device sessions, OAuth lifecycle and audit log before provider publish permissions. |
| G. Streaming control/data plane | `server/sessions/`, `ingest/`, `fanout/`, `providers/`; Streaming draft/status controllers; native contribution adapter | B+D+F plus each provider's evidence gate; idempotent state machine, slot reservation, preflight, partial failure and cleanup. |
| H. Billing and usage | `server/billing/`, `metering/`; subscription/usage views | F+G; vendor and policy selected, signed event verification/deduplication, entitlement snapshots, grace and recovery semantics. No UI-only enforcement. |
| I. Packaging and release evidence | Native packaging, data-license inventory, fixtures/integration/visual tests, operator quick-start | Local release requires A–E and local gates; commercial release adds F–H, provider approvals, cost/security review, and support runbooks. |

**Local MVP:** separate five operating/setup docks, manual Select/Take/Hide, shared text overlay, search/history, line/section songs and local import/export, dynamic native source inventory, explicit visibility sets, source mapping, secure native integration, native OBS hotkeys. Windows and explicitly verified OBS versions first.

**Commercial MVP:** optional Streaming dock, per-church workspaces and roles, device linking, one contribution per workspace, up to five entitled destinations, only verified providers, OAuth-only connections, start-now sessions, destination-level recovery/stop, usage and subscription lifecycle. Owner/operator account views include active-session recovery controls; finance has billing and usage views only. No unproven checkout or unsupported provider masquerading as a released feature.

**Later:** organization-wide billing, synchronized libraries/service plans, scheduled broadcasts, deliberate auto-advance/live-selection mode, advanced media transitions, remote OBS control, additional OSes, and additional verified providers. Instagram remains gated rather than automatically becoming a promised later feature. Multitrack cloud editing, desktop composition, arbitrary custom-key destinations, and an independent camera ingest path are outside this plan.

## 11. Release gates and parent-owned acceptance

No tests or OBS launches were performed for this document. The following are acceptance requirements for the parent/implementation owner, not claimed results. Use fixtures and browser layout tests first; any future real-OBS validation needs separate user approval because OBS has frozen this user's computer.

| Gate | Required evidence |
| --- | --- |
| Dock layout | At **698×238 logical px (including 250% Windows DPI scenario)** and **390×720**, each dock has no horizontal overflow, clipped status, hidden primary action, or inaccessible confirmation footer. Verify populated/error/loading states, long names, five destinations, and 25+ image items. Only intended content regions scroll. |
| Operation safety | Selection/search/import/style edit/Next/Previous never changes output. Take replaces exactly one committed overlay snapshot; Hide affects text only. Dock reopening does not hide/reset output. Concurrent/stale commands, timeouts and reconnect cannot cause delayed publication. |
| OBS semantics | Inventory covers duplicate names, nested/shared sources, renamed/deleted inputs, changed collections, arbitrary source counts, and external OBS edits. Verify supported identity stability, actual native hotkeys with dock unfocused, receiver acknowledgments and alpha output. Studio Mode/shared-source cases cannot be represented as private preview. No claim of On Program from a checkbox alone. |
| Offline and storage | With internet unavailable, licensed local Scripture, stored songs, native-media controls and hotkeys work. Song migration/export survives malformed data, quota errors and restart. Cloud status becomes Unknown, not fake Offline/Stopped success. |
| Cloud correctness | Fixture/integration coverage for 0–5 destinations; sixth slot and racing starts blocked server-side; one contribution only; partial startup requires consent; one destination's failure/stop leaves others running; duplicate retries cannot create duplicate broadcasts. Lost-control/stop failures remain recoverable and visible. |
| Subscription and access | Test trial/paid/grace/expired/canceled/downgraded states at time boundaries; active streams survive billing transitions and quota crossing; same-session 15-minute recovery and next-session checks differ correctly. Unauthorized role, other-workspace IDs, revoked devices, forged client entitlements and replayed billing events fail server-side. |
| Provider feasibility | Official documentation, production permissions/app approval where required, eligible test account, OAuth/channel/revoke flow, and real contribution-to-destination start/stop evidence for each advertised provider. Instagram disabled until its separate official-evidence gate passes. |
| Data licensing | Inventory every bundled Bible dataset in `assets/bibles/` by edition, source, rights holder, territory, redistribution/commercial/display rights and attribution. Repository code's MIT license does **not** license those datasets. Remove/replace unverified editions before distribution. Review lyrics import, bundled examples, display and streaming rights separately; do not imply an operator's import supplies a performance/streaming license. License font/image assets too. |
| Security and commercial readiness | Review native bridge origin/scope checks, untrusted lyrics/HTML handling, credential storage/redaction, encrypted server tokens, least-privilege OAuth, signed updates, tenant isolation, billing event verification, privacy/retention policy, cloud media costs, approved grace policy and incident/stop reconciliation. No frontend secret files or user-facing stream-key entry. |

Release order: safe local control → proven native integration/layout → approved provider pilot → billing/continuity and licensed commercial release. Unresolved provider permissions, licensing, payment configuration, or native bridge security block their release scope; they are not cosmetic follow-ups.

# Media Deck native OBS hotkeys

Control existing OBS scene items from **Settings → Hotkeys**. No companion server,
browser focus, source import, or fixed camera/image slots are needed. Nothing is
shown, hidden, played, or published when the script loads or scans.

## Install and arm

1. In OBS, open **Tools → Scripts → +** and select `media-deck-hotkeys.lua` from
   this folder. OBS's bundled Lua support is sufficient; no Python setup is needed.
2. In the script properties, explicitly choose **Output scene**. The blank choice
   disables actions. A missing, renamed, or replaced output scene never falls back
   to the first scene. If a scene was replaced under the same name, choose the blank
   option first, then explicitly select the replacement.
3. **Manually match this Output scene to the app's shared output scene.** App
   connection settings do not configure Lua, and Lua does not synchronize with the
   app. Preview/import does not publish through this script.
4. Leave **Exclusive videos** and **Exclusive pictures** off unless you want them.
   Pictures stays off by default to preserve logos.
5. Open **Settings → Hotkeys**, search **Media Deck**, and assign your own keys.
   There are **no default bindings**. Check OBS's conflict indicators and existing
   bindings before applying. The label identifies the scene/group/source path.
6. Return to the script and check **Enabled — arm native hotkeys**. Uncheck it to
   disarm all Media Deck actions. Start with a non-live scene when checking keys.

These are OBS-wide frontend hotkeys, not browser key handlers. OBS must be running;
OS permissions, reserved shortcuts, and **Settings → Advanced → Hotkeys → Hotkey
Focus Behavior** can affect operation outside the OBS window. Only press callbacks
act; release callbacks do nothing. There is no key-repeat/debounce guarantee beyond
the events OBS supplies.

## What appears in Settings → Hotkeys

Labels use `Media Deck · <scene>/<group>/<source> · <action>`.

| Existing source type | Actions |
| --- | --- |
| DirectShow camera (`dshow_input`) | Show, Hide |
| Media/VLC (`ffmpeg_source`, `vlc_source`) | Show, Hide, Play, Pause, Restart, Stop |
| Image/slideshow (`image_source`, `slideshow`) | Show, Hide |
| Window/game/monitor capture | Show, Hide |
| Chosen scene | Hide pictures, Hide video |

- Items are discovered recursively inside groups, with no fixed source names or
  counts. Audio and browser overlays are not classified as cameras. Scene sources
  nested inside the output scene are not expanded; choose that scene directly if
  you need its items. Cycling and transitions are not implemented.
- **Show/Hide targets an individual scene-item occurrence.** Shared media playback
  controls affect the underlying source, including its other occurrences/scenes.
  Play does not reveal an item, and Hide does not stop playback. OBS source settings
  such as restart-on-activation and close-when-inactive can affect playback.
- Group visibility is not changed. A shown child stays invisible while an ancestor
  group is hidden. Showing a group automatically could reveal unrelated overlays.
- Exclusivity only applies to **Show** and only to peers in the same category in
  the chosen scene and its groups. Camera/capture visibility is never exclusive.
  Exclusive pictures can hide logos because logos are also image items. Keep it off
  to preserve them. Exclusive videos does not hide cameras, captures, or pictures.
- **Hide pictures** intentionally hides *all* images/slideshows, including logos,
  even with Exclusive pictures off. **Hide video** hides only Media/VLC items, not
  cameras/captures. Both common actions obey the Enabled checkbox.
- There is no fake per-source Fade action. Scene-transition fading belongs to OBS;
  this script neither changes nor switches the program/preview scene. It changes
  items in the explicitly chosen scene, which may already be on air.

## Source edits, bindings, and safety

Use **Re-scan sources** after edits, then reopen Settings → Hotkeys if needed. A
two-second registration refresh is also used when the timer API is available.
Neither kind of scan changes visibility or playback. Every press revalidates the
target occurrence before acting; a stale label/target skips that press and refreshes.

Keys use the chosen scene name/identity, group container identities, scene-item
IDs, and source UUIDs where exposed by OBS—not discovery order or array positions.
With UUID support, renaming a source/group updates the label and retains bindings.
Without UUID support, name/type/item-ID identity is used and a rename needs new
bindings. Older Lua APIs cannot distinguish every same-name replacement, so UUID
support is recommended. Renaming the output scene requires explicitly selecting
it again and assigning keys under the new scene path.

Removed registrations are saved before unregistering. Bindings, including those
for removed items, are retained in the script's OBS settings and written through
`script_save`; live registrations load them again on rescan/reload. Recreated items
with new IDs/UUIDs deliberately do not inherit another item's keys. Keep the same
script entry to keep its settings; removing the script entry can discard settings.
Unavailable APIs are logged in the script log rather than silently simulated.

## Release boundary and validation

**Native media hotkeys are implemented. Scripture/Songs global keyboard delivery
to the browser is not. That bridge remains a release gate.** This script sends no
Bible/song key events, does not open/reload URLs as key transport, and makes no
claim of native/app synchronization.

Offline contract test (does not start OBS):

```powershell
python tests/hotkeys-contract.py
```

The test uses Python's standard library and OBS's installed `lua51.dll` solely as
a Lua runtime, with a mocked `obslua` module. Override the DLL with
`MEDIA_DECK_LUA_DLL` if OBS is installed elsewhere. If no compatible DLL is present,
the test reports a skip; it does not install anything. Mock coverage is not native
OBS integration testing. A parent-owned manual OBS check is still required before
release for actual global delivery, properties, persistence, and media behavior.

## Optional Windows, macOS, and Linux installers: preview first

These are local configuration setup scripts, not compiled, signed commercial installers. Keep a complete checkout to run them.
- **On Windows (PowerShell):** Docks and Lua registration refer to files directly in your checkout folder. Moving or deleting the checkout breaks those references.
- **On macOS and Linux (Python):** The installer resolves a stable installed application folder (`~/Library/Application Support/Emberstage` or `~/.local/share/Emberstage`) and safely copies all required local app assets there. Moving or deleting the checkout after install will **not** break OBS docks or scripts!

### Running the preview/dry-run (no config writes or backups)

**Windows:**
```powershell
powershell.exe -NoProfile -File .\scripts\install-media-deck.ps1
```

**macOS / Linux:**
```bash
./scripts/install-media-deck.sh
```

### Applying the installation changes

Inspect the paths and **close every OBS instance yourself**, then apply:

**Windows:**
```powershell
powershell.exe -NoProfile -File .\scripts\install-media-deck.ps1 -Apply
```

**macOS / Linux:**
```bash
./scripts/install-media-deck.sh --apply
```

The installer refuses to apply while OBS is running. Keep OBS closed throughout installation. It never starts, stops, refreshes, or restarts OBS. Start OBS yourself afterward and arrange the new docks manually; existing dock layout data is retained.

On Windows, execution-policy restrictions may block an unsigned script; follow your organization's policy or add `-ExecutionPolicy Bypass` to that single `powershell.exe` invocation.

The default config folder is `%APPDATA%\obs-studio` (Windows), `~/Library/Application Support/obs-studio` (macOS), or `~/.config/obs-studio` / Flatpak (Linux). For an isolated or portable config, supply the folder containing `user.ini` explicitly:

**Windows:**
```powershell
powershell.exe -NoProfile -File .\scripts\install-media-deck.ps1 -ObsConfigPath "D:\OBS test config" -Apply
```

**macOS / Linux:**
```bash
./scripts/install-media-deck.sh --obs-config-path "/path/to/obs-studio" --apply
```

### Exactly what it installs

- Four app-owned browser docks: Text, Media, Cameras, and Streaming. The obsolete
  app-owned Setup dock is removed during upgrade. On macOS and
  Linux their local `file:///` URLs use the stable installed app folder; on
  Windows they use the checkout path.
  Unrelated docks, INI lines, and saved layout are preserved. Existing docks with
  similar names are not assumed to belong to the app.
- A Lua script entry in the **active scene collection only**, selected by
  `[Basic] SceneCollectionFile` in `user.ini`. Missing/unsafe filenames fail with
  instructions instead of selecting an arbitrary collection. Other scripts,
  settings, sources, and scene contents are retained.
- A **new** Lua entry starts disabled, with an empty output scene, both exclusivity
  settings off, and no key bindings. Existing registration settings are preserved
  on subsequent runs. A registration from a different checkout is refused rather
  than creating competing hotkeys or silently discarding its settings.

The complete checkout must include `control_panel.html`, `browser_source.html`,
`media_dock.html`, `camera_dock.html`, `media_setup.html`, and
`scripts/media-deck-hotkeys.lua`. The installer refuses an incomplete checkout.
It creates no image/camera/video/browser sources, never chooses a customer scene,
and never starts streaming. The browser output source, if needed, remains a
separate manual setup step. Repeated runs with unchanged settings are no-ops.

After starting OBS yourself, **manually match the app's shared output scene and
the Lua script's Output scene**. Then assign native keys under Settings → Hotkeys
and enable the Lua checkbox to arm. Installing the docks does not synchronize
these choices or unlock the still-pending Scripture/Songs global key bridge.

### WebSocket is a separate opt-in

Without the WebSocket switch, its config file is not read or changed. To preview and then explicitly enable authenticated WebSocket control:

**Windows:**
```powershell
powershell.exe -NoProfile -File .\scripts\install-media-deck.ps1 -EnableWebSocket -Apply
```

**macOS / Linux:**
```bash
./scripts/install-media-deck.sh --enable-websocket --apply
```

This sets `server_enabled=true` and `auth_required=true`, preserves an existing
nonempty password, and securely generates one if empty. Unknown settings and the
existing port are preserved. Passwords are never printed or embedded in HTML,
browser-source URLs, or tracked files. After **you** start OBS, find the password
under **Tools → WebSocket Server Settings** and configure the app connection
manually. Keep the OBS service private; enabling it can allow connections already
permitted by your network/firewall. The installer does not change firewall rules
or network exposure controls.

### Backup, failure recovery, and manual alternative

Before writing, Apply creates a timestamped `media-deck-backup-*` folder beside
the selected config folder. It prints that path and stores exact original bytes
for affected existing configs plus `manifest.json`. A macOS/Linux upgrade also
keeps the previous installed app as `previous-app` in that backup. Treat backups as private:
an opted-in WebSocket backup may contain the existing password.

On an apply error, the installer stops and restores files it already wrote from
that backup; newly created files are removed. If a file lock or permission issue
also prevents restoration, the error identifies the files requiring manual
recovery. Backups are retained. Atomic per-file writes and rollback protect normal
errors, but a power loss or forced process termination can still require recovery.

For manual rollback, close OBS yourself, open the printed backup's `manifest.json`,
and use its `configRoot` and relative file paths. Copy each file marked
`existed=true` from the backup to the matching config path; remove the matching
file when marked `existed=false`. Restore only these listed files, not the entire
OBS config tree. Start OBS yourself after recovery.

You can skip the installer: add the five URLs through **Docks → Custom Browser
Docks** and add Lua through **Tools → Scripts**, following the manual setup above.
Configure authenticated WebSocket through OBS's own settings if desired. No
compiled installer, automatic restart, or shared-target synchronization is implied.

## Camera output launch mode

OBS disables browser camera APIs unless it starts with `--enable-media-stream`. Fully quit OBS before using the matching reviewed launcher:

- macOS: `scripts/start-obs-camera-mode-macos.command`
- Linux: `scripts/start-obs-camera-mode-linux.sh`
- Windows: `scripts\start-obs-camera-mode-windows.cmd`

On macOS, also allow OBS under **System Settings → Privacy & Security → Camera**. The Camera dock selects the physical or virtual video device itself; an OBS Video Capture Device source is not imported into the dock. Disable any native OBS source already using that camera before taking it in Emberstage, because many camera drivers permit only one active client.

Isolated installer checks (temporary fixtures only; no real OBS config writes):

**Windows:**
```powershell
powershell.exe -NoProfile -File .\tests\install-contract.ps1
```

**macOS / Linux:**
```bash
python3 tests/install-contract.py
```

The tests cover dry-run safety, the escaped-JSON INI format observed in the current `user.ini` using a sanitized fixture, dock/script preservation, file URLs, idempotence, WebSocket opt-in, invalid configs, and rollback on a locked-file error. They never read live user configs. If OBS is already running, they check real process refusal and skip apply scenarios rather than stopping OBS. Native OBS UI verification remains parent-owned.

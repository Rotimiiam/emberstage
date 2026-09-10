# Emberstage

Emberstage is a local-first OBS service operator for Scripture, songs, manual text,
videos, pictures, and cameras. Operators select content privately, review it,
then use an explicit **Take** action. The local service workflow does not depend
on a cloud login.

> Status: runnable local MVP plus an isolated commercial control-plane MVP.
> Provider OAuth, Stripe checkout, and managed streaming require your own test
> credentials and are not configured by this repository.

## Operator docks

| Dock | File | Purpose |
| --- | --- | --- |
| Text | `control_panel.html` | Manual text, Scripture, songs, and text style |
| Media | `media_dock.html` | Videos and pictures in one dock |
| Cameras | `camera_dock.html` | Camera switching inside the mapped scene |
| Streaming | `streaming_dock.html` | Workspace pairing, destination selection, and stream status |

The redundant Setup dock is no longer installed; upgrades remove only its app-owned dock entry.

The older `video_mixer.html` and `picture_picker.html` URLs remain as compatibility
views. Media and Cameras share the configured OBS output scene. Text output uses
the transparent `browser_source.html` overlay.

## Safety model

- Selecting, searching, importing, and changing tabs do **not** publish.
- **Take** is the explicit text/video/camera output action.
- **Hide text** affects only the shared text overlay.
- Media and camera actions change source visibility in the selected scene; they
  do not switch the current OBS scene.
- No media hotkey is assigned automatically. Native hotkeys are disabled until
  the Lua script is armed in OBS.
- Existing OBS profiles, scenes, stream settings, and unrelated docks are
  preserved by the installer.

## Local setup

1. Back up the OBS profile and scene collection you intend to use.
2. Run the installer in dry-run mode first:

   **Windows:**
   ```powershell
   pwsh -NoProfile -File .\scripts\install-media-deck.ps1
   ```

   **macOS / Linux:**
   ```bash
   ./scripts/install-media-deck.sh
   ```

3. Review the printed plan, then apply it explicitly:

   **Windows:**
   ```powershell
   pwsh -NoProfile -File .\scripts\install-media-deck.ps1 -Apply
   ```

   **macOS / Linux:**
   ```bash
   ./scripts/install-media-deck.sh --apply
   ```

4. Start OBS yourself and arrange the four Emberstage docks. Text and media use
   their Emberstage browser outputs; Cameras enumerates local video devices.
5. Add `browser_source.html` as an OBS Browser Source for Scripture, songs, and
   manual text. Leave **Local file** off and use the file URL.

The installer creates a timestamped backup and prints its rollback instructions. It
does not start OBS, switch scenes, change source visibility, or start streaming.

For camera access, fully quit OBS and start it with the matching reviewed launcher:
`scripts/start-obs-camera-mode-macos.command`,
`scripts/start-obs-camera-mode-linux.sh`, or
`scripts\start-obs-camera-mode-windows.cmd`. These launch OBS with
`--enable-media-stream`; they refuse to start a second OBS instance.

## Native media hotkeys

The installer registers its installed copy of `media-deck-hotkeys.lua` in the
active OBS scene collection.
In OBS:

1. Open **Tools → Scripts** and load the Lua script if needed.
2. Choose the output scene.
3. Open **Settings → Hotkeys** and search for `Emberstage`.
4. Assign only the keys you want, then arm the script.

The script controls mapped video, picture, and camera sources only. It does not
create sources, reload browser docks, switch scenes, or start/stop the stream.

## Demo mode

To inspect Media or Cameras without connecting OBS:

```text
media_dock.html?demo=1
camera_dock.html?demo=1
```

## Marketing demo

The static landing page is under `site/`:

```bash
python3 -m http.server 4173
```

Open `http://127.0.0.1:4173/site/`.

## Commercial control plane

`server/` contains the separate account, workspace, device, entitlement,
billing, usage, and streaming-destination control plane. It is intentionally
separate from the offline local core.

```bash
cd server
cp .env.example .env
npm test
npm start
```

Important boundaries:

- Product authentication licenses server-backed commercial features.
- Streaming provider OAuth is only for connecting the owner's selected Twitch,
  YouTube channel, or Facebook Page to managed streaming setup.
- Instagram remains unavailable unless an official supported integration is
  proven.
- Browser HTML/JavaScript on a user-owned machine cannot be made tamper-proof.
  Hiding buttons in a dock is not licensing. Every paid action must be enforced
  again by the control plane.
- Archived OBS credentials are private migration evidence and are never reused.

See `server/README.md` for the API and configuration details.

## Verification

```bash
node --test tests/*.test.cjs
pwsh -NoProfile -File tests/install-contract.ps1
python3 tests/install-contract.py
cd server && npm test
```

## Scripture translations and licensing

The bundled Scripture datasets are treated as licensed for this project. The
distribution includes AMP, KJV, RVR1909, ESV, Hausa, Igbo, Diodati, Nuova
Diodati, LSG1910, NKJV, NIV, Russian, Swahili, and Yoruba translations. Preserve
the applicable license records and attribution when distributing Emberstage.
See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the project policy and
operator content responsibilities.

## Attribution

Emberstage builds on the open-source OBS Bible Plugin by Tosin-JD. Preserve the
upstream license and attribution when redistributing derived code.

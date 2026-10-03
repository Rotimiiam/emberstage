Emberstage macOS unsigned preview
================================

Requirements: macOS, OBS Studio 31+ initialized with a selected scene collection,
and a working Python 3 on PATH. If Python is missing, install it yourself from
https://www.python.org/downloads/macos/ and reopen the installer. If you already
use Homebrew, `brew install python` is another option. No automatic installs.

1. Close OBS yourself.
2. Double-click Install Emberstage.command on this mounted disk. It opens Terminal.
3. Read the dry-run plan. Type exactly yes and press Enter to apply; any other
   answer (or end of input) cancels without changes.
4. Read the result and backup path. Press Enter to finish, eject this disk, and
   start OBS yourself. Arrange the four Em browser docks manually.

The installer copies the HTML/assets and four scripts from payload into:
  ~/Library/Application Support/Emberstage
It updates the selected OBS collection and browser dock configuration only with
OBS closed. Emberstage Program nests two native camera helper scenes and the
Emberstage Graphics browser source, and is added hidden to the current scene.
Existing sources and their visibility are preserved; no scene is switched. Enable
the nested Emberstage Program when ready. New Lua registration is disarmed, with no
target scene or hotkeys; configure and arm it yourself in OBS if wanted.

Backups are under ~/Library/Application Support/media-deck-backup-<timestamp>.
Keep the printed backup path. To roll back, close OBS and restore the relative
configuration files recorded in its manifest.json (remove files marked as not
previously existing). If present, previous-app contains the former Emberstage
folder. On a first install, remove the new Emberstage folder only after restoring
the configuration. Your imported media and browser data are not part of this DMG.

Apply enables authenticated OBS WebSocket, preserves an existing nonempty password
and port, and writes a user-only private connection file beside the app. Keep that
file and backups private. No firewall rules are changed; keep the service private.
The installer never starts/stops OBS, requests sudo, downloads software, or installs
background services. Start OBS normally; native cameras need no special launcher.
Streaming backend/server deployment is not included.

Unsigned and not notarized: macOS may block opening a downloaded command. Only if
you trust this preview, use the per-file Open option or macOS Privacy & Security
approval. Do not disable Gatekeeper globally. No native Finder/GUI test is claimed.
Installation is offline; some application features still require network access.

Rebuild on macOS with Python 3 from the source checkout:
  python3 scripts/package-macos.py
  python3 tests/package-macos-contract.py
Output: dist/Emberstage-macOS.dmg (hdiutil compressed read-only UDZO/HFS+).
The packager uses an explicit file allowlist and normalized file modes/timestamps.
Reproducible here means repeatable packaging of the same payload, not byte-identical
DMGs: hdiutil filesystem metadata can vary. Build UTC times and installer SHA-256
are printed for source-race tracking. Rebuild if the installer changes afterwards.
LICENSE and THIRD_PARTY_NOTICES.md accompany this preview.

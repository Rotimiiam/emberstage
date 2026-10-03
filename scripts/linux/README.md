# Emberstage on Linux (preview)

This is a **host-side installer archive compatible with Flatpak OBS**, not a
standalone `.flatpak` application or Flathub listing. A separate Flatpak installer
would need access to another application's private configuration; this package
does not grant that access or weaken the OBS sandbox.

Requires Python 3 on the host and OBS opened/configured once. Close every OBS
instance. Extract `Emberstage-Linux.tar.gz`, open a terminal in `Emberstage`, then:

```sh
# Flatpak OBS: review the dry run, then apply.
sh scripts/linux/install-emberstage.sh --flatpak
sh scripts/linux/install-emberstage.sh --flatpak --apply

# Or native OBS (respects XDG_CONFIG_HOME / XDG_DATA_HOME):
sh scripts/linux/install-emberstage.sh --native
sh scripts/linux/install-emberstage.sh --native --apply
```

Flatpak assets go to `~/.var/app/com.obsproject.Studio/data/Emberstage`, which
belongs to OBS; configuration is in the same app's `config/obs-studio` directory.
Native assets go to `$XDG_DATA_HOME/Emberstage` (default `~/.local/share/Emberstage`).
You can remove the extracted archive after installation. Run the same commands
again to upgrade/repair. The installer backs up changed config and the previous
app and prints rollback instructions. Media, browser storage, WebSocket secrets,
scene visibility and stream state are not reset. Keep the printed backup folder.

Launch OBS normally. Add cameras as native OBS Video Capture Device sources;
no special launcher or browser camera flag is required. Apply enables authenticated
OBS WebSocket, preserving an existing nonempty password and port, and creates a
user-only private connection file for the docks. It does not change firewall rules;
keep the WebSocket service private. Hardware permissions and simultaneous camera
access still depend on OBS, Flatpak permissions and the camera driver.
This preview has fixture coverage; actual Linux OBS rendering/camera integration
still requires testing on a Linux desktop before claiming native acceptance.

Build from a complete checkout with `python3 scripts/linux/build-archive.py`.

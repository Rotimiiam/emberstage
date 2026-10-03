#!/usr/bin/env python3
"""Build the unsigned macOS preview with stdlib + hdiutil; run from any cwd."""

import ast
import datetime
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
APP_FILES = (
    'control_panel.html', 'browser_source.html', 'media_dock.html',
    'camera_dock.html', 'media_setup.html', 'picture_picker.html',
    'video_mixer.html', 'media_output.html', 'camera_output.html', 'emberstage_output.html', 'streaming_dock.html',
)
REQUIRED_SCRIPTS = (
    'install-media-deck.py', 'install-media-deck.sh', 'media-deck-hotkeys.lua',
    'start-obs-camera-mode-macos.command',
)
# Reviewed runtime paths only. Never recursively copy the checkout or assets tree.
# New dependencies must be added deliberately, not silently bundled on next build.
ASSET_FILES = tuple('assets/' + name for name in '''
brand/favicon.svg
brand/emberstage-logo.svg
brand/emberstage-wordmark.svg
css/browser/browser_style.css
css/browser/broadcast_branding.css
css/camera_dock.css
css/dock_ui_scale.css
css/control_panel/cp_compact_overrides.css
css/control_panel/cp_style.css
css/control_panel/cp_themes.css
css/control_panel/broadcast_look.css
css/emberstage_brand.css
css/emberstage_output.css
css/media_deck.css
js/browser_source/browser_app.js
js/browser_source/broadcast_branding.js
js/browser_source/broadcast_branding_shared.js
js/browser_source/load_browser_settings.js
js/control_panel/animate.js
js/control_panel/choose_bible_translation.js
js/control_panel/control_app.js
js/control_panel/broadcast_look_panel.js
js/control_panel/flyout_tool.js
js/control_panel/load_panel_settings.js
js/control_panel/load_song.js
js/control_panel/panel_settings.js
js/control_panel/search_bible.js
js/control_panel/search_lyrics.js
js/control_panel/send_message.js
js/control_panel/settings.js
js/control_panel/shortcuts.js
js/control_panel/suggest_bible_books.js
js/control_panel/utils.js
js/keyboard-navigation.js
js/dock_ui_scale.js
js/media/demo.js
js/media/media-app.js
js/media/media-core.js
js/media/obs-client.js
js/media/native-camera-core.js
js/media/native-install.js
js/media/owned-camera-app.js
js/media/owned-media-app.js
js/media/owned-setup-app.js
js/outputs/camera-output.js
js/outputs/layout-helper.js
js/outputs/media-output.js
js/outputs/output-transition.js
bibles/amplified/amplified.js
bibles/kjv/kjv.js
bibles/es_rvr/es_rvr.js
bibles/swahili_bible/swahili_bible.js
bibles/nkjv/nkjv.js
bibles/italian/italian_new_diodati.js
bibles/italian/italian_bible_diodati.js
bibles/hausa_bible/hausa_bible.js
bibles/crtb/crtb.js
bibles/igbo_bible/igbo_bible.js
bibles/esv/esv.js
bibles/niv/niv.js
bibles/yoruba_bible/yoruba_bible.js
bibles/segond_1910/segond_1910.js
'''.split())
PAYLOAD_FILES = APP_FILES + ASSET_FILES + tuple('scripts/' + name for name in REQUIRED_SCRIPTS)
TOP_FILES = {
    'Install Emberstage.command': 'scripts/macos/Install Emberstage.command',
    'README.txt': 'scripts/macos/README.txt',
    'LICENSE': 'LICENSE',
    'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
}


def stage(root, destination):
    """Copy only regular allowlisted files, preserving the installer's relative layout."""
    sources = dict(TOP_FILES)
    sources.update(('payload/' + name, name) for name in PAYLOAD_FILES)
    for target, relative in sorted(sources.items()):
        source = root / relative
        if any(path.is_symlink() for path in (source, *source.parents)) or not source.is_file():
            raise ValueError('Missing or unsafe package source: ' + str(source))
        output = destination / target
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, output)
        output.chmod(0o755 if output.suffix in ('.command', '.sh', '.py') else 0o644)

    # Read the staged source without importing/executing the installer at build time.
    tree = ast.parse((destination / 'payload/scripts/install-media-deck.py').read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'APP_FILES' for t in node.targets):
            if set(ast.literal_eval(node.value)) != set(APP_FILES):
                raise ValueError('Installer APP_FILES changed; review the packaging allowlist.')
            break
    else:
        raise ValueError('Installer APP_FILES declaration missing.')

    # Stable payload metadata; hdiutil itself does not promise byte-identical images.
    for path in [destination, *destination.rglob('*')]:
        if path.is_dir():
            path.chmod(0o755)
        os.utime(path, (946684800, 946684800))


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='microseconds')


def main():
    if sys.platform != 'darwin' or not shutil.which('hdiutil'):
        raise SystemExit('Build on macOS with Python 3 and hdiutil; no substitute archive is produced.')
    print('Build started UTC: ' + utc_now(), flush=True)
    output = ROOT / 'dist/Emberstage-macOS.dmg'
    output.parent.mkdir(exist_ok=True)
    # Preserve the last good artifact until creation of its replacement succeeds.
    with tempfile.TemporaryDirectory(prefix='emberstage-macos-') as temporary:
        work = Path(temporary)
        staging = work / 'volume'
        staging.mkdir()
        stage(ROOT, staging)
        installer = staging / 'payload/scripts/install-media-deck.py'
        print('Payload captured UTC: ' + utc_now(), flush=True)
        print('Installer SHA-256: ' + hashlib.sha256(installer.read_bytes()).hexdigest(), flush=True)
        image = work / 'Emberstage-macOS.dmg'
        subprocess.run([
            'hdiutil', 'create', '-volname', 'Emberstage macOS Preview',
            '-srcfolder', str(staging), '-fs', 'HFS+', '-format', 'UDZO', str(image),
        ], check=True)
        # Atomic replacement on the usual same-volume macOS temporary directory.
        os.replace(image, output)
    print('Build finished UTC: ' + utc_now(), flush=True)
    print('DMG: ' + str(output), flush=True)


if __name__ == '__main__':
    main()

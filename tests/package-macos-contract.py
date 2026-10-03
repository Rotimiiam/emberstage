#!/usr/bin/env python3
"""Verify the real DMG and mounted command, never the user's HOME/OBS config."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('package_macos', ROOT / 'scripts/package-macos.py')
assert spec is not None and spec.loader is not None
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def run(args, **kwargs):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=120, **kwargs)
    if result.returncode:
        raise AssertionError(f'{args!r} exited {result.returncode}:\n{result.stdout}')
    return result.stdout


def snapshot(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file()}


def fixture_test(volume, work):
    home = work / "fixture HOME ' with spaces"
    support = home / 'Library/Application Support'
    config = support / 'obs-studio'
    scenes = config / 'basic/scenes'
    scenes.mkdir(parents=True)
    ini = config / 'user.ini'
    ini.write_text('[Basic]\nSceneCollectionFile=Fixture\n')
    collection = scenes / 'Fixture.json'
    collection.write_text(json.dumps({
        'name': 'Fixture display name',
        'current_scene': 'Fixture',
        'sources': [{'name': 'Fixture', 'id': 'scene', 'settings': {'items': [], 'id_counter': 0}}],
        'modules': {'scripts-tool': []},
    }))
    websocket = config / 'plugin_config/obs-websocket/config.json'
    websocket.parent.mkdir(parents=True)
    websocket.write_text('{"server_enabled":false,"fixture_marker":"untouched"}\n')
    originals = {ini: ini.read_bytes(), collection: collection.read_bytes()}
    original_ws = websocket.read_bytes()
    before = snapshot(home)
    bin_dir = work / 'test-bin'
    bin_dir.mkdir()
    (bin_dir / 'python3').symlink_to(sys.executable)
    # No imports or interpreter startup settings from the user's Python environment.
    env = {k: v for k, v in os.environ.items() if not k.startswith('PYTHON')}
    env.update(HOME=str(home), PATH=f'{bin_dir}:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE='1')
    launcher = volume / 'Install Emberstage.command'

    for answer in ('no\n', '\n', '', 'yes'):
        output = run([str(launcher), '--apply', '--enable-websocket'],
                     input=answer, env=env, cwd=work)
        assert 'DRY RUN' in output and 'Cancelled.' in output, output
        assert snapshot(home) == before, 'Dry-run/cancellation wrote to fixture HOME'
    print('PASS mounted command: dry-run, no/empty/EOF cancellation, ignored caller flags', flush=True)

    result = subprocess.run([str(launcher)], input='yes\n', env=env, cwd=work,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    output = result.stdout
    if result.returncode and 'Apply refused: OBS is running.' in output:
        assert snapshot(home) == before, 'Running-OBS refusal modified fixture HOME'
        print('PASS real running-OBS apply refusal preserves fixture HOME; SKIP mounted apply/idempotence while OBS is open', flush=True)
        return
    assert result.returncode == 0, output
    assert output.index('DRY RUN') < output.index('Type exactly yes') < output.index('APPLY -'), output
    installed = support / 'Emberstage'
    actual, expected = snapshot(installed), snapshot(volume / 'payload')
    binding_path = 'assets/js/media/native-install.js'
    assert actual.pop(binding_path)
    expected.pop(binding_path, None)  # Generated at installation, not a packaged asset.
    assert actual == expected, 'Installed payload differs outside the generated native binding'
    updated = json.loads(collection.read_text())
    binding = (installed / binding_path).read_text()
    assert 'collection: "Fixture display name"' in binding
    for name in ('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics'):
        source = next(source for source in updated['sources'] if source['name'] == name)
        assert f"uuid: '{source['uuid']}'" in binding
    lua = updated['modules']['scripts-tool']
    assert len(lua) == 1 and lua[0]['path'] == str(installed / 'scripts/media-deck-hotkeys.lua')
    assert lua[0]['settings']['enabled'] is False
    assert updated['current_scene'] == 'Fixture'
    outputs = {source['name']: source for source in updated['sources'] if source['id'] == 'browser_source'}
    assert 'Emberstage Graphics' in outputs
    assert outputs['Emberstage Graphics']['settings']['url'] == (installed / 'emberstage_output.html').as_uri()
    assert outputs['Emberstage Graphics']['settings']['is_local_file'] is False
    assert outputs['Emberstage Graphics']['settings']['shutdown'] is True
    items = updated['sources'][0]['settings']['items']
    assert len(items) == 1 and all(item['visible'] is False for item in items)
    assert {item['name'] for item in items} == {'Emberstage Program'}
    assert all(title in ini.read_text() for title in ('Em - Text', 'Em - Media', 'Em - Cameras', 'Em - Streaming'))
    assert str(volume) not in ini.read_text() + collection.read_text(), 'Config depends on mounted disk'
    ws = json.loads(websocket.read_text())
    assert ws['fixture_marker'] == 'untouched'
    assert ws['server_enabled'] and ws['auth_required'] and len(ws['server_password']) >= 32
    private = support / 'Emberstage-private/obs-connection.js'
    assert private.is_file() and private.stat().st_mode & 0o777 == 0o600
    assert private.parent.stat().st_mode & 0o777 == 0o700
    assert ws['server_password'] in private.read_text()
    assert private.as_uri() in binding and ws['server_password'] not in binding
    backups = list(support.glob('media-deck-backup-*'))
    assert len(backups) == 1
    for path, data in originals.items():
        assert (backups[0] / path.relative_to(config)).read_bytes() == data
    assert (backups[0] / 'manifest.json').is_file()
    after = snapshot(home)
    output = run([str(launcher)], input='yes\n', env=env, cwd=work)
    assert 'No changes needed.' in output and snapshot(home) == after
    print('PASS mounted command: yes/apply, payload bytes, stable paths, Lua, docks, native composition, backups, private automatic authentication, idempotence', flush=True)

    # No Python: launcher must provide help, not invoke a package manager.
    empty_bin = work / 'empty-bin'
    empty_bin.mkdir()
    result = subprocess.run([str(launcher)], env=dict(env, PATH=str(empty_bin)),
                            input='', text=True, capture_output=True, timeout=15)
    assert result.returncode != 0 and 'https://www.python.org/downloads/macos/' in result.stderr
    assert snapshot(home) == after

    # Inject a failing apply without changing the packaged installer or real OBS.
    fake_bin = work / 'failing-python-bin'
    fake_bin.mkdir()
    fake_python = fake_bin / 'python3'
    fake_python.write_text('#!/bin/bash\n'
                           'if [ "$1" = -c ]; then exit 0; fi\n'
                           'if [ "${2-}" = --apply ]; then echo "Fixture apply error" >&2; exit 23; fi\n'
                           'echo "DRY RUN fixture"\n')
    fake_python.chmod(0o755)
    result = subprocess.run([str(launcher)], env=dict(env, PATH=f'{fake_bin}:/usr/bin:/bin'),
                            input='yes\n', text=True, capture_output=True, timeout=15)
    assert result.returncode == 23 and 'Fixture apply error' in result.stderr
    assert 'Installation complete.' not in result.stdout
    assert snapshot(home) == after
    print('PASS missing-Python help and nonzero apply-error propagation (injected failure)', flush=True)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('This contract requires macOS hdiutil and macOS installation paths.')
    image = ROOT / 'dist/Emberstage-macOS.dmg'
    print(run(['hdiutil', 'verify', str(image)]), flush=True)
    # macOS /var aliases /private/var; fixtures must obey the installer's no-symlink policy.
    work = Path(tempfile.mkdtemp(prefix='emberstage-contract-')).resolve()
    volume = work / "mounted DMG ' with spaces"
    volume.mkdir()
    attached = False
    try:
        print(run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen',
                   '-mountpoint', str(volume), str(image)]), flush=True)
        attached = True
        assert os.statvfs(volume).f_flag & os.ST_RDONLY, 'Volume is not read-only'
        assert all(not p.is_symlink() for p in volume.rglob('*'))
        assert snapshot(volume / 'payload').keys() == set(package.PAYLOAD_FILES)
        for target in package.TOP_FILES:
            assert (volume / target).is_file()
        for name in ('Install Emberstage.command',
                     'payload/scripts/install-media-deck.sh',
                     'payload/scripts/install-media-deck.py',
                     'payload/scripts/start-obs-camera-mode-macos.command'):
            assert (volume / name).stat().st_mode & 0o111, name
        run(['/bin/bash', '-n', str(volume / 'Install Emberstage.command')])
        # Compare allowlisted source bytes, reporting stale builds after source edits.
        for relative in package.PAYLOAD_FILES:
            assert (volume / 'payload' / relative).read_bytes() == (ROOT / relative).read_bytes(), relative
        for target, source in package.TOP_FILES.items():
            assert (volume / target).read_bytes() == (ROOT / source).read_bytes(), target
        digest = hashlib.sha256((volume / 'payload/scripts/install-media-deck.py').read_bytes()).hexdigest()
        print('PASS read-only volume, exact payload allowlist, executable bits, source bytes', flush=True)
        print('Mounted installer SHA-256: ' + digest, flush=True)
        fixture_test(volume, work)
    finally:
        if attached or os.path.ismount(volume):
            # If detach fails, raise BEFORE deleting anything; leave the mount for recovery.
            print(run(['hdiutil', 'detach', str(volume)]), flush=True)
        shutil.rmtree(work)
    print('PASS macOS DMG contract (no Finder/OBS GUI interaction)', flush=True)


if __name__ == '__main__':
    main()

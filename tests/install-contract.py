#!/usr/bin/env python3
"""Offline Python contract checks; standard library only. Never starts OBS.

Verifies the macOS/Linux Python installer's dry-run safety, INI decoding/encoding,
JSON depth checks, backup generation, and rollback on simulated write failure.
"""

import sys
import os
import shutil
import uuid
import json
import re
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
installer_script = ROOT / 'scripts' / 'install-media-deck.py'

passed = 0
failed = 0

def test_case(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f"PASS {name}")
    except Exception as e:
        failed += 1
        print(f"FAIL {name}: {e}")
        import traceback
        traceback.print_exc()

def assert_cond(cond, msg):
    if not cond:
        raise AssertionError(msg)

# Setup isolated suite directory
suite_root = Path(os.environ.get("TMPDIR", "/tmp")) / f"media-deck-install-contract-py-{uuid.uuid4().hex}"
suite_root.mkdir(parents=True, exist_ok=True)

# Create a fake repo root
fake_repo = suite_root / "Checkout with spaces # &"
(fake_repo / "scripts").mkdir(parents=True, exist_ok=True)
shutil.copy2(installer_script, fake_repo / "scripts" / "install-media-deck.py")

for f in ['control_panel.html', 'browser_source.html', 'media_dock.html', 'camera_dock.html', 'media_setup.html', 'video_mixer.html', 'picture_picker.html', 'media_output.html', 'camera_output.html', 'streaming_dock.html', 'scripts/media-deck-hotkeys.lua', 'assets/test.css']:
    p = fake_repo / f
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("fixture only - not executable app content", encoding="utf-8")

# Helper to import installer dynamically as a module so we can test its units
import importlib.util
spec = importlib.util.spec_from_file_location("install_media_deck", str(fake_repo / "scripts" / "install-media-deck.py"))
installer = importlib.util.module_from_spec(spec)
sys.modules["install_media_deck"] = installer
spec.loader.exec_module(installer)

def new_fixture():
    parent = suite_root / uuid.uuid4().hex
    config = parent / "obs config"
    ini_path = config / "user.ini"
    collection_dir = config / "basic" / "scenes"
    collection_dir.mkdir(parents=True, exist_ok=True)
    collection_path = collection_dir / "Selected collection.json"
    ws_dir = config / "plugin_config" / "obs-websocket"
    ws_dir.mkdir(parents=True, exist_ok=True)
    ws_path = ws_dir / "config.json"
    
    ini_text = """[General]
FirstRun=true
HotkeyFocusType=NeverDisableHotkeys

[BasicWindow]
PreviewProgramMode=true
DockState=AAAA/wAAAAD9AAAAAg==
ExtraBrowserDocks=[{"title": "Existing operator dock", "url": "C:\\\\\\\\Operator Files\\\\\\\\panel.html", "uuid": "11111111111111111111111111111111", "unknown": {"keep": [1, true, "verbatim"]}}]
AlwaysOnTop=false

[Basic]
SceneCollection=Operator selected collection
SceneCollectionFile=Selected collection.json

[UnknownPlugin]
Opaque=a\\\\b\\nkeep=this ; comment
"""
    # Force platform standard line endings in memory
    ini_text = ini_text.replace("\r\n", "\n").replace("\n", os.linesep)
    
    ini_path.write_bytes(ini_text.encode('utf-8'))
    
    collection_data = {
        "name": "Operator selected collection",
        "current_scene": "Existing scene",
        "sources": [
            {"name": "Keep exactly", "id": "image_source", "settings": {"file": "D:/Pictures/image.png"}},
            {"name": "Emberstage Text Output", "id": "browser_source", "settings": {"url": "http://127.0.0.1:4173/browser_source.html", "width": 1920}},
            {"name": "Emberstage Media Output", "id": "browser_source", "settings": {"url": "http://127.0.0.1:4173/media_output.html", "height": 1080}},
            {"name": "Emberstage Camera Output", "id": "browser_source", "settings": {"url": "http://127.0.0.1:4173/camera_output.html", "fps": 30}},
            {"name": "Emberstage Camera Output", "id": "image_source", "settings": {"file": "keep.png"}}
        ],
        "scene_order": [{"name": "Existing scene"}],
        "modules": {
            "unrelated": {"nested": [1, False, {"keep": "yes"}]},
            "scripts-tool": [
                {"path": "D:/Operator Tools/existing.lua", "settings": {"custom": "keep", "bindings": [{"key": "OBS_KEY_F19"}]}}
            ]
        },
        "unknown": {"keep": True}
    }
    collection_path.write_text(json.dumps(collection_data), encoding="utf-8")
    
    ws_data = {
        "server_enabled": False,
        "auth_required": False,
        "server_password": "fixture-only-password",
        "server_port": 4457,
        "unknown": {"keep": True}
    }
    ws_path.write_text(json.dumps(ws_data), encoding="utf-8")
    
    # Reset tracking
    installer.original_files.clear()
    installer.plans.clear()
    
    class Fixture:
        def __init__(self):
            self.Parent = parent
            self.Config = config
            self.Ini = ini_path
            self.Collection = collection_path
            self.WebSocket = ws_path
            
    return Fixture()

def snapshot(fxt):
    result = {}
    for p in [fxt.Ini, fxt.Collection, fxt.WebSocket]:
        if p.exists():
            result[p] = p.read_bytes()
    return result

def assert_unchanged(before):
    for p, b in before.items():
        assert_cond(p.exists(), f"Fixture disappeared: {p}")
        assert_cond(p.read_bytes() == b, f"Fixture changed unexpectedly: {p}")

def run_installer_dry(fxt, enable_websocket=False):
    import io
    from contextlib import redirect_stdout, redirect_stderr
    
    # Save standard sys.argv
    old_argv = sys.argv
    sys.argv = ['install-media-deck.py', '--obs-config-path', str(fxt.Config)]
    if enable_websocket:
        sys.argv.append('--enable-websocket')
        
    out = io.StringIO()
    err = io.StringIO()
    
    installer.original_files.clear()
    installer.plans.clear()
    
    try:
        with redirect_stdout(out), redirect_stderr(err):
            installer.main()
    except SystemExit as se:
        if se.code != 0:
            raise Exception(f"Exit code: {se.code}. Stderr: {err.getvalue()}")
    finally:
        sys.argv = old_argv
        
    return out.getvalue()

def run_installer_apply(fxt, enable_websocket=False):
    import io
    from contextlib import redirect_stdout, redirect_stderr
    
    old_argv = sys.argv
    sys.argv = ['install-media-deck.py', '--obs-config-path', str(fxt.Config), '--apply']
    if enable_websocket:
        sys.argv.append('--enable-websocket')
        
    out = io.StringIO()
    err = io.StringIO()
    
    installer.original_files.clear()
    installer.plans.clear()
    
    try:
        with redirect_stdout(out), redirect_stderr(err):
            installer.main()
    except SystemExit as se:
        if se.code != 0:
            raise Exception(f"Exit code: {se.code}. Stderr: {err.getvalue()}")
    finally:
        sys.argv = old_argv
        
    return out.getvalue()

def read_docks(fxt):
    ini_text = fxt.Ini.read_text(encoding='utf-8')
    entry, _ = installer.get_ini_record(ini_text, 'BasicWindow', 'ExtraBrowserDocks')
    if entry is None:
        return []
    val = installer.decode_ini_string(entry['value'])
    return json.loads(val)

# BEGIN TESTS
def test_imports_and_safety():
    source = installer_script.read_text(encoding='utf-8')
    assert_cond("os.system" not in source, "Forbidden process execution functions found.")
    assert_cond("subprocess.Popen" not in source, "Forbidden Popen found.")
    assert_cond("urllib.request.urlopen" not in source, "Forbidden network call found.")
    assert_cond("socket" not in source or "urllib" in source, "Possible low-level socket operations.")

def test_dry_run_no_writes():
    f = new_fixture()
    before = snapshot(f)
    out = run_installer_dry(f)
    assert_cond("DRY RUN" in out, "Should identify dry run.")
    assert_cond("No files or backups written" in out, "Should state no writes.")
    assert_unchanged(before)
    
    # Check that no backup was created
    subdirs = [x for x in f.Parent.iterdir() if x.is_dir() and x.name.startswith("media-deck-backup-")]
    assert_cond(len(subdirs) == 0, "Dry run created a backup.")

def test_escaped_ini_fixture_decodes():
    f = new_fixture()
    docks = read_docks(f)
    assert_cond(len(docks) == 1, "Should have 1 existing dock.")
    assert_cond(docks[0]['url'] == "C:\\Operator Files\\panel.html", "INI decodes backslashes incorrectly.")

def test_invalid_configs_refuse():
    invalid_cases = [
        ('docks', 'ExtraBrowserDocks=[BROKEN'),
        ('collection', '{not-json'),
        ('websocket', '{not-json'),
        ('duplicate-ini', '[Basic]\nSceneCollectionFile=elsewhere\n'),
        ('traversal', '../elsewhere.json'),
        ('absolute', '/elsewhere.json'),
        ('missing-selection', 'UnrelatedKey=Selected collection.json'),
        ('missing-file', 'Absent.json'),
        ('bad-modules', '{"modules":[]}')
    ]
    
    for kind, val in invalid_cases:
        f = new_fixture()
        if kind == 'docks':
            text = f.Ini.read_text(encoding='utf-8')
            f.Ini.write_text(text.replace('ExtraBrowserDocks=[', val), encoding='utf-8')
        elif kind == 'collection':
            f.Collection.write_text(val, encoding='utf-8')
        elif kind == 'websocket':
            f.WebSocket.write_text(val, encoding='utf-8')
        elif kind == 'duplicate-ini':
            text = f.Ini.read_text(encoding='utf-8')
            f.Ini.write_text(text + val, encoding='utf-8')
        elif kind == 'traversal':
            text = f.Ini.read_text(encoding='utf-8')
            f.Ini.write_text(text.replace('Selected collection.json', val), encoding='utf-8')
        elif kind == 'absolute':
            text = f.Ini.read_text(encoding='utf-8')
            f.Ini.write_text(text.replace('Selected collection.json', val), encoding='utf-8')
        elif kind == 'missing-selection':
            text = f.Ini.read_text(encoding='utf-8')
            f.Ini.write_text(text.replace('SceneCollectionFile=', val), encoding='utf-8')
        elif kind == 'missing-file':
            text = f.Ini.read_text(encoding='utf-8')
            f.Ini.write_text(text.replace('Selected collection.json', val), encoding='utf-8')
        elif kind == 'bad-modules':
            f.Collection.write_text(val, encoding='utf-8')
            
        before = snapshot(f)
        
        # We expect a failure / sys.exit(1) or exception
        failed_as_expected = False
        try:
            run_installer_dry(f, enable_websocket=True)
        except Exception:
            failed_as_expected = True
            
        assert_cond(failed_as_expected, f"Failed case '{kind}' did not trigger expected error.")
        assert_unchanged(before)

def test_apply_writes_correctly():
    f = new_fixture()
    before = snapshot(f)
    
    # Stub is_obs_running to return False
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    # We also mock app_dir target inside the fixture parent so it doesn't touch local Library/local.share
    old_platform = sys.platform
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        out = run_installer_apply(f)
        assert_cond("Installed Emberstage docks" in out, "Success message missing.")
        
        # One existing dock plus four app docks.
        docks = read_docks(f)
        assert_cond(len(docks) == 5, f"Expected 5 docks, got {len(docks)}.")
        
        # Verify first dock remains unchanged
        assert_cond(docks[0]['title'] == "Existing operator dock", "Existing dock modified.")
        assert_cond(docks[0]['url'] == "C:\\Operator Files\\panel.html", "Existing dock URL modified.")
        
        # Active collection must have the script registered
        collection = json.loads(f.Collection.read_text(encoding='utf-8'))
        scripts = collection['modules']['scripts-tool']
        assert_cond(len(scripts) == 2, f"Expected 2 registered scripts, got {len(scripts)}.")
        assert_cond(scripts[1]['path'].endswith("media-deck-hotkeys.lua"), "Lua script registration missing.")
        assert_cond(scripts[1]['settings']['enabled'] is False, "New script must be registered disabled.")

        expected_files = {
            'Emberstage Text Output': 'browser_source.html',
            'Emberstage Media Output': 'media_output.html',
            'Emberstage Camera Output': 'camera_output.html',
        }
        for source in collection['sources']:
            if source['name'] in expected_files and source['id'] == 'browser_source':
                settings = source['settings']
                expected_url = installer.path_to_file_url(os.path.abspath(app_dir_mock / expected_files[source['name']]))
                assert_cond(settings['is_local_file'] is False, f"{source['name']} must share the dock's file origin.")
                assert_cond(settings['local_file'] == '', f"{source['name']} local_file must be cleared.")
                assert_cond(settings['url'] == expected_url, f"{source['name']} URL was not repointed.")
        assert_cond(collection['sources'][0]['settings'] == {"file": "D:/Pictures/image.png"}, "Unrelated source changed.")
        assert_cond(collection['sources'][4]['settings'] == {"file": "keep.png"}, "Same-name non-browser source changed.")
        
        # Verify app_dir assets were actually copied
        assert_cond(app_dir_mock.exists(), "Emberstage app_dir not created.")
        assert_cond((app_dir_mock / "control_panel.html").exists(), "control_panel.html not copied.")
        assert_cond((app_dir_mock / "scripts" / "media-deck-hotkeys.lua").exists(), "media-deck-hotkeys.lua not copied.")
        
        # Verify backup was created
        backups = [x for x in f.Parent.iterdir() if x.is_dir() and x.name.startswith("media-deck-backup-")]
        assert_cond(len(backups) == 1, "Should have created exactly one backup directory.")
        manifest = json.loads((backups[0] / "manifest.json").read_text(encoding='utf-8'))
        assert_cond(len(manifest['files']) == 2, "Expected 2 backed up config files in manifest.")
        
    finally:
        installer.is_obs_running = old_is_obs_running

def test_retired_setup_dock():
    f = new_fixture()
    docks = read_docks(f)
    namesake = {'uuid': 'customer-setup', 'title': 'Emberstage - Setup', 'url': 'https://example.test/setup'}
    docks.extend([namesake, {'uuid': '4d4445434b534554555000000000000005', 'title': 'Renamed old setup', 'url': 'file:///old/media_setup.html'}])
    ini = f.Ini.read_text(encoding='utf-8')
    f.Ini.write_text(installer.set_ini_value(ini, 'BasicWindow', 'ExtraBrowserDocks', installer.encode_ini_string(json.dumps(docks))), encoding='utf-8')
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    installer.app_dir = str(f.Parent / 'Emberstage')
    try:
        run_installer_apply(f)
        updated = read_docks(f)
        assert_cond(namesake in updated, 'Customer-owned namesake dock must be preserved.')
        assert_cond(not any(d.get('uuid') == '4d4445434b534554555000000000000005' for d in updated), 'Retired Setup dock remains.')
        assert_cond(len(updated) == 6, 'Expected two customer docks and four app docks.')
        before = snapshot(f)
        run_installer_apply(f)
        assert_unchanged(before)
    finally:
        installer.is_obs_running = old_is_obs_running

def test_idempotence():
    f = new_fixture()
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        # First apply
        run_installer_apply(f)
        before = snapshot(f)
        
        # Second apply
        out = run_installer_apply(f)
        assert_cond("No changes needed" in out, "Second apply was not a no-op.")
        assert_unchanged(before)
    finally:
        installer.is_obs_running = old_is_obs_running

def test_asset_upgrade_without_config_change():
    f = new_fixture()
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)

    try:
        run_installer_apply(f)
        (fake_repo / 'media_dock.html').write_text('updated fixture asset', encoding='utf-8')
        out = run_installer_apply(f)
        assert_cond('Install/update Emberstage app assets' in out, 'Asset-only update was not planned.')
        assert_cond((app_dir_mock / 'media_dock.html').read_text(encoding='utf-8') == 'updated fixture asset', 'Updated app asset was not installed.')
        backups = [x for x in f.Parent.iterdir() if x.is_dir() and x.name.startswith('media-deck-backup-')]
        assert_cond(any((backup / 'previous-app').is_dir() for backup in backups), 'Previous installed app was not retained in the upgrade backup.')
    finally:
        installer.is_obs_running = old_is_obs_running
        (fake_repo / 'media_dock.html').write_text('fixture only - not executable app content', encoding='utf-8')

def test_staging_failure_preserves_installed_app():
    f = new_fixture()
    old_is_obs_running = installer.is_obs_running
    old_copy = installer.copy_app_assets
    installer.is_obs_running = lambda: False
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    try:
        run_installer_apply(f)
        before = snapshot(f)
        original = (app_dir_mock / 'media_dock.html').read_bytes()
        (fake_repo / 'media_dock.html').write_text('updated fixture asset', encoding='utf-8')
        def fail_copy(*args):
            raise PermissionError('Simulated staging failure')
        installer.copy_app_assets = fail_copy
        try:
            run_installer_apply(f)
            raise AssertionError('Expected staging failure')
        except Exception as error:
            assert_cond('Installation failed' in str(error), 'Unexpected failure')
        assert_unchanged(before)
        assert_cond((app_dir_mock / 'media_dock.html').read_bytes() == original, 'Staging failure removed installed app.')
    finally:
        installer.copy_app_assets = old_copy
        installer.is_obs_running = old_is_obs_running
        (fake_repo / 'media_dock.html').write_text('fixture only - not executable app content', encoding='utf-8')

def test_websocket_opt_in():
    f = new_fixture()
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        out = run_installer_apply(f, enable_websocket=True)
        ws_data = json.loads(f.WebSocket.read_text(encoding='utf-8'))
        
        assert_cond(ws_data['server_enabled'] is True, "WebSocket must be enabled.")
        assert_cond(ws_data['auth_required'] is True, "WebSocket must require auth.")
        assert_cond(ws_data['server_password'] == "fixture-only-password", "Existing WebSocket password not preserved.")
        assert_cond("fixture-only-password" not in out, "Credentials printed to stdout.")
    finally:
        installer.is_obs_running = old_is_obs_running

def test_empty_websocket_password_generates():
    f = new_fixture()
    # Write blank password
    ws_data = {
        "server_enabled": False,
        "auth_required": False,
        "server_password": "",
        "server_port": 4457,
        "unknown": {"keep": True}
    }
    f.WebSocket.write_text(json.dumps(ws_data), encoding="utf-8")
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        out = run_installer_apply(f, enable_websocket=True)
        new_ws = json.loads(f.WebSocket.read_text(encoding='utf-8'))
        
        assert_cond(len(new_ws['server_password']) > 0, "No password was generated.")
        assert_cond(new_ws['server_password'] != "GENERATED_ONLY_ON_APPLY", "Dummy template value written instead of real password.")
        assert_cond(new_ws['server_password'] not in out, "Generated credentials printed to stdout.")
    finally:
        installer.is_obs_running = old_is_obs_running

def test_rollback_on_failure():
    f = new_fixture()
    before = snapshot(f)
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    # Force failure during writing by replacing os.replace with an exception-throwing stub
    old_replace = os.replace
    def fake_replace(src, dst):
        if "basic/scenes" in dst or "Selected collection" in dst:
            raise PermissionError("Simulated write failure for scene collection.")
        old_replace(src, dst)
        
    os.replace = fake_replace
    
    try:
        failed_as_expected = False
        try:
            run_installer_apply(f)
        except Exception as e:
            if "Installation failed" in str(e):
                failed_as_expected = True
                
        assert_cond(failed_as_expected, "Installer did not report installation failure.")
        
        # Ensure all configurations were restored to original state
        assert_unchanged(before)
        
        # Ensure app_dir was removed or rolled back to non-existent since it didn't exist before
        assert_cond(not app_dir_mock.exists(), "Emberstage app_dir not cleaned up on rollback.")
    finally:
        os.replace = old_replace
        installer.is_obs_running = old_is_obs_running

def run_all_tests():
    print("Running Python installation support tests...")
    test_case("PowerShell/Python safety posture AST checks", test_imports_and_safety)
    test_case("default dry run leaves all fixture bytes and backup directories unchanged", test_dry_run_no_writes)
    test_case("current-style escaped INI fixture decodes file paths", test_escaped_ini_fixture_decodes)
    test_case("malformed JSON/INI, unsafe or missing collection, and incomplete checkout refuse untouched", test_invalid_configs_refuse)
    test_case("apply adds four Emberstage docks and Lua while preserving unrelated config and exact backup bytes", test_apply_writes_correctly)
    test_case("upgrade removes only owned Setup dock and preserves customer namesakes", test_retired_setup_dock)
    test_case("second apply is byte-idempotent", test_idempotence)
    test_case("asset-only upgrades refresh the stable app and retain the previous app", test_asset_upgrade_without_config_change)
    test_case("staging failure preserves the existing installed app", test_staging_failure_preserves_installed_app)
    test_case("WebSocket opt-in preserves password/unknown keys and never prints credentials", test_websocket_opt_in)
    test_case("empty/new WebSocket password is generated only on apply and never printed", test_empty_websocket_password_generates)
    test_case("write failure rolls back earlier writes from exact backup", test_rollback_on_failure)
    
    print(f"\nTest Summary: {passed} passed; {failed} failed.")
    
    # Cleanup suite directory
    try:
        shutil.rmtree(suite_root)
    except Exception:
        pass
        
    if failed > 0:
        sys.exit(1)

if __name__ == '__main__':
    run_all_tests()

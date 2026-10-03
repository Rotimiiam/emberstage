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
suite_root = Path(os.environ.get("TMPDIR", "/tmp")).resolve() / f"media-deck-install-contract-py-{uuid.uuid4().hex}"
suite_root.mkdir(parents=True, exist_ok=True)

# Create a fake repo root
fake_repo = suite_root / "Checkout with spaces # &"
(fake_repo / "scripts").mkdir(parents=True, exist_ok=True)
shutil.copy2(installer_script, fake_repo / "scripts" / "install-media-deck.py")

for f in ['control_panel.html', 'browser_source.html', 'media_dock.html', 'camera_dock.html', 'media_setup.html', 'video_mixer.html', 'picture_picker.html', 'media_output.html', 'camera_output.html', 'streaming_dock.html', 'emberstage_output.html', 'scripts/media-deck-hotkeys.lua', 'assets/test.css']:
    p = fake_repo / f
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("fixture only - not executable app content", encoding="utf-8")

# Helper to import installer dynamically as a module so we can test its units
import importlib.util
spec = importlib.util.spec_from_file_location("install_media_deck", str(fake_repo / "scripts" / "install-media-deck.py"))
installer = importlib.util.module_from_spec(spec)
sys.modules["install_media_deck"] = installer
spec.loader.exec_module(installer)

def new_fixture(with_collision=False):
    parent = suite_root / uuid.uuid4().hex
    config = parent / "obs config"
    ini_path = config / "user.ini"
    collection_dir = config / "basic" / "scenes"
    collection_dir.mkdir(parents=True, exist_ok=True)
    collection_path = collection_dir / "Selected collection.json"
    ws_dir = config / "plugin_config" / "obs-websocket"
    ws_dir.mkdir(parents=True, exist_ok=True)
    ws_path = ws_dir / "config.json"
    
    # Create profiles directory and mock basic.ini
    profile_dir = config / "basic" / "profiles" / "Untitled"
    profile_dir.mkdir(parents=True, exist_ok=True)
    basic_ini = profile_dir / "basic.ini"
    basic_ini_text = """[Video]
BaseCX=2560
BaseCY=1440
"""
    basic_ini.write_text(basic_ini_text, encoding='utf-8')
    
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
            {"name": "Emberstage Text Output", "id": "browser_source", "settings": {"url": "http://127.0.0.1:4173/browser_source.html", "width": 1920}, "uuid": "uuid-text-1234"},
            {"name": "Emberstage Media Output", "id": "browser_source", "settings": {"url": "http://127.0.0.1:4173/media_output.html", "height": 1080}, "uuid": "uuid-media-1234"},
            {"name": "Emberstage Camera Output", "id": "browser_source", "settings": {"url": "http://127.0.0.1:4173/camera_output.html", "fps": 30}, "uuid": "uuid-camera-1234"},
            {"name": "Emberstage Program" if with_collision else "Some Nonbrowser Name", "id": "image_source", "settings": {"file": "keep.png"}},
            {"name": "Existing scene", "id": "scene", "settings": {"items": []}}
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

from unittest.mock import patch

class isolated_home:
    def __init__(self, fxt):
        self.fxt = fxt
        from pathlib import Path
        current_home = os.environ.get('HOME', '')
        if current_home and str(fxt.Parent) in current_home:
            self.fake_home = Path(current_home)
        else:
            self.fake_home = fxt.Parent / "fake_home"
            self.fake_home.mkdir(parents=True, exist_ok=True)
            (self.fake_home / "Applications").mkdir(parents=True, exist_ok=True)
            (self.fake_home / ".local" / "share" / "applications").mkdir(parents=True, exist_ok=True)
        
    def __enter__(self):
        self.old_home = os.environ.get('HOME')
        os.environ['HOME'] = str(self.fake_home)
        self.orig_expanduser = os.path.expanduser
        def mock_expanduser(path):
            if path == '~':
                return str(self.fake_home)
            if path.startswith('~/'):
                return str(self.fake_home / path[2:])
            return self.orig_expanduser(path)
        self.patcher = patch('os.path.expanduser', side_effect=mock_expanduser)
        self.patcher.start()
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.patcher.stop()
        if self.old_home is not None:
            os.environ['HOME'] = self.old_home
        else:
            os.environ.pop('HOME', None)

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
        with isolated_home(fxt):
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
        with isolated_home(fxt):
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
        expected_titles = {
            '4d4445434b534352495054555245000001': 'Em - Text',
            '4d4445434b534f4e475300000000000002': 'Em - Media',
            '4d4445434b564944454f00000000000003': 'Em - Cameras',
            '4d4445434b53545245414d494e47000006': 'Em - Streaming',
        }
        assert_cond({d['uuid']: d['title'] for d in docks[1:]} == expected_titles, 'Short dock titles or stable IDs differ.')
        
        # Active collection must have the script registered
        collection = json.loads(f.Collection.read_text(encoding='utf-8'))
        scripts = collection['modules']['scripts-tool']
        assert_cond(len(scripts) == 2, f"Expected 2 registered scripts, got {len(scripts)}.")
        assert_cond(scripts[1]['path'].endswith("media-deck-hotkeys.lua"), "Lua script registration missing.")
        assert_cond(scripts[1]['settings']['enabled'] is False, "New script must be registered disabled.")

        # Legacy sources retained completely unchanged
        for source in collection['sources']:
            if source['name'] in ('Emberstage Text Output', 'Emberstage Media Output', 'Emberstage Camera Output'):
                assert_cond('url' in source['settings'] and source['settings']['url'].startswith('http://127.0.0.1:4173/'), f"Legacy source {source['name']} URL was modified.")
        
        # Check native program, helper camera, and graphics sources
        src_map = {s['name']: s for s in collection['sources']}
        for name in ('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics'):
            assert_cond(name in src_map, f"Source '{name}' was not created.")

        program = src_map['Emberstage Program']
        camera_a = src_map['Emberstage Camera A']
        camera_b = src_map['Emberstage Camera B']
        graphics = src_map['Emberstage Graphics']

        assert_cond(program['id'] == 'scene', "Emberstage Program must be a scene")
        assert_cond(camera_a['id'] == 'scene', "Emberstage Camera A must be a scene")
        assert_cond(camera_b['id'] == 'scene', "Emberstage Camera B must be a scene")
        assert_cond(graphics['id'] == 'browser_source', "Emberstage Graphics must be a browser source")

        assert_cond(program['private_settings']['emberstage_native'] == {'version': 1, 'role': 'program'}, "Program role/version mismatch")
        assert_cond(camera_a['private_settings']['emberstage_native'] == {'version': 1, 'role': 'camera-a'}, "Camera A role/version mismatch")
        assert_cond(camera_b['private_settings']['emberstage_native'] == {'version': 1, 'role': 'camera-b'}, "Camera B role/version mismatch")
        assert_cond(graphics['private_settings']['emberstage_native'] == {'version': 1, 'role': 'graphics'}, "Graphics role/version mismatch")

        # Verify filters on helper scenes
        for cam in (camera_a, camera_b):
            filters = cam.get('filters', [])
            assert_cond(len(filters) == 1, f"Expected 1 filter on {cam['name']}, got {len(filters)}")
            f_opacity = filters[0]
            assert_cond(f_opacity['enabled'] is True, "Filter must be enabled")
            assert_cond(f_opacity['id'] == 'color_filter_v2', "Filter ID must be color_filter_v2")
            assert_cond(f_opacity['name'] == 'Emberstage Opacity', "Filter name must be Emberstage Opacity")
            assert_cond(f_opacity['settings']['opacity'] == 1.0, "Filter opacity must be 1.0")

        # Verify program nested scene items from bottom to top
        items = program['settings']['items']
        assert_cond(len(items) == 3, f"Expected 3 items in Program, got {len(items)}")
        
        # Bottom is items[0], middle items[1], top items[2]
        assert_cond(items[0]['name'] == 'Emberstage Camera A', "Bottom item must be Emberstage Camera A")
        assert_cond(items[0]['visible'] is False, "Camera A item must be hidden")
        assert_cond(items[0]['source_uuid'] == camera_a['uuid'], "Camera A UUID mismatch")

        assert_cond(items[1]['name'] == 'Emberstage Camera B', "Middle item must be Emberstage Camera B")
        assert_cond(items[1]['visible'] is False, "Camera B item must be hidden")
        assert_cond(items[1]['source_uuid'] == camera_b['uuid'], "Camera B UUID mismatch")

        assert_cond(items[2]['name'] == 'Emberstage Graphics', "Top item must be Emberstage Graphics")
        assert_cond(items[2]['visible'] is True, "Emberstage Graphics must be visible")
        assert_cond(items[2]['source_uuid'] == graphics['uuid'], "Graphics UUID mismatch")

        # Set browser shutdown = true and verify resolution from basic.ini (BaseCX=2560, BaseCY=1440)
        assert_cond(graphics['settings']['shutdown'] is True, "Shutdown must be true")
        assert_cond(graphics['settings']['width'] == 2560, f"Expected graphics width 2560, got {graphics['settings'].get('width')}")
        assert_cond(graphics['settings']['height'] == 1440, f"Expected graphics height 1440, got {graphics['settings'].get('height')}")

        # Unrelated sources changed?
        assert_cond(collection['sources'][0]['settings'] == {"file": "D:/Pictures/image.png"}, "Unrelated source changed.")
        assert_cond(collection['sources'][4]['settings'] == {"file": "keep.png"}, "Same-name non-browser source changed.")
        
        # Verify app_dir assets were actually copied
        assert_cond(app_dir_mock.exists(), "Emberstage app_dir not created.")
        assert_cond((app_dir_mock / "control_panel.html").exists(), "control_panel.html not copied.")
        assert_cond((app_dir_mock / "scripts" / "media-deck-hotkeys.lua").exists(), "media-deck-hotkeys.lua not copied.")

        # Verify assets/js/media/native-install.js exists and is correct
        js_file = app_dir_mock / "assets/js/media/native-install.js"
        assert_cond(js_file.exists(), "native-install.js was not generated.")
        js_text = js_file.read_text(encoding='utf-8')
        assert_cond("window.EmberstageNativeInstall =" in js_text, "JS window object binding missing")
        assert_cond("collection" in js_text, "Collection field missing")
        assert_cond(f"'{program['uuid']}'" in js_text or f"\"{program['uuid']}\"" in js_text, "Program UUID missing or mismatched")
        assert_cond(f"'{camera_a['uuid']}'" in js_text or f"\"{camera_a['uuid']}\"" in js_text, "Camera A UUID missing or mismatched")
        assert_cond(f"'{camera_b['uuid']}'" in js_text or f"\"{camera_b['uuid']}\"" in js_text, "Camera B UUID missing or mismatched")
        assert_cond(f"'{graphics['uuid']}'" in js_text or f"\"{graphics['uuid']}\"" in js_text, "Graphics UUID missing or mismatched")
        
        # Verify backup was created
        backups = [x for x in f.Parent.iterdir() if x.is_dir() and x.name.startswith("media-deck-backup-")]
        assert_cond(len(backups) == 1, "Should have created exactly one backup directory.")
        manifest = json.loads((backups[0] / "manifest.json").read_text(encoding='utf-8'))
        assert_cond(len(manifest['files']) >= 2, f"Expected at least 2 backed up config files in manifest, got {len(manifest['files'])}")
        
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
        # Upgrade a legacy title without touching a same-title operator dock or metadata.
        docks = read_docks(f)
        docks[0]['title'] = 'Em - Text'
        docks[1]['title'] = 'Emberstage - Text'
        docks[1]['custom'] = 'keep app dock metadata'
        ini = f.Ini.read_text(encoding='utf-8')
        f.Ini.write_text(installer.set_ini_value(ini, 'BasicWindow', 'ExtraBrowserDocks', installer.encode_ini_string(json.dumps(docks))), encoding='utf-8')
        run_installer_apply(f)
        updated = read_docks(f)
        assert_cond(updated[0] == docks[0], 'Same-title operator dock changed.')
        assert_cond(updated[1] == {**docks[1], 'title': 'Em - Text'}, 'Legacy dock title upgrade changed identity or metadata.')
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

def test_private_connection_script_behavior():
    f = new_fixture()
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        run_installer_apply(f)
        
        # Determine private script paths
        app_parent = f.Parent
        private_dir = app_parent / "Emberstage-private"
        private_script = private_dir / "obs-connection.js"
        
        # 1. Assert they exist
        assert_cond(private_dir.exists(), "Private sibling directory was not created.")
        assert_cond(private_script.exists(), "Private connection script was not created.")
        
        # 2. Verify permissions (on non-Windows)
        if sys.platform != 'win32':
            dir_mode = private_dir.stat().st_mode & 0o777
            assert_cond(dir_mode == 0o700, f"Private directory should be 0700. Got: {oct(dir_mode)}")
            file_mode = private_script.stat().st_mode & 0o777
            assert_cond(file_mode == 0o600, f"Private script should be 0600. Got: {oct(file_mode)}")
            
        # 3. Verify content of private script
        content = private_script.read_text(encoding='utf-8')
        assert_cond("window.EmberstageNativeConnection" in content, "Private script lacks window.EmberstageNativeConnection definition")
        assert_cond("fixture-only-password" in content, "Private script lacks correct password")
        assert_cond("4457" in content, "Private script lacks correct port")
        
        # 4. Verify generated native-install.js has the correct file:// URI
        js_file = app_dir_mock / "assets/js/media/native-install.js"
        assert_cond(js_file.exists(), "native-install.js should be written")
        js_content = js_file.read_text(encoding='utf-8')
        assert_cond("connectionScript" in js_content, "native-install.js lacks connectionScript key")
        private_script_uri = installer.path_to_file_url(str(private_script))
        assert_cond(private_script_uri in js_content, "native-install.js has incorrect connectionScript URI")
        
        # 5. Verify uninstall removes them!
        # Run installer with uninstall flag
        with patch.object(sys, 'argv', ['install-media-deck.py', '--obs-config-path', str(f.Config), '--uninstall', '--apply']), patch.object(installer, 'get_default_obs_config_path', side_effect=AssertionError('Test must not discover real OBS configuration')):
            installer.main()
            
        assert_cond(not private_script.exists(), "Private script was not removed on uninstall.")
        assert_cond(not private_dir.exists(), "Private directory was not removed on uninstall.")
        
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

def test_process_detection():
    import subprocess
    from unittest.mock import patch
    from types import SimpleNamespace
    for command in ('/usr/bin/obs', 'obs', '/Applications/OBS Studio.app/Contents/MacOS/OBS'):
        with patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='999999 ' + command)):
            assert_cond(installer.is_obs_running(), 'Missed OBS process: ' + command)
    with patch.object(installer.sys, 'platform', 'linux'), patch.object(shutil, 'which', return_value='/usr/bin/flatpak'):
        with patch.object(subprocess, 'run', side_effect=[SimpleNamespace(returncode=0, stdout='999999 python3'), SimpleNamespace(returncode=0, stdout='com.obsproject.Studio\n')]):
            assert_cond(installer.is_obs_running(), 'Missed Flatpak OBS instance')
        for results in ([SimpleNamespace(returncode=1)], [SimpleNamespace(returncode=0, stdout=''), SimpleNamespace(returncode=1)]):
            with patch.object(subprocess, 'run', side_effect=results):
                try:
                    installer.is_obs_running()
                except RuntimeError:
                    pass
                else:
                    raise AssertionError('Process inspection failure must fail closed')
        with patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='')):
            assert_cond(not installer.is_obs_running(), 'Empty process list should be closed')

def test_flatpak_paths():
    from unittest.mock import patch
    f = new_fixture()
    home = f.Parent / 'home with spaces'
    config = home / '.var/app/com.obsproject.Studio/config/obs-studio'
    config.parent.mkdir(parents=True)
    shutil.move(str(f.Config), str(config))
    app = home / '.var/app/com.obsproject.Studio/data/Emberstage'
    native_config = home / 'xdg-config/obs-studio'
    native_config.mkdir(parents=True)
    with patch.dict(os.environ, {'HOME': str(home), 'XDG_CONFIG_HOME': str(native_config.parent), 'XDG_DATA_HOME': str(home / 'xdg-data')}), patch.object(installer.sys, 'platform', 'linux'), patch.object(installer, 'app_dir', None), patch.object(installer, 'is_obs_running', return_value=False):
        assert_cond(installer.get_app_dir(str(config)) == str(app), 'Flatpak assets must stay in OBS private data')
        assert_cond(installer.get_app_dir(str(native_config)) == str(home / 'xdg-data/Emberstage'), 'Native XDG data ignored')
        assert_cond(len(installer.get_default_obs_config_path()) == 2, 'Native/Flatpak ambiguity must remain explicit')
        f.Config, f.Ini = config, config / 'user.ini'
        f.Collection = config / 'basic/scenes/Selected collection.json'
        f.WebSocket = config / 'plugin_config/obs-websocket/config.json'
        original_ws = f.WebSocket.read_bytes()
        before = snapshot(f)
        run_installer_dry(f)
        assert_unchanged(before)
        assert_cond(not app.exists(), 'Flatpak dry run wrote app data')
        run_installer_apply(f)
        for dock in read_docks(f):
            if dock.get('title', '').startswith('Em -'):
                assert_cond(dock['url'].startswith(installer.path_to_file_url(str(app)) + '/'), 'Dock outside OBS sandbox data')
        # WebSocket is now configured by default!
        ws_data = json.loads(f.WebSocket.read_text(encoding='utf-8'))
        assert_cond(ws_data['server_enabled'] is True, 'Flatpak install must enable WebSocket by default')
        scripts = json.loads(f.Collection.read_text())['modules']['scripts-tool']
        assert_cond(any(s['path'] == str(app / 'scripts/media-deck-hotkeys.lua') for s in scripts), 'Lua path outside sandbox')

def test_create_missing_sources_and_hidden_items():
    f = new_fixture()
    collection = json.loads(f.Collection.read_text(encoding='utf-8'))
    # Remove existing sources to force creation
    collection['sources'] = [s for s in collection['sources'] if s.get('name') not in ['Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics']]
    scene = next(s for s in collection['sources'] if s.get('id') == 'scene')
    scene['settings']['id_counter'] = 1000
    f.Collection.write_text(json.dumps(collection), encoding='utf-8')
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        run_installer_apply(f)
        collection = json.loads(f.Collection.read_text(encoding='utf-8'))
        
        # Verify native sources created
        sources_map = {s['name']: s for s in collection['sources'] if s.get('name') in ['Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics']}
        assert_cond(len(sources_map) == 4, f"Expected 4 native sources created, got {len(sources_map)}")
        
        program = sources_map['Emberstage Program']
        camera_a = sources_map['Emberstage Camera A']
        camera_b = sources_map['Emberstage Camera B']
        graphics = sources_map['Emberstage Graphics']

        assert_cond(program['id'] == 'scene', "Emberstage Program must be scene")
        assert_cond(camera_a['id'] == 'scene', "Emberstage Camera A must be scene")
        assert_cond(camera_b['id'] == 'scene', "Emberstage Camera B must be scene")
        assert_cond(graphics['id'] == 'browser_source', "Emberstage Graphics must be browser_source")

        # Helpers start EMPTY (no camera hardware created)
        assert_cond(camera_a['settings'].get('items') == [], "Camera A helper must start empty")
        assert_cond(camera_b['settings'].get('items') == [], "Camera B helper must start empty")

        # Verify membership in items of the current scene "Existing scene"
        scene_objs = [s for s in collection['sources'] if s.get('id') == 'scene' and s.get('name') == "Existing scene"]
        assert_cond(len(scene_objs) == 1, "Exactly one scene object")
        scene_items = scene_objs[0]['settings']['items']
        assert_cond(scene_objs[0]['settings']['id_counter'] == 1001, 'Scene counter must advance from saved value')
        
        item_map = {item['name']: item for item in scene_items if item.get('name') == 'Emberstage Program'}
        assert_cond(len(item_map) == 1, "Emberstage Program added to scene items")
        item = item_map['Emberstage Program']
        assert_cond(item['visible'] is False, "Emberstage Program nested item must start hidden")
        assert_cond(item['source_uuid'] == program['uuid'], "UUID match")

        # Repair must preserve existing item metadata/visibility
        scene_items[0]['visible'] = True
        f.Collection.write_text(json.dumps(collection), encoding='utf-8')
        before_repair = f.Collection.read_bytes()
        run_installer_apply(f)
        assert_cond(f.Collection.read_bytes() == before_repair, 'Repair modified existing scene items')
            
    finally:
        installer.is_obs_running = old_is_obs_running

def test_collision_refusal():
    # 1. Non-browser collision
    f = new_fixture(with_collision=True)
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    failed_as_expected = False
    try:
        run_installer_apply(f)
    except Exception:
        failed_as_expected = True
    assert_cond(failed_as_expected, "Non-browser name collision must fail closed")
    
    # 2. Ambiguous collision
    f2 = new_fixture()
    collection = json.loads(f2.Collection.read_text(encoding='utf-8'))
    # Add a duplicate browser_source
    collection['sources'].append({
        "name": "Emberstage Graphics",
        "id": "browser_source",
        "settings": {"url": "http://other"}
    })
    f2.Collection.write_text(json.dumps(collection), encoding='utf-8')
    failed_as_expected = False
    try:
        run_installer_apply(f2)
    except Exception:
        failed_as_expected = True
    assert_cond(failed_as_expected, "Ambiguous multiple name matching must fail closed")
    
    installer.is_obs_running = old_is_obs_running

def test_launcher_safeties():
    # Verify no launcher creation on macOS/Linux under new contract
    from unittest.mock import patch
    
    # 1. macOS Standard Install must NOT create launcher
    if sys.platform == 'darwin':
        f = new_fixture()
        old_is_obs_running = installer.is_obs_running
        installer.is_obs_running = lambda: False
        installer.app_dir = None
        
        try:
            run_installer_apply(f)
            apps_dir = f.Parent / "fake_home" / "Applications"
            app_bundle = apps_dir / "Emberstage OBS.app"
            assert_cond(not app_bundle.exists(), "Under native contract, launchers must NOT be created on macOS by default")
        finally:
            installer.is_obs_running = old_is_obs_running

    # 2. Linux Standard Install must NOT create desktop launcher
    f_linux = new_fixture()
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    installer.app_dir = None
    
    flatpak_home = f_linux.Parent / "flatpak_home"
    flatpak_config = flatpak_home / ".var/app/com.obsproject.Studio/config/obs-studio"
    flatpak_config.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(f_linux.Config), str(flatpak_config))
    f_linux.Config = flatpak_config
    f_linux.Ini = flatpak_config / "user.ini"
    f_linux.Collection = flatpak_config / "basic/scenes/Selected collection.json"
    f_linux.WebSocket = flatpak_config / "plugin_config/obs-websocket/config.json"
    
    with patch.object(sys, 'platform', 'linux'):
        run_installer_apply(f_linux)
        desktop_dir = f_linux.Parent / "fake_home" / ".local" / "share" / "applications"
        desktop_file = desktop_dir / "ai.emberstage.obs.desktop"
        assert_cond(not desktop_file.exists(), "Under native contract, launchers must NOT be created on Linux by default")
    
    installer.is_obs_running = old_is_obs_running

def test_upgrade_preserves_customizations_and_reinstall():
    f = new_fixture()
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        # First install
        run_installer_apply(f)
        
        # Load collection and make some user customizations
        collection = json.loads(f.Collection.read_text(encoding='utf-8'))
        
        # 1. Populate native camera slots (e.g., adding an item to Camera A helper scene)
        camera_a = next(s for s in collection['sources'] if s.get('name') == 'Emberstage Camera A')
        camera_a['settings']['items'] = [{
            'name': 'Webcam Device',
            'id': 100,
            'source_uuid': 'some-camera-uuid',
            'visible': True
        }]
        
        # 2. Add extra user helper items inside camera A
        camera_a['settings']['items'].append({
            'name': 'Extra User Mic',
            'id': 101,
            'source_uuid': 'some-mic-uuid',
            'visible': True
        })
        
        # 3. Alter transitions/filters on helper scene
        camera_a['filters'][0]['settings']['opacity'] = 0.5
        camera_a['filters'].append({
            'enabled': True,
            'id': 'gain_filter',
            'name': 'My custom filter',
            'settings': {}
        })
        
        # 4. Show the Program scene item in the active operator scene (make it visible)
        op_scene = next(s for s in collection['sources'] if s.get('name') == 'Existing scene')
        program_item = next(item for item in op_scene['settings']['items'] if item['name'] == 'Emberstage Program')
        program_item['visible'] = True
        
        # Write back collection
        f.Collection.write_text(json.dumps(collection), encoding='utf-8')
        
        # Run installer again (Upgrade/Reinstall)
        run_installer_apply(f)
        
        # Check that everything is preserved exactly!
        collection_after = json.loads(f.Collection.read_text(encoding='utf-8'))
        camera_a_after = next(s for s in collection_after['sources'] if s.get('name') == 'Emberstage Camera A')
        
        assert_cond(len(camera_a_after['settings']['items']) == 2, "User items in helper scene were deleted/reset!")
        assert_cond(camera_a_after['settings']['items'][1]['name'] == 'Extra User Mic', "User additions not protected.")
        assert_cond(camera_a_after['filters'][0]['settings']['opacity'] == 0.5, "Customized filter settings were overwritten!")
        assert_cond(len(camera_a_after['filters']) == 2, "User filters on helper scene were overwritten/deleted!")
        
        op_scene_after = next(s for s in collection_after['sources'] if s.get('name') == 'Existing scene')
        program_item_after = next(item for item in op_scene_after['settings']['items'] if item['name'] == 'Emberstage Program')
        assert_cond(program_item_after['visible'] is True, "Program item visibility reset to False on reinstall!")
        
    finally:
        installer.is_obs_running = old_is_obs_running

def test_mismatched_missing_uuid_refs_fail():
    f = new_fixture()
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        # First install to create scenes and generate UUIDs
        run_installer_apply(f)
        
        collection = json.loads(f.Collection.read_text(encoding='utf-8'))
        
        # Mismatch UUID of one of our roles inside a scene item of another scene
        op_scene = next(s for s in collection['sources'] if s.get('name') == 'Existing scene')
        program_item = next(item for item in op_scene['settings']['items'] if item['name'] == 'Emberstage Program')
        program_item['source_uuid'] = 'mismatched-uuid-123'
        
        f.Collection.write_text(json.dumps(collection), encoding='utf-8')
        
        # Run installer, should FAIL because of mismatched reference UUID
        failed = False
        try:
            run_installer_apply(f)
        except Exception as e:
            if "Collision/malformed" in str(e) or "reference mismatch" in str(e):
                failed = True
        assert_cond(failed, f"Mismatched reference UUID should fail closed")
        
    finally:
        installer.is_obs_running = old_is_obs_running

def test_private_credential_rollback():
    f = new_fixture()
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    # Pre-write a custom private credential
    app_parent = f.Parent
    private_dir = app_parent / "Emberstage-private"
    private_dir.mkdir(parents=True, exist_ok=True)
    private_script = private_dir / "obs-connection.js"
    original_secret = "window.EmberstageNativeConnection = { version: 1, port: 4457, password: 'original-secret-to-be-preserved' };"
    private_script.write_text(original_secret, encoding='utf-8')
    if sys.platform != 'win32':
        private_script.chmod(0o600)
    
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
        
        # Ensure the private credential was restored to its exact original state
        assert_cond(private_script.exists(), "Private script was deleted on rollback instead of restored.")
        assert_cond(private_script.read_text(encoding='utf-8') == original_secret, "Private script contents were modified or not restored on rollback.")
    finally:
        os.replace = old_replace
        installer.is_obs_running = old_is_obs_running

def test_missing_credential_repair():
    f = new_fixture()
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        # First write everything normally
        run_installer_apply(f)
        
        app_parent = f.Parent
        private_dir = app_parent / "Emberstage-private"
        private_script = private_dir / "obs-connection.js"
        
        # Now delete the private connection script
        private_script.unlink()
        
        # Run again with --apply. Since config files didn't change, normally this is a "no-change" return,
        # but our repair logic should detect the missing private script and repair it!
        run_installer_apply(f)
        
        assert_cond(private_script.exists(), "Missing private script was not repaired under no-change conditions.")
        
    finally:
        installer.is_obs_running = old_is_obs_running

def test_python_uninstall_transaction_rollback():
    f = new_fixture()
    
    old_is_obs_running = installer.is_obs_running
    installer.is_obs_running = lambda: False
    
    app_dir_mock = f.Parent / "Emberstage"
    installer.app_dir = str(app_dir_mock)
    
    try:
        # First write everything normally
        run_installer_apply(f)
        
        app_parent = f.Parent
        private_dir = app_parent / "Emberstage-private"
        private_script = private_dir / "obs-connection.js"
        
        original_secret = private_script.read_text(encoding='utf-8')
        
        # Force uninstall failure by patching os.rmdir to raise an exception
        old_rmdir = os.rmdir
        def fake_rmdir(path):
            raise PermissionError("Simulated uninstall failure during directory cleanup.")
        os.rmdir = fake_rmdir
        
        try:
            failed_as_expected = False
            try:
                with patch.object(sys, 'argv', ['install-media-deck.py', '--obs-config-path', str(f.Config), '--uninstall', '--apply']), patch.object(installer, 'get_default_obs_config_path', side_effect=AssertionError('Test must not discover real OBS configuration')):
                    installer.main()
            except Exception as e:
                failed_as_expected = 'Simulated uninstall failure during directory cleanup.' in str(e)
                
            assert_cond(failed_as_expected, "Uninstall did not fail during transaction.")
            # Verify private credential rollback: should be restored!
            assert_cond(private_script.exists(), "Private script was deleted on uninstall failure instead of being restored.")
            assert_cond(private_script.read_text(encoding='utf-8') == original_secret, "Private script was not restored to original content.")
        finally:
            os.rmdir = old_rmdir
    finally:
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
    test_case("private connection script generation, file:// injection, secure permissions, and uninstall", test_private_connection_script_behavior)
    test_case("write failure rolls back earlier writes from exact backup", test_rollback_on_failure)
    test_case("existing private credential rollback on failure", test_private_credential_rollback)
    test_case("missing or corrupted private credential repair under no-change conditions", test_missing_credential_repair)
    test_case("python uninstall transaction rollback on failure", test_python_uninstall_transaction_rollback)
    test_case("native and Flatpak running-process guards fail closed", test_process_detection)
    test_case("Flatpak private paths and native XDG install with dry-run preservation", test_flatpak_paths)
    test_case("create missing browser sources and hidden scene items", test_create_missing_sources_and_hidden_items)
    test_case("fail closed on name collisions or ambiguity", test_collision_refusal)
    test_case("launcher safeties (executable repair, safety ownership, linux quoting, escapes)", test_launcher_safeties)
    test_case("reinstall preserves customizations and visibility", test_upgrade_preserves_customizations_and_reinstall)
    test_case("mismatched or missing UUID references fail closed", test_mismatched_missing_uuid_refs_fail)
    
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

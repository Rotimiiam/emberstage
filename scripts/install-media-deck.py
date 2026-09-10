#!/usr/bin/env python3
"""Emberstage macOS and Linux installer.

Dry-run by default. Close OBS yourself before --apply. No OBS launch, source edits,
browser credentials, network requests, firewall changes, or automatic restart.
"""

import sys
import os
import re
import json
import uuid
import shutil
import urllib.parse
import datetime
import argparse

# Global tracking for planning and atomic rollback
original_files = {}
plans = []
app_dir = None

APP_FILES = [
    'control_panel.html',
    'browser_source.html',
    'media_dock.html',
    'camera_dock.html',
    'media_setup.html',
    'picture_picker.html',
    'video_mixer.html',
    'media_output.html',
    'camera_output.html',
    'streaming_dock.html',
]
APP_DIRS = ['assets', 'scripts']
OUTPUT_FILES = {
    'Emberstage Text Output': 'browser_source.html',
    'Emberstage Media Output': 'media_output.html',
    'Emberstage Camera Output': 'camera_output.html',
}

def get_app_dir():
    global app_dir
    if app_dir is not None:
        return app_dir
    home = os.path.expanduser('~')
    if sys.platform == 'darwin':
        return os.path.join(home, 'Library/Application Support/Emberstage')
    else:
        return os.path.join(home, '.local/share/Emberstage')

def is_obs_running():
    try:
        import subprocess
        res = subprocess.run(['ps', '-ax'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode != 0:
            return False
        
        own_pid = os.getpid()
        for line in res.stdout.splitlines():
            line_lower = line.lower()
            parts = line.strip().split(None, 4)
            if not parts or not parts[0].isdigit() or int(parts[0]) == own_pid:
                continue
            
            # Check for macOS app bundle path or general obs name
            if '/obs.app/' in line_lower or 'com.obsproject.studio' in line_lower:
                return True
                
            if len(parts) < 5:
                continue
            cmd_path = parts[4]
            basename = os.path.basename(cmd_path.split()[0]).lower()
            if basename in ('obs', 'obs64', 'obs32', 'obs-studio'):
                return True
    except Exception:
        pass
    return False

def get_default_obs_config_path():
    home = os.path.expanduser('~')
    paths = []
    
    macos_path = os.path.join(home, 'Library/Application Support/obs-studio')
    linux_native_path = os.path.join(home, '.config/obs-studio')
    linux_flatpak_path = os.path.join(home, '.var/app/com.obsproject.Studio/config/obs-studio')
    
    if os.path.isdir(macos_path):
        paths.append(('macOS', macos_path))
    if os.path.isdir(linux_native_path):
        paths.append(('Linux native', linux_native_path))
    if os.path.isdir(linux_flatpak_path):
        paths.append(('Linux Flatpak', linux_flatpak_path))
        
    return paths

def read_config_text(path):
    with open(path, 'rb') as f:
        bytes_data = f.read()
    
    original_files[path] = bytes_data
    
    try:
        has_bom = bytes_data.startswith(b'\xef\xbb\xbf')
        if has_bom:
            text = bytes_data[3:].decode('utf-8')
        else:
            text = bytes_data.decode('utf-8')
    except UnicodeDecodeError:
        raise Exception(f"Unsupported config encoding: {path} (expected UTF-8).")
        
    if '\x00' in text:
        raise Exception(f"Unsupported config encoding: {path} (expected UTF-8).")
        
    return text, has_bom

def get_ini_record(text, section, key):
    lines = re.findall(r'[^\r\n]*(?:\r\n|\n|\r|$)', text)
    if lines and lines[-1] == '':
        lines.pop()
        
    inside = False
    sections_count = 0
    entry = None
    insert_idx = -1
    
    current_index = 0
    for line in lines:
        content = line.rstrip('\r\n')
        m_sec = re.match(r'^\s*\[([^\]]+)\]\s*(?:[;#].*)?$', content)
        if m_sec:
            inside = m_sec.group(1) == section
            if inside:
                sections_count += 1
                if sections_count > 1:
                    raise Exception(f"Ambiguous INI: repeated [{section}] section.")
                insert_idx = current_index + len(line)
        elif inside:
            m_key = re.match(r'^\s*' + re.escape(key) + r'\s*=(.*)$', content, re.IGNORECASE)
            if m_key:
                if entry is not None:
                    raise Exception(f"Ambiguous INI: repeated [{section}] {key}.")
                val_start_in_line = m_key.start(1)
                entry = {
                    'value': m_key.group(1),
                    'index': current_index + val_start_in_line,
                    'length': len(m_key.group(1))
                }
        current_index += len(line)
        
    return entry, insert_idx

def set_ini_value(text, section, key, value):
    entry, insert_idx = get_ini_record(text, section, key)
    if entry is not None:
        idx = entry['index']
        length = entry['length']
        return text[:idx] + value + text[idx + length:]
        
    newline = '\r\n'
    m_ending = re.search(r'\r\n|\n|\r', text)
    if m_ending:
        newline = m_ending.group(0)
        
    if insert_idx >= 0:
        prefix = ''
        if insert_idx > 0 and text[insert_idx - 1] not in ('\n', '\r'):
            prefix = newline
        return text[:insert_idx] + prefix + key + '=' + value + newline + text[insert_idx:]
        
    separator = ''
    if len(text) > 0 and text[-1] not in ('\n', '\r'):
        separator = newline
    return text + separator + '[' + section + ']' + newline + key + '=' + value + newline

def decode_ini_string(val):
    val = val.strip()
    if val.startswith('"') and val.endswith('"'):
        val = val[1:-1]
    
    def repl(m):
        char = m.group(1)
        if char == '\\': return '\\'
        if char == '"': return '"'
        if char == 'n': return '\n'
        if char == 'r': return '\r'
        if char == 't': return '\t'
        return char
    
    return re.sub(r'\\([\\"nrt])', repl, val)

def encode_ini_string(val):
    return val.replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')

def read_json_object(text, label):
    try:
        obj = json.loads(text)
    except Exception:
        raise Exception(f"Invalid JSON in {label}. No configuration was changed.")
        
    if not isinstance(obj, dict):
        raise Exception(f"Expected a JSON object in {label}.")
        
    assert_json_depth(obj, 0)
    return obj

def assert_json_depth(val, depth):
    if depth > 80:
        raise Exception('Config nesting exceeds the safe JSON serialization limit.')
    if isinstance(val, dict):
        for v in val.values():
            assert_json_depth(v, depth + 1)
    elif isinstance(val, list):
        for v in val:
            assert_json_depth(v, depth + 1)

def path_to_file_url(path):
    abs_path = os.path.abspath(path)
    return 'file://' + urllib.parse.quote(abs_path, safe='/')

def add_plan(path, relative, text, description, preserve_bom=False):
    exists = os.path.exists(path)
    original = b''
    if exists:
        if path not in original_files:
            raise Exception(f"Missing planning snapshot: {path}")
        original = original_files[path]
        
    bytes_data = text.encode('utf-8')
    if preserve_bom and len(original) >= 3 and original[0] == 239 and original[1] == 187 and original[2] == 191:
        bytes_data = b'\xef\xbb\xbf' + bytes_data
        
    if exists and original == bytes_data:
        return
        
    plans.append({
        'path': path,
        'relative': relative,
        'bytes': bytes_data,
        'original': original,
        'existed': exists,
        'description': description
    })

def ensure_directory(path, created_list):
    if os.path.isdir(path):
        return
    parent = os.path.dirname(path)
    if not parent or parent == path:
        raise Exception(f"Cannot create directory: {path}")
    ensure_directory(parent, created_list)
    os.makedirs(path, exist_ok=True)
    created_list.append(path)

def copy_app_assets(repo_root, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    for filename in APP_FILES:
        src = os.path.join(repo_root, filename)
        if not os.path.isfile(src) or os.path.islink(src):
            raise Exception(f"Required app file is missing or unsafe: {filename}")
        shutil.copy2(src, os.path.join(dest_dir, filename))
             
    for dirname in APP_DIRS:
        src = os.path.join(repo_root, dirname)
        if not os.path.isdir(src) or os.path.islink(src):
            raise Exception(f"Required app directory is missing or unsafe: {dirname}")
        for walk_root, walk_dirs, walk_files in os.walk(src):
            walk_dirs[:] = [d for d in walk_dirs if d != '__pycache__']
            for name in walk_dirs + walk_files:
                if os.path.islink(os.path.join(walk_root, name)):
                    relative = os.path.relpath(os.path.join(walk_root, name), repo_root)
                    raise Exception(f"Symbolic links are not allowed in installed app assets: {relative}")
        shutil.copytree(src, os.path.join(dest_dir, dirname), ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))

def app_asset_files(root):
    result = {}
    for filename in APP_FILES:
        path = os.path.join(root, filename)
        if not os.path.isfile(path) or os.path.islink(path):
            return None
        result[filename] = path
    for dirname in APP_DIRS:
        base = os.path.join(root, dirname)
        if not os.path.isdir(base) or os.path.islink(base):
            return None
        for walk_root, walk_dirs, walk_files in os.walk(base):
            walk_dirs[:] = sorted(d for d in walk_dirs if d != '__pycache__')
            for name in walk_files:
                if name.endswith('.pyc'):
                    continue
                path = os.path.join(walk_root, name)
                if os.path.islink(path):
                    return None
                result[os.path.relpath(path, root)] = path
    return result

def app_assets_match(source_root, installed_root):
    source = app_asset_files(source_root)
    installed = app_asset_files(installed_root)
    if source is None or installed is None or set(source) != set(installed):
        return False
    for relative in source:
        with open(source[relative], 'rb') as source_file, open(installed[relative], 'rb') as installed_file:
            if source_file.read() != installed_file.read():
                return False
    return True

def main():
    parser = argparse.ArgumentParser(description="Install Emberstage macOS and Linux support.")
    parser.add_argument('--apply', action='store_true', help="Explicitly apply the planned configuration changes.")
    parser.add_argument('--obs-config-path', type=str, default=None, help="The path to the OBS config directory containing user.ini.")
    parser.add_argument('--enable-websocket', action='store_true', help="Opt-in to enable and configure OBS WebSocket.")
    
    args = parser.parse_args()
    apply = args.apply
    enable_websocket = args.enable_websocket
    
    if apply and is_obs_running():
        print("Apply refused: OBS is running. Close every OBS instance yourself, then retry.", file=sys.stderr)
        sys.exit(1)
        
    # Resolve paths
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    
    # Check default config paths if not specified
    if args.obs_config_path:
        config_root = os.path.abspath(os.path.expanduser(args.obs_config_path))
    else:
        paths = get_default_obs_config_path()
        if len(paths) > 1:
            found_str = ", ".join([f"{name} ({path})" for name, path in paths])
            print(f"Ambiguous OBS configuration paths found: {found_str}. Please specify --obs-config-path explicitly.", file=sys.stderr)
            sys.exit(1)
        elif len(paths) == 1:
            config_root = paths[0][1]
        else:
            print("OBS config directory is missing. Start and configure OBS yourself once, then close it; or specify --obs-config-path.", file=sys.stderr)
            sys.exit(1)
            
    if not os.path.isdir(config_root):
        print("OBS config directory is missing. Start and configure OBS yourself once, then close it; or specify --obs-config-path.", file=sys.stderr)
        sys.exit(1)
        
    # Verify checkout complete
    required_files = APP_FILES + ['scripts/media-deck-hotkeys.lua']
    for r_file in required_files:
        if not os.path.exists(os.path.join(repo_root, r_file)):
            print(f"Required app file missing: {r_file}. Use a complete app checkout; nothing was installed.", file=sys.stderr)
            sys.exit(1)
            
    # Resolve stable installed app location
    app_dir = get_app_dir()
    app_changed = not app_assets_match(repo_root, app_dir)
        
    ini_path = os.path.join(config_root, 'user.ini')
    if not os.path.exists(ini_path):
        print("user.ini is missing. Select a scene collection in OBS yourself, close OBS, and retry.", file=sys.stderr)
        sys.exit(1)
        
    # Read user.ini
    try:
        ini, ini_bom = read_config_text(ini_path)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
        
    collection_record, _ = get_ini_record(ini, 'Basic', 'SceneCollectionFile')
    if collection_record is None:
        print("Missing [Basic] SceneCollectionFile in user.ini. Select the intended collection in OBS, close OBS, and retry. No collection is guessed.", file=sys.stderr)
        sys.exit(1)
        
    collection_name = decode_ini_string(collection_record['value'])
    if (not collection_name or 
        re.search(r'[\\/:*?"<>|\x00-\x1f]', collection_name) or
        collection_name in ('.', '..') or 
        collection_name.endswith('.') or 
        collection_name.endswith(' ') or 
        os.path.isabs(collection_name)):
        print("Unsafe SceneCollectionFile: expected a filename only, not an absolute path or directory traversal.", file=sys.stderr)
        sys.exit(1)
        
    if not collection_name.lower().endswith('.json'):
        collection_name += '.json'
        
    collection_relative = os.path.join('basic', 'scenes', collection_name)
    collection_path = os.path.join(config_root, collection_relative)
    if not os.path.exists(collection_path):
        print("The selected scene collection file is missing. Select the intended collection in OBS, close OBS, and retry. No fallback collection is used.", file=sys.stderr)
        sys.exit(1)
        
    # Read collection JSON
    try:
        col_text, col_bom = read_config_text(collection_path)
        collection = read_json_object(col_text, 'active scene collection')
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
        
    # Setup Docks
    dock_specs = [
        { 'uuid': '4d4445434b534352495054555245000001', 'title': 'Emberstage - Text', 'file': 'control_panel.html', 'query': '' },
        { 'uuid': '4d4445434b534f4e475300000000000002', 'title': 'Emberstage - Media', 'file': 'media_dock.html', 'query': '' },
        { 'uuid': '4d4445434b564944454f00000000000003', 'title': 'Emberstage - Cameras', 'file': 'camera_dock.html', 'query': '' },
        { 'uuid': '4d4445434b53545245414d494e47000006', 'title': 'Emberstage – Streaming', 'file': 'streaming_dock.html', 'query': '' }
    ]
    
    docks_record, _ = get_ini_record(ini, 'BasicWindow', 'ExtraBrowserDocks')
    docks = []
    if docks_record is not None and docks_record['value'].strip():
        dock_json = decode_ini_string(docks_record['value'])
        try:
            wrapper = read_json_object('{"items":' + dock_json + '}', 'ExtraBrowserDocks')
        except Exception as e:
            print(f"ExtraBrowserDocks must be a JSON array. {e}", file=sys.stderr)
            sys.exit(1)
        if not isinstance(wrapper.get('items'), list):
            print("ExtraBrowserDocks must be a JSON array.", file=sys.stderr)
            sys.exit(1)
        for dock in wrapper['items']:
            if not isinstance(dock, dict):
                print("ExtraBrowserDocks contains a non-object entry.", file=sys.stderr)
                sys.exit(1)
            docks.append(dock)
            
    # Retire only the exact app-owned Setup dock; preserve customer docks, even namesakes.
    retained_docks = [d for d in docks if d.get('uuid') != '4d4445434b534554555000000000000005']
    docks_changed = len(retained_docks) != len(docks)
    docks = retained_docks
    for spec in dock_specs:
        app_file_path = os.path.join(app_dir, spec['file'])
        url = path_to_file_url(app_file_path) + spec['query']
        if not url.startswith('file:///'):
            print("App files must resolve to local file:/// URLs, not a network share.", file=sys.stderr)
            sys.exit(1)
            
        matches_owned = [d for d in docks if 'uuid' in d and d['uuid'] == spec['uuid']]
        if len(matches_owned) > 1:
            print("Duplicate app-owned dock UUID found. Resolve the duplicate manually; nothing was changed.", file=sys.stderr)
            sys.exit(1)
            
        if len(matches_owned) == 0:
            docks.append({ 'title': spec['title'], 'url': url, 'uuid': spec['uuid'] })
            docks_changed = True
        else:
            dock = matches_owned[0]
            if 'title' not in dock or dock['title'] != spec['title']:
                dock['title'] = spec['title']
                docks_changed = True
            if 'url' not in dock or dock['url'] != url:
                dock['url'] = url
                docks_changed = True
                
    if docks_changed:
        new_ini = set_ini_value(ini, 'BasicWindow', 'ExtraBrowserDocks', encode_ini_string(json.dumps(docks, separators=(',', ':'))))
        add_plan(ini_path, 'user.ini', new_ini, 'Add/update four Emberstage browser docks; remove retired Setup dock; retain other docks and layout.', preserve_bom=ini_bom)
        
    # Setup Lua
    collection_changed = False
    repointed_outputs = []

    # Repair only Emberstage-owned outputs. Older installs pointed these at a
    # temporary localhost server, leaving every output black when it stopped.
    sources = collection.get('sources', [])
    if not isinstance(sources, list):
        print("Scene collection sources must be an array.", file=sys.stderr)
        sys.exit(1)
    for source in sources:
        if not isinstance(source, dict):
            continue
        source_name = source.get('name')
        filename = OUTPUT_FILES.get(source_name) if isinstance(source_name, str) else None
        if not filename or source.get('id') != 'browser_source':
            continue
        settings = source.setdefault('settings', {})
        if not isinstance(settings, dict):
            print(f"{source_name} has invalid browser settings; nothing was changed.", file=sys.stderr)
            sys.exit(1)
        output_url = path_to_file_url(os.path.abspath(os.path.join(app_dir, filename)))
        # OBS maps `is_local_file=true` pages to an internal http://absolute/
        # origin. Custom docks stay on file://, which isolates BroadcastChannel
        # and leaves the controls permanently waiting. Loading the output URL as
        # file:// keeps the dock and output on the same local origin.
        if (settings.get('is_local_file') is not False or
                settings.get('local_file', '') != '' or
                settings.get('url') != output_url):
            settings['is_local_file'] = False
            settings['local_file'] = ''
            settings['url'] = output_url
            collection_changed = True
            repointed_outputs.append(source_name)

    if 'modules' not in collection:
        collection['modules'] = {}
        collection_changed = True
    if not isinstance(collection['modules'], dict):
        print("Scene collection modules must be a JSON object.", file=sys.stderr)
        sys.exit(1)
    if 'scripts-tool' not in collection['modules']:
        collection['modules']['scripts-tool'] = []
        collection_changed = True
        
    scripts = collection['modules']['scripts-tool']
    if not isinstance(scripts, list):
        print("Scene collection modules/scripts-tool must be an array.", file=sys.stderr)
        sys.exit(1)
        
    lua_path = os.path.abspath(os.path.join(app_dir, 'scripts', 'media-deck-hotkeys.lua'))
    lua_path_json = lua_path.replace('\\', '/')
    checkout_lua_path = os.path.abspath(os.path.join(repo_root, 'scripts', 'media-deck-hotkeys.lua'))
    
    existing_lua = []
    for script in scripts:
        if not isinstance(script, dict) or 'path' not in script or not isinstance(script['path'], str):
            print("Scene collection contains an invalid script entry; nothing was changed.", file=sys.stderr)
            sys.exit(1)
        norm_path = os.path.abspath(script['path'].replace('\\', '/'))
        if norm_path == os.path.abspath(lua_path):
            existing_lua.append(script)
        elif os.path.basename(script['path'].replace('\\', '/')) == 'media-deck-hotkeys.lua':
            if norm_path == checkout_lua_path:
                # Migrate this installer's legacy checkout-relative registration
                # to the stable app directory without changing its settings or
                # hotkey bindings.
                script['path'] = lua_path_json
                existing_lua.append(script)
                collection_changed = True
            else:
                print("Media Deck Lua is already registered from another folder. Remove or move that entry manually to avoid duplicate hotkeys; existing settings were not changed.", file=sys.stderr)
                sys.exit(1)
            
    if len(existing_lua) > 1:
        print("The Media Deck Lua script is registered more than once. Resolve duplicate entries manually.", file=sys.stderr)
        sys.exit(1)
        
    if len(existing_lua) == 0:
        entry = {
            'path': lua_path_json,
            'settings': {
                'output_scene': '',
                'enabled': False,
                'exclusive_video': False,
                'exclusive_picture': False
            }
        }
        scripts.append(entry)
        collection_changed = True
        
    if collection_changed:
        actions = ['Register native Lua in the active collection, initially disarmed with no target or keys']
        if repointed_outputs:
            actions.insert(0, 'Repoint existing Emberstage outputs to stable installed local files')
        add_plan(collection_path, collection_relative, json.dumps(collection, separators=(',', ':')), '; '.join(actions) + '.', preserve_bom=col_bom)
        
    # Setup WebSocket
    if enable_websocket:
        ws_relative = os.path.join('plugin_config', 'obs-websocket', 'config.json')
        ws_path = os.path.join(config_root, ws_relative)
        ws = {}
        ws_bom = False
        if os.path.exists(ws_path):
            try:
                ws_text, ws_bom = read_config_text(ws_path)
                ws = read_json_object(ws_text, 'WebSocket config')
            except Exception as e:
                print(str(e), file=sys.stderr)
                sys.exit(1)
                
        ws_changed = False
        for key in ['server_enabled', 'auth_required']:
            if key not in ws or not isinstance(ws[key], bool) or ws[key] is not True:
                ws[key] = True
                ws_changed = True
                
        if 'server_password' in ws and ws['server_password'] is not None and not isinstance(ws['server_password'], str):
            print("WebSocket server_password must be a string; existing settings were not changed.", file=sys.stderr)
            sys.exit(1)
            
        if 'server_password' not in ws or not ws['server_password'] or ws['server_password'].strip() == '':
            password = 'GENERATED_ONLY_ON_APPLY'
            if apply:
                import base64
                password = base64.b64encode(os.urandom(32)).decode('utf-8')
            ws['server_password'] = password
            ws_changed = True
            
        if ws_changed:
            add_plan(ws_path, ws_relative, json.dumps(ws, separators=(',', ':')), 'Enable WebSocket with authentication; preserve a nonempty password or generate one securely.', preserve_bom=ws_bom)
            
    mode = 'APPLY' if apply else 'DRY RUN'
    print(f"{mode} - config: {config_root}")
    for plan in plans:
        print(f"  {plan['path']}\n    {plan['description']}")
    if app_changed:
        print(f"  {app_dir}\n    Install/update Emberstage app assets in the stable local app folder.")
        
    if not enable_websocket:
        print("WebSocket config is untouched (opt in with --enable-websocket).")
    else:
        print("Keep the OBS WebSocket service private. No firewall or network settings are changed.")
        print("After you start OBS yourself, find the password in Tools > WebSocket Server Settings. Passwords are never printed here.")
        
    if len(plans) == 0 and not app_changed:
        print("No changes needed.")
        return
        
    if not apply:
        print("No files or backups written. Close OBS, inspect this plan, then repeat with --apply.")
        return
        
    # APPLY WRITE AND ROLLBACK
    if is_obs_running():
        print("Apply refused: OBS is running. Close every OBS instance yourself, then retry.", file=sys.stderr)
        sys.exit(1)
        
    config_parent = os.path.dirname(config_root)
    if not os.path.isdir(config_parent):
        print("The selected config parent directory must exist.", file=sys.stderr)
        sys.exit(1)
        
    timestamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')[:-3]
    rand_suffix = uuid.uuid4().hex[:8]
    backup_root = os.path.join(config_parent, f'media-deck-backup-{timestamp}-{rand_suffix}')
    
    written = []
    created_dirs = []
    temp_files = []
    
    app_dir_renamed = False
    app_dir_installed = False
    app_dir_backup = None
    app_dir_tmp = None
    
    try:
        # Verify snapshots
        for plan in plans:
            p_exists = os.path.exists(plan['path'])
            if p_exists != plan['existed']:
                raise Exception('A configuration changed during planning. Retry with OBS closed.')
            if plan['existed']:
                with open(plan['path'], 'rb') as f:
                    current_bytes = f.read()
                if current_bytes != plan['original']:
                    raise Exception('A configuration changed during planning. Retry with OBS closed.')
                    
        # Copy to backup
        os.makedirs(backup_root, exist_ok=True)
        manifest_files = []
        for plan in plans:
            backup_file = os.path.join(backup_root, plan['relative'])
            if plan['existed']:
                os.makedirs(os.path.dirname(backup_file), exist_ok=True)
                shutil.copy2(plan['path'], backup_file)
                with open(backup_file, 'rb') as f:
                    backup_bytes = f.read()
                if backup_bytes != plan['original']:
                    raise Exception('Backup verification failed; no configuration was written.')
            manifest_files.append({
                'relativePath': plan['relative'],
                'existed': plan['existed']
            })
            
        manifest_data = {
            'configRoot': config_root,
            'files': manifest_files
        }
        with open(os.path.join(backup_root, 'manifest.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest_data, f, separators=(',', ':'))
            
        print(f"Backup: {backup_root}")
        
        # Copy assets to a sibling staging directory, then atomically replace the
        # installed app. A successful upgrade retains the prior app in the same
        # timestamped backup as the configuration snapshots.
        if app_changed:
            app_dir_tmp = app_dir + '.tmp-' + rand_suffix
            copy_app_assets(repo_root, app_dir_tmp)

            if os.path.exists(app_dir):
                app_dir_backup = app_dir + '.backup-' + rand_suffix
                os.rename(app_dir, app_dir_backup)
                app_dir_renamed = True

            os.rename(app_dir_tmp, app_dir)
            app_dir_installed = True
        
        # Write config files
        for plan in plans:
            if is_obs_running():
                raise Exception('Apply refused: OBS is running. Close every OBS instance yourself, then retry.')
                
            p_exists = os.path.exists(plan['path'])
            if p_exists != plan['existed']:
                raise Exception('A configuration changed before its write. Installation stopped.')
            if plan['existed']:
                with open(plan['path'], 'rb') as f:
                    current_bytes = f.read()
                if current_bytes != plan['original']:
                    raise Exception('A configuration changed before its write. Installation stopped.')
                    
            ensure_directory(os.path.dirname(plan['path']), created_dirs)
            
            temporary = plan['path'] + '.media-deck-' + uuid.uuid4().hex + '.tmp'
            temp_files.append(temporary)
            
            with open(temporary, 'wb') as f:
                f.write(plan['bytes'])
                
            os.replace(temporary, plan['path'])
            written.append(plan)

        if app_dir_renamed and app_dir_backup and os.path.exists(app_dir_backup):
            previous_app = os.path.join(backup_root, 'previous-app')
            os.rename(app_dir_backup, previous_app)
            app_dir_backup = None
            app_dir_renamed = False
            
    except Exception as e:
        failure_msg = str(e)
        restore_errors = []
        
        for plan in reversed(written):
            try:
                if plan['existed']:
                    backup_file = os.path.join(backup_root, plan['relative'])
                    shutil.copy2(backup_file, plan['path'])
                elif os.path.exists(plan['path']):
                    os.remove(plan['path'])
            except Exception:
                restore_errors.append(plan['path'])
                
        try:
            if app_dir_installed and os.path.exists(app_dir):
                shutil.rmtree(app_dir)
            if app_dir_renamed and app_dir_backup and os.path.exists(app_dir_backup):
                os.rename(app_dir_backup, app_dir)
                app_dir_renamed = False
        except Exception as app_err:
            restore_errors.append(f"app_dir rollback failed: {app_err}")
            
        for temp_file in temp_files:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass
        if app_dir_tmp and os.path.exists(app_dir_tmp):
            try:
                shutil.rmtree(app_dir_tmp)
            except Exception:
                pass
                
        for directory in reversed(created_dirs):
            try:
                if os.path.isdir(directory) and not os.listdir(directory):
                    os.rmdir(directory)
            except Exception:
                pass
                
        if restore_errors:
            print(f"Installation failed; automatic restore could not finish for: {', '.join(restore_errors)}. Restore from {backup_root}. Cause: {failure_msg}", file=sys.stderr)
        else:
            print(f"Installation failed; all installer-written configs were restored. Backup (if created): {backup_root}. Cause: {failure_msg}", file=sys.stderr)
        sys.exit(1)
        
    finally:
        for temp_file in temp_files:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass
        # If restoration failed, retain the previous app for manual recovery.
        if app_dir_tmp and os.path.exists(app_dir_tmp):
            try:
                shutil.rmtree(app_dir_tmp)
            except Exception:
                pass
        for directory in reversed(created_dirs):
            try:
                if os.path.isdir(directory) and not os.listdir(directory):
                    os.rmdir(directory)
            except Exception:
                pass
                
    print("Installed Emberstage docks. Start OBS yourself; arrange docks manually. No source, scene visibility, or stream was changed.")
    print("For a new Lua entry: choose Output scene manually to match the app, assign Settings > Hotkeys, then enable to arm.")
    print(f"Rollback: close OBS; restore the relative files listed in {os.path.join(backup_root, 'manifest.json')} (remove files marked existed=false).")

if __name__ == '__main__':
    main()

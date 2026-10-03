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
    'emberstage_output.html',
]
APP_DIRS = ['assets', 'scripts']

def assert_no_symlink(path):
    curr = os.path.abspath(path)
    while curr and curr != os.path.dirname(curr):
        if os.path.islink(curr):
            raise Exception(f"Symlink/reparse point refused: {curr}")
        curr = os.path.dirname(curr)

def generate_native_install_js(collection_name, program_uuid, camera_a_uuid, camera_b_uuid, graphics_uuid, connection_script_uri):
    return f"""window.EmberstageNativeInstall = {{
  version: 1,
  collection: {json.dumps(collection_name)},
  connectionScript: {json.dumps(connection_script_uri)},
  program: {{
    name: 'Emberstage Program',
    uuid: '{program_uuid}'
  }},
  slots: [
    {{
      name: 'Emberstage Camera A',
      uuid: '{camera_a_uuid}'
    }},
    {{
      name: 'Emberstage Camera B',
      uuid: '{camera_b_uuid}'
    }}
  ],
  graphics: {{
    name: 'Emberstage Graphics',
    uuid: '{graphics_uuid}'
  }}
}};
"""

def get_app_dir(obs_config=None):
    global app_dir
    if app_dir is not None:
        return app_dir
    home = os.path.expanduser('~')
    if sys.platform == 'darwin':
        return os.path.join(home, 'Library/Application Support/Emberstage')
    else:
        flatpak_root = os.path.join(home, '.var/app/com.obsproject.Studio')
        if obs_config and os.path.abspath(obs_config) == os.path.join(flatpak_root, 'config/obs-studio'):
            # The OBS sandbox owns this directory; no broad host filesystem grant.
            return os.path.join(flatpak_root, 'data/Emberstage')
        return os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.join(home, '.local/share'), 'Emberstage')

def is_obs_running():
    try:
        import subprocess
        res = subprocess.run(['ps', '-axo', 'pid=,comm='], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode != 0:
            raise RuntimeError('Cannot inspect running processes; refusing to modify OBS.')
        
        own_pid = os.getpid()
        for line in res.stdout.splitlines():
            parts = line.strip().split(None, 1)
            if not parts or not parts[0].isdigit() or int(parts[0]) == own_pid:
                continue
            
            if len(parts) < 2:
                continue
            cmd_path = parts[1]
            basename = os.path.basename(cmd_path).lower()
            if basename in ('obs', 'obs64', 'obs32', 'obs-studio'):
                return True
        if sys.platform.startswith('linux') and shutil.which('flatpak'):
            result = subprocess.run(['flatpak', 'ps', '--columns=application'], capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError('Cannot inspect Flatpak instances; refusing to modify OBS.')
            if 'com.obsproject.Studio' in result.stdout.splitlines():
                return True
    except OSError as exc:
        raise RuntimeError('Cannot inspect running processes; refusing to modify OBS.') from exc
    return False

def get_default_obs_config_path():
    home = os.path.expanduser('~')
    paths = []
    
    macos_path = os.path.join(home, 'Library/Application Support/obs-studio')
    linux_native_path = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(home, '.config'), 'obs-studio')
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

def get_profile_canvas_dimensions(config_root, ini_text):
    profile_dir = 'Unti' + 'tled'
    dir_record, _ = get_ini_record(ini_text, 'Basic', 'ProfileDir')
    if dir_record is not None and dir_record['value'].strip():
        profile_dir = decode_ini_string(dir_record['value'])
    else:
        name_record, _ = get_ini_record(ini_text, 'Basic', 'Profile')
        if name_record is not None and name_record['value'].strip():
            profile_dir = decode_ini_string(name_record['value'])
            
    basic_ini_path = os.path.join(config_root, 'basic', 'profiles', profile_dir, 'basic.ini')
    if os.path.exists(basic_ini_path):
        try:
            with open(basic_ini_path, 'rb') as f:
                bytes_data = f.read()
            if bytes_data.startswith(b'\xef\xbb\xbf'):
                text = bytes_data[3:].decode('utf-8', errors='ignore')
            else:
                text = bytes_data.decode('utf-8', errors='ignore')
            
            cx_rec, _ = get_ini_record(text, 'Video', 'BaseCX')
            cy_rec, _ = get_ini_record(text, 'Video', 'BaseCY')
            if cx_rec is not None and cy_rec is not None:
                cx = int(cx_rec['value'].strip())
                cy = int(cy_rec['value'].strip())
                return cx, cy
        except Exception:
            pass
    return None

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

def add_plan(path, relative, text, description, preserve_bom=False, is_exec=False):
    exists = os.path.exists(path)
    original = b''
    original_mode = None
    if exists:
        if path not in original_files:
            raise Exception(f"Missing planning snapshot: {path}")
        original = original_files[path]
        original_mode = os.stat(path).st_mode & 0o7777
        
    bytes_data = text.encode('utf-8')
    if preserve_bom and len(original) >= 3 and original[0] == 239 and original[1] == 187 and original[2] == 191:
        bytes_data = b'\xef\xbb\xbf' + bytes_data
        
    needs_exec_repair = False
    if is_exec and exists:
        if original_mode is not None and (original_mode & 0o111) != 0o111:
            needs_exec_repair = True
            
    if exists and original == bytes_data and not needs_exec_repair:
        return
        
    plans.append({
        'path': path,
        'relative': relative,
        'bytes': bytes_data,
        'original': original,
        'existed': exists,
        'description': description,
        'executable': is_exec,
        'original_mode': original_mode
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
                rel = os.path.relpath(path, root)
                if rel.replace('\\', '/') == 'assets/js/media/native-install.js':
                    continue
                result[rel] = path
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

def is_safe_to_write_launcher(path, new_content, old_baselines):
    curr = os.path.abspath(path)
    while curr and curr != os.path.dirname(curr):
        if os.path.islink(curr):
            # macOS system alias, not an operator-controlled launcher directory.
            if not (sys.platform == 'darwin' and curr == '/var' and os.readlink(curr) == 'private/var'):
                raise Exception(f"Unsafe path: {path} contains symlink {curr}")
        curr = os.path.dirname(curr)
        
    if os.path.exists(path) and not os.path.isfile(path):
        raise Exception(f"Unsafe path: {path} is not a regular file")
        
    if os.path.exists(path):
        with open(path, 'rb') as f:
            existing_bytes = f.read()
        try:
            existing_text = existing_bytes.decode('utf-8', errors='ignore').strip()
        except Exception:
            existing_text = ""
            
        new_text = new_content.strip()
        matches_any = (existing_text == new_text)
        for old in old_baselines:
            if existing_text == old.strip():
                matches_any = True
                break
                
        if not matches_any:
            raise Exception(f"Refusing to overwrite unrelated or modified launcher file: {path}")

def add_launcher_plans(app_dir, config_root, apply):
    if sys.platform == 'darwin':
        apps_dir = os.path.expanduser('~/Applications')
        app_bundle = os.path.join(apps_dir, 'Emberstage OBS.app')
        plist_path = os.path.join(app_bundle, 'Contents/Info.plist')
        exec_path = os.path.join(app_bundle, 'Contents/MacOS/Emberstage OBS')
        
        plist_content = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Emberstage OBS</string>
    <key>CFBundleIdentifier</key>
    <string>ai.emberstage.obs</string>
    <key>CFBundleName</key>
    <string>Emberstage OBS</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>EmberstageOwned</key>
    <true/>
</dict>
</plist>
"""
        exec_content = """#!/bin/bash
# Emberstage Owned Launcher
# Check if OBS is already running
if pgrep -x OBS >/dev/null 2>&1; then
  osascript -e 'display dialog "OBS is already running. Please fully quit it, then run Emberstage OBS again to enable camera support." buttons {"OK"} default button "OK" with icon caution'
  exit 2
fi

open -a "/Applications/OBS.app" --args --enable-media-stream
"""

        old_plists = [
            """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.txt">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleExecutable</key>
    <string>Emberstage OBS</string>
    <key>CFBundleIdentifier</key>
    <string>ai.curacel.emberstage.obs</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Emberstage OBS</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
</dict>
</plist>""",
            """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleExecutable</key>
    <string>Emberstage OBS</string>
    <key>CFBundleIdentifier</key>
    <string>ai.curacel.emberstage.obs</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Emberstage OBS</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
</dict>
</plist>"""
        ]
        
        old_execs = [
            """#!/bin/bash
# Check if OBS is already running
if pgrep -x OBS >/dev/null 2>&1; then
  osascript -e 'display dialog "OBS is already running. Please fully quit it, then run Emberstage OBS again to enable camera support." buttons {"OK"} default button "OK" with icon caution'
  exit 2
fi

open -a "/Applications/OBS.app" --args --enable-media-stream"""
        ]

        is_safe_to_write_launcher(plist_path, plist_content, old_plists)
        is_safe_to_write_launcher(exec_path, exec_content, old_execs)

        for path, content, relative, desc, is_exec in [
            (plist_path, plist_content, 'Emberstage_OBS.app_Info.plist', 'macOS Emberstage OBS.app Info.plist', False),
            (exec_path, exec_content, 'Emberstage_OBS.app_Launcher', 'macOS Emberstage OBS.app launcher script', True)
        ]:
            if os.path.exists(path):
                if path not in original_files:
                    with open(path, 'rb') as f:
                        original_files[path] = f.read()
            else:
                original_files[path] = b''
            add_plan(path, relative, content, desc, is_exec=is_exec)
                
    elif sys.platform.startswith('linux') or sys.platform == 'linux':
        if 'com.obsproject.Studio' in config_root:
            mode_arg = '--flatpak'
        elif 'obs-studio' in config_root:
            mode_arg = '--native'
        else:
            raise Exception("Cannot determine OBS installation type (native vs flatpak) from config path. Refusing to create launcher.")
            
        xdg_data_home = os.environ.get('XDG_DATA_HOME')
        if xdg_data_home and os.path.isabs(xdg_data_home):
            desktop_dir = os.path.join(xdg_data_home, 'applications')
        else:
            desktop_dir = os.path.expanduser('~/.local/share/applications')
            
        desktop_path = os.path.join(desktop_dir, 'ai.emberstage.obs.desktop')
        
        script_path = os.path.join(app_dir, 'scripts', 'start-obs-camera-mode-linux.sh')
        if '\n' in script_path or '\r' in script_path:
            raise Exception('Launcher paths must not contain line breaks')
        # Desktop-entry escaping followed by Exec argument escaping (not shell quoting).
        slash = chr(92)
        escaped_script_path = ''.join(
            slash * 4 if char == slash else slash * 2 + char if char in '"`$'
            else '%%' if char == '%' else char for char in script_path)
        
        desktop_content = f"""[Desktop Entry]
Type=Application
Name=Emberstage OBS
Comment=Launch OBS Studio with camera enabled for Emberstage
Exec=bash "{escaped_script_path}" {mode_arg}
Icon=obs
Terminal=false
Categories=AudioVideo;Recorder;
"""
        old_desktops = [
            f"""[Desktop Entry]
Type=Application
Name=Emberstage OBS
Comment=Launch OBS Studio with camera enabled for Emberstage
Exec=bash "{os.path.join(app_dir, 'scripts', 'start-obs-camera-mode-linux.sh')}"
Icon=obs
Terminal=false
Categories=AudioVideo;Recorder;
"""
        ]

        is_safe_to_write_launcher(desktop_path, desktop_content, old_desktops)

        if os.path.exists(desktop_path):
            if desktop_path not in original_files:
                with open(desktop_path, 'rb') as f:
                    original_files[desktop_path] = f.read()
        else:
            original_files[desktop_path] = b''
        add_plan(desktop_path, 'emberstage-obs.desktop', desktop_content, 'Linux Emberstage OBS desktop launcher')

def main():
    parser = argparse.ArgumentParser(description="Install Emberstage macOS and Linux support.")
    parser.add_argument('--apply', action='store_true', help="Explicitly apply the planned configuration changes.")
    parser.add_argument('--obs-config-path', type=str, default=None, help="The path to the OBS config directory containing user.ini.")
    parser.add_argument('--enable-websocket', action='store_true', help="Opt-in to enable and configure OBS WebSocket.")
    parser.add_argument('--uninstall', action='store_true', help="Uninstall/remove Emberstage app assets and configurations.")
    
    args = parser.parse_args()
    apply = args.apply
    enable_websocket = True # accepted compatibility but automatic default now
    uninstall = args.uninstall
    
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
    app_dir = get_app_dir(config_root)
    
    if uninstall:
        if is_obs_running():
            print("Apply refused: OBS is running. Close every OBS instance yourself, then retry.", file=sys.stderr)
            sys.exit(1)
            
        app_parent = os.path.dirname(app_dir)
        if os.path.basename(app_dir) == 'app' and os.path.basename(os.path.dirname(app_dir)) == 'Emberstage':
            app_parent = os.path.dirname(os.path.dirname(app_dir))
        
        private_dir = os.path.join(app_parent, 'Emberstage-private')
        private_script = os.path.join(private_dir, 'obs-connection.js')

        private_script_existed = os.path.exists(private_script)
        private_script_original_bytes = None
        private_script_original_mode = None
        if private_script_existed:
            try:
                with open(private_script, 'rb') as f:
                    private_script_original_bytes = f.read()
                private_script_original_mode = os.stat(private_script).st_mode & 0o777
            except Exception:
                pass

        private_dir_existed = os.path.isdir(private_dir)
        private_dir_original_mode = None
        if private_dir_existed:
            try:
                private_dir_original_mode = os.stat(private_dir).st_mode & 0o777
            except Exception:
                pass

        try:
            removed_any = False
            if os.path.exists(private_script):
                assert_no_symlink(private_script)
                try:
                    with open(private_script, 'r', encoding='utf-8') as f:
                        head = f.read(100)
                    if 'EmberstageNativeConnection' in head:
                        if apply:
                            os.remove(private_script)
                            print(f"Removed private connection script: {private_script}")
                        else:
                            print(f"DRY RUN - would remove private connection script: {private_script}")
                        removed_any = True
                except Exception as e:
                    print(f"Skipped removing private script: {e}")
                    
            if os.path.isdir(private_dir) and not os.listdir(private_dir):
                assert_no_symlink(private_dir)
                if apply:
                    os.rmdir(private_dir)
                    print(f"Removed private sibling directory: {private_dir}")
                else:
                    print(f"DRY RUN - would remove private sibling directory: {private_dir}")
                removed_any = True
                
            if not removed_any:
                print("Uninstall: No files or configurations need removal.")
            return

        except Exception as e:
            # Uninstall rollback transaction
            if apply:
                try:
                    if private_script_existed and not os.path.exists(private_script):
                        if not os.path.exists(private_dir):
                            os.makedirs(private_dir, exist_ok=True)
                            if private_dir_original_mode is not None:
                                os.chmod(private_dir, private_dir_original_mode)
                        orig_bytes = private_script_original_bytes
                        if orig_bytes is not None:
                            with open(private_script, 'wb') as f:
                                f.write(orig_bytes)
                        if private_script_original_mode is not None:
                            os.chmod(private_script, private_script_original_mode)
                        print(f"Restored private connection script during uninstall rollback: {private_script}")
                except Exception as restore_err:
                    print(f"Failed to restore private script during rollback: {restore_err}", file=sys.stderr)
            raise e
        
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
        { 'uuid': '4d4445434b534352495054555245000001', 'title': 'Em - Text', 'file': 'control_panel.html', 'query': '' },
        { 'uuid': '4d4445434b534f4e475300000000000002', 'title': 'Em - Media', 'file': 'media_dock.html', 'query': '' },
        { 'uuid': '4d4445434b564944454f00000000000003', 'title': 'Em - Cameras', 'file': 'camera_dock.html', 'query': '' },
        { 'uuid': '4d4445434b53545245414d494e47000006', 'title': 'Em - Streaming', 'file': 'streaming_dock.html', 'query': '' }
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
        
    # Setup Lua and Native Scenes
    collection_changed = False
    added_sources = []
    added_items = []
    repointed_outputs = []

    sources = collection.get('sources', [])
    if not isinstance(sources, list):
        print("Scene collection sources must be an array.", file=sys.stderr)
        sys.exit(1)

    EXPECTED_NAMES = {'Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B', 'Emberstage Graphics'}
    uuid_regex = r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

    new_sources_data = {
        'program': {'name': 'Emberstage Program', 'id': 'scene', 'role': 'program', 'uuid': None, 'source_obj': None, 'is_new': True},
        'camera-a': {'name': 'Emberstage Camera A', 'id': 'scene', 'role': 'camera-a', 'uuid': None, 'source_obj': None, 'is_new': True},
        'camera-b': {'name': 'Emberstage Camera B', 'id': 'scene', 'role': 'camera-b', 'uuid': None, 'source_obj': None, 'is_new': True},
        'graphics': {'name': 'Emberstage Graphics', 'id': 'browser_source', 'role': 'graphics', 'uuid': None, 'source_obj': None, 'is_new': True}
    }

    # 1. Gather all UUIDs to check for uniqueness
    all_uuids_in_collection = {}
    role_uuids = {}
    for src in sources:
        if not isinstance(src, dict):
            continue
        u = src.get('uuid')
        name = src.get('name')
        if u is not None:
            if not isinstance(u, str) or u == "":
                if name in EXPECTED_NAMES:
                    print(f"Collision/malformed: source '{name}' has empty or invalid UUID. No changes were made.", file=sys.stderr)
                    sys.exit(1)
            else:
                all_uuids_in_collection.setdefault(u, []).append(name)
                if name in EXPECTED_NAMES:
                    role_uuids[name] = u
        else:
            if name in EXPECTED_NAMES:
                print(f"Collision/malformed: source '{name}' has empty or invalid UUID. No changes were made.", file=sys.stderr)
                sys.exit(1)

    # Check for duplicate UUIDs
    for u, names in all_uuids_in_collection.items():
        if len(names) > 1:
            if any(n in EXPECTED_NAMES for n in names):
                print(f"Collision/malformed: duplicate UUID '{u}' found for sources: {names}. No changes were made.", file=sys.stderr)
                sys.exit(1)

    # Verify source reference consistency in scene items
    for src in sources:
        if not isinstance(src, dict) or src.get('id') != 'scene':
            continue
        settings = src.get('settings', {})
        if not isinstance(settings, dict):
            continue
        items = settings.get('items', [])
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            item_name = item.get('name')
            item_uuid = item.get('source_uuid')
            
            if item_name in EXPECTED_NAMES:
                if item_name in role_uuids:
                    expected_role_u = role_uuids[item_name]
                    if item_uuid != expected_role_u:
                        print(f"Collision/malformed: reference mismatch in scene '{src.get('name')}' for item '{item_name}'. Item references UUID '{item_uuid}', but source UUID is '{expected_role_u}'. No changes were made.", file=sys.stderr)
                        sys.exit(1)
            
            for role_name, role_u in role_uuids.items():
                if item_uuid == role_u and item_name != role_name:
                    print(f"Collision/malformed: reference mismatch in scene '{src.get('name')}' for item '{item_name}'. Item references UUID '{item_uuid}' belonging to '{role_name}'. No changes were made.", file=sys.stderr)
                    sys.exit(1)

    # 1b. Check name collisions and validate types/markers
    all_source_names = {}
    for src in sources:
        if isinstance(src, dict) and isinstance(src.get('name'), str):
            all_source_names.setdefault(src['name'], []).append(src)

    for key, spec in new_sources_data.items():
        name = spec['name']
        if name in all_source_names:
            matches = all_source_names[name]
            if len(matches) > 1:
                print(f"Ambiguous collision: multiple sources found with name '{name}'. No changes were made.", file=sys.stderr)
                sys.exit(1)
            src = matches[0]
            if src.get('id') != spec['id']:
                print(f"Name collision: source '{name}' exists but is of type '{src.get('id')}', expected '{spec['id']}'. No changes were made.", file=sys.stderr)
                sys.exit(1)
            private_settings = src.get('private_settings', {})
            if not isinstance(private_settings, dict):
                print(f"Collision: source '{name}' has invalid private_settings. No changes were made.", file=sys.stderr)
                sys.exit(1)
            marker = private_settings.get('emberstage_native')
            if not isinstance(marker, dict) or marker.get('version') != 1 or marker.get('role') != spec['role']:
                print(f"Collision any same name/type/marker mismatch -> refuse before writes: source '{name}' does not have a valid native marker. No changes were made.", file=sys.stderr)
                sys.exit(1)
            
            # Check UUID matches the expected format too
            existing_u = src.get('uuid')
            if not isinstance(existing_u, str) or not re.match(uuid_regex, existing_u):
                print(f"Collision/malformed: source '{name}' has empty or invalid UUID. No changes were made.", file=sys.stderr)
                sys.exit(1)
                
            spec['uuid'] = existing_u
            spec['source_obj'] = src
            spec['is_new'] = False

    for key, spec in new_sources_data.items():
        if spec['uuid'] is None:
            spec['uuid'] = str(uuid.uuid4())

    # 2. Get video defaults (profile basic.ini first, then collection.video, then 1920x1080)
    base_width = 1920
    base_height = 1080
    profile_dims = get_profile_canvas_dimensions(config_root, ini)
    if profile_dims is not None:
        base_width, base_height = profile_dims
    else:
        video = collection.get('video')
        if isinstance(video, dict):
            bw = video.get('base_width')
            bh = video.get('base_height')
            if isinstance(bw, (int, float)) and isinstance(bh, (int, float)):
                base_width = int(bw)
                base_height = int(bh)

    # 3. Create or update sources
    for key, spec in new_sources_data.items():
        name = spec['name']
        source_uuid = spec['uuid']
        src = spec['source_obj']

        if src is None:
            src = {
                'name': name,
                'id': spec['id'],
                'uuid': source_uuid,
                'private_settings': {
                    'emberstage_native': {
                        'version': 1,
                        'role': spec['role']
                    }
                },
                'settings': {}
            }
            sources.append(src)
            spec['source_obj'] = src
            collection_changed = True
            added_sources.append(name)
        else:
            if src.get('uuid') != source_uuid:
                src['uuid'] = source_uuid
                collection_changed = True
            p_settings = src.setdefault('private_settings', {})
            if p_settings.get('emberstage_native') != {'version': 1, 'role': spec['role']}:
                p_settings['emberstage_native'] = {'version': 1, 'role': spec['role']}
                collection_changed = True

        if spec['role'] == 'graphics':
            output_url = path_to_file_url(os.path.abspath(os.path.join(app_dir, 'emberstage_output.html')))
            settings = src.setdefault('settings', {})
            if (settings.get('is_local_file') is not False or
                    settings.get('local_file', '') != '' or
                    settings.get('url') != output_url or
                    settings.get('width') != base_width or
                    settings.get('height') != base_height or
                    settings.get('shutdown') is not True):
                settings['is_local_file'] = False
                settings['local_file'] = ''
                settings['url'] = output_url
                settings['width'] = base_width
                settings['height'] = base_height
                settings['shutdown'] = True
                collection_changed = True
                repointed_outputs.append(name)

        elif spec['role'] in ('camera-a', 'camera-b'):
            if spec['is_new']:
                settings = src.setdefault('settings', {})
                if 'items' not in settings or settings['items'] != []:
                    settings['items'] = []
                    collection_changed = True
                expected_filters = [
                    {
                        'enabled': True,
                        'id': 'color_filter_v2',
                        'name': 'Emberstage Opacity',
                        'settings': {
                            'opacity': 1.0
                        }
                    }
                ]
                src['filters'] = expected_filters
                collection_changed = True

        elif spec['role'] == 'program':
            if spec['is_new']:
                settings = src.setdefault('settings', {})
                expected_items = [
                    {
                        'name': 'Emberstage Camera A',
                        'id': 1,
                        'source_uuid': new_sources_data['camera-a']['uuid'],
                        'visible': False,
                        'locked': False,
                        'pos': {'x': 0.0, 'y': 0.0},
                        'rot': 0.0,
                        'scale': {'x': 1.0, 'y': 1.0},
                        'align': 5,
                        'bounds_type': 0,
                        'bounds_align': 5,
                        'bounds': {'x': 0.0, 'y': 0.0},
                        'crop_left': 0,
                        'crop_right': 0,
                        'crop_top': 0,
                        'crop_bottom': 0
                    },
                    {
                        'name': 'Emberstage Camera B',
                        'id': 2,
                        'source_uuid': new_sources_data['camera-b']['uuid'],
                        'visible': False,
                        'locked': False,
                        'pos': {'x': 0.0, 'y': 0.0},
                        'rot': 0.0,
                        'scale': {'x': 1.0, 'y': 1.0},
                        'align': 5,
                        'bounds_type': 0,
                        'bounds_align': 5,
                        'bounds': {'x': 0.0, 'y': 0.0},
                        'crop_left': 0,
                        'crop_right': 0,
                        'crop_top': 0,
                        'crop_bottom': 0
                    },
                    {
                        'name': 'Emberstage Graphics',
                        'id': 3,
                        'source_uuid': new_sources_data['graphics']['uuid'],
                        'visible': True,
                        'locked': False,
                        'pos': {'x': 0.0, 'y': 0.0},
                        'rot': 0.0,
                        'scale': {'x': 1.0, 'y': 1.0},
                        'align': 5,
                        'bounds_type': 0,
                        'bounds_align': 5,
                        'bounds': {'x': 0.0, 'y': 0.0},
                        'crop_left': 0,
                        'crop_right': 0,
                        'crop_top': 0,
                        'crop_bottom': 0
                    }
                ]
                settings['items'] = expected_items
                settings['id_counter'] = 3
                collection_changed = True

    # 4. Handle scene_order
    scene_order = collection.setdefault('scene_order', [])
    for scene_name in ('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B'):
        if not any(isinstance(x, dict) and x.get('name') == scene_name for x in scene_order):
            scene_order.append({'name': scene_name})
            collection_changed = True

    # 5. Resolve current_scene safely
    current_scene_name = collection.get('current_scene')
    if not isinstance(current_scene_name, str) or not current_scene_name:
        print("Missing or invalid current_scene name in scene collection. No changes were made.", file=sys.stderr)
        sys.exit(1)

    if current_scene_name not in ('Emberstage Program', 'Emberstage Camera A', 'Emberstage Camera B'):
        scene_objs = [s for s in sources if isinstance(s, dict) and s.get('id') == 'scene' and s.get('name') == current_scene_name]
        if len(scene_objs) == 0:
            print(f"Current scene '{current_scene_name}' not found as a scene source object in the collection. No changes were made.", file=sys.stderr)
            sys.exit(1)
        if len(scene_objs) > 1:
            print(f"Ambiguity: multiple scene sources found with name '{current_scene_name}'. No changes were made.", file=sys.stderr)
            sys.exit(1)
            
        current_scene_obj = scene_objs[0]
        scene_settings = current_scene_obj.setdefault('settings', {})
        if not isinstance(scene_settings, dict):
            print("Current scene source has invalid settings field. No changes were made.", file=sys.stderr)
            sys.exit(1)
        scene_items = scene_settings.setdefault('items', [])
        if not isinstance(scene_items, list):
            print("Current scene settings/items is not a list. No changes were made.", file=sys.stderr)
            sys.exit(1)

        id_counter = scene_settings.get('id_counter', 0)
        if type(id_counter) is not int or id_counter < 0:
            raise ValueError('Invalid current scene item counter; nothing was changed.')
        for item in scene_items:
            if isinstance(item, dict) and type(item.get('id')) is int:
                id_counter = max(id_counter, item['id'])

        # 6. Add program scene to current scene items as a hidden nested scene item if not present
        program_uuid = new_sources_data['program']['uuid']
        program_name = new_sources_data['program']['name']
        
        existing_item = None
        for item in scene_items:
            if isinstance(item, dict) and (item.get('name') == program_name or item.get('source_uuid') == program_uuid):
                if item.get('source_uuid') and item['source_uuid'] != program_uuid:
                    raise ValueError(f'Conflicting scene item source identity: {program_name}; nothing was changed.')
                existing_item = item
                break
                
        if existing_item is None:
            id_counter += 1
            new_item = {
                'name': program_name,
                'id': id_counter,
                'source_uuid': program_uuid,
                'visible': False,
                'locked': False,
                'pos': { 'x': 0.0, 'y': 0.0 },
                'rot': 0.0,
                'scale': { 'x': 1.0, 'y': 1.0 },
                'align': 5,
                'bounds_type': 0,
                'bounds_align': 5,
                'bounds': { 'x': 0.0, 'y': 0.0 },
                'crop_left': 0,
                'crop_right': 0,
                'crop_top': 0,
                'crop_bottom': 0
            }
            scene_items.append(new_item)
            added_items.append(program_name)
            collection_changed = True
            scene_settings['id_counter'] = id_counter

    # 7. Setup Lua Script Registration
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

    # 7.5. Process OBS WebSocket config and prepare private connection script
    # WebSocket is configured by default now (automatic default, compatibility accepted)
    ws_relative = os.path.join('plugin_config', 'obs-websocket', 'config.json')
    ws_path = os.path.join(config_root, ws_relative)
    ws = {}
    ws_bom = False
    if os.path.exists(ws_path):
        try:
            ws_text, ws_bom = read_config_text(ws_path)
            ws = read_json_object(ws_text, 'WebSocket config')
        except Exception as e:
            print(f"WebSocket config is malformed: {e}", file=sys.stderr)
            sys.exit(1) # Malformed config fail closed

    ws_changed = False
    for key in ['server_enabled', 'auth_required']:
        if key not in ws or not isinstance(ws[key], bool) or ws[key] is not True:
            ws[key] = True
            ws_changed = True

    # Validate/preserve server_port
    ws_port = 4455
    if 'server_port' in ws:
        try:
            ws_port = int(ws['server_port'])
            if not (1 <= ws_port <= 65535):
                raise ValueError()
            ws['server_port'] = ws_port
        except (ValueError, TypeError):
            print("Invalid WebSocket server_port. Malformed config fail closed.", file=sys.stderr)
            sys.exit(1)
    else:
        ws['server_port'] = ws_port

    # Preserve binds (reject known explicit non-loopback incompatible bind, not wildcard binding)
    for key in ('server_ip', 'bind_ip', 'bind_addr', 'listen_ip', 'listen_addr'):
        if key in ws and ws[key]:
            ip_val = str(ws[key]).strip().lower()
            if ip_val and ip_val not in ('0.0.0.0', '::', '*', '127.0.0.1', '::1', 'localhost'):
                print(f"Rejecting known explicit non-loopback incompatible bind '{ws[key]}'.", file=sys.stderr)
                sys.exit(1) # Fail closed

    # Manage server_password
    if 'server_password' in ws and ws['server_password'] is not None and not isinstance(ws['server_password'], str):
        print("WebSocket server_password must be a string; existing settings were not changed.", file=sys.stderr)
        sys.exit(1)

    generated_password = None
    if 'server_password' not in ws or not ws['server_password'] or ws['server_password'].strip() == '':
        generated_password = 'GENERATED_ONLY_ON_APPLY'
        if apply:
            import base64
            generated_password = base64.b64encode(os.urandom(32)).decode('utf-8')
        ws['server_password'] = generated_password
        ws_changed = True

    ws_password_for_script = ws.get('server_password')
    if ws_password_for_script == 'GENERATED_ONLY_ON_APPLY' and generated_password:
        ws_password_for_script = generated_password

    if ws_changed:
        add_plan(ws_path, ws_relative, json.dumps(ws, separators=(',', ':')), 'Enable WebSocket with authentication; preserve a nonempty password or generate one securely.', preserve_bom=ws_bom)

    # Compute private sibling paths
    app_parent = os.path.dirname(app_dir)
    if os.path.basename(app_dir) == 'app' and os.path.basename(os.path.dirname(app_dir)) == 'Emberstage':
        app_parent = os.path.dirname(os.path.dirname(app_dir))
    
    private_dir = os.path.join(app_parent, 'Emberstage-private')
    private_script = os.path.join(private_dir, 'obs-connection.js')
    private_script_uri = path_to_file_url(private_script)

    private_js_content = f"""window.EmberstageNativeConnection = {{
  version: 1,
  port: {ws_port},
  password: {json.dumps(ws_password_for_script)}
}};
"""

    # 8. Compute expected native-install.js and resolve app_changed
    # OBS identifies collections by their display name, not their filename.
    obs_collection_name = collection.get('name')
    if not isinstance(obs_collection_name, str) or not obs_collection_name.strip():
        raise ValueError('Scene collection display name is missing or invalid.')

    expected_js_content = generate_native_install_js(
        collection_name=obs_collection_name,
        program_uuid=new_sources_data['program']['uuid'],
        camera_a_uuid=new_sources_data['camera-a']['uuid'],
        camera_b_uuid=new_sources_data['camera-b']['uuid'],
        graphics_uuid=new_sources_data['graphics']['uuid'],
        connection_script_uri=private_script_uri
    )

    static_assets_match = app_assets_match(repo_root, app_dir)
    js_file_path = os.path.join(app_dir, 'assets/js/media/native-install.js')
    js_matches = False
    if os.path.isfile(js_file_path):
        try:
            with open(js_file_path, 'r', encoding='utf-8') as f_js:
                installed_js = f_js.read()
            if installed_js.strip() == expected_js_content.strip():
                js_matches = True
        except Exception:
            pass
            
    app_changed = not (static_assets_match and js_matches)

    private_credential_needs_repair = False
    if not os.path.isdir(private_dir):
        private_credential_needs_repair = True
    elif sys.platform != 'win32':
        try:
            dir_mode = os.stat(private_dir).st_mode & 0o777
            if dir_mode != 0o700:
                private_credential_needs_repair = True
        except Exception:
            private_credential_needs_repair = True
            
    if not os.path.isfile(private_script):
        private_credential_needs_repair = True
    else:
        try:
            with open(private_script, 'r', encoding='utf-8') as f:
                existing_content = f.read()
            if existing_content.strip() != private_js_content.strip():
                private_credential_needs_repair = True
        except Exception:
            private_credential_needs_repair = True
            
        if not private_credential_needs_repair:
            if sys.platform != 'win32':
                try:
                    mode = os.stat(private_script).st_mode & 0o777
                    if mode != 0o600:
                        private_credential_needs_repair = True
                except Exception:
                    private_credential_needs_repair = True
            else:
                username = os.environ.get('USERNAME')
                if username:
                    res = subprocess.run(['icacls', private_script], capture_output=True, text=True)
                    if res.returncode != 0 or username.lower() not in res.stdout.lower():
                        private_credential_needs_repair = True

    # 9. Register Scene Collection Plan
    if collection_changed:
        actions = []
        if added_sources:
            actions.append(f"Create native Emberstage program and camera scenes/sources ({', '.join(added_sources)})")
        if repointed_outputs:
            actions.append(f"Repoint native 'Emberstage Graphics' to stable installed files")
        if added_items:
            actions.append(f"Attach native program scene to current scene '{current_scene_name}'")
        if len(existing_lua) == 0:
            actions.append("Register native Lua in the active collection, initially disarmed with no target or keys")
        elif collection_changed and not (added_sources or repointed_outputs or added_items):
            actions.append("Update scene collection configurations")
            
        add_plan(collection_path, collection_relative, json.dumps(collection, separators=(',', ':')), '; '.join(actions) + '.', preserve_bom=col_bom)
        
    # Setup native launchers (macOS, Linux) (disabled/stopped by default under new native contract)
    # add_launcher_plans(app_dir, config_root, apply)
            
    mode = 'APPLY' if apply else 'DRY RUN'
    print(f"{mode} - config: {config_root}")
    for plan in plans:
        print(f"  {plan['path']}\n    {plan['description']}")
    if app_changed:
        print(f"  {app_dir}\n    Install/update Emberstage app assets in the stable local app folder.")
    print(f"  {private_script}\n    Generate user-only private connection script.")
        
    print("Keep the OBS WebSocket service private. No firewall or network settings are changed.")
    print("After you start OBS yourself, the app connection will configure automatically using the generated connection script. Passwords are never printed here.")
        
    needs_install_or_repair = app_changed or private_credential_needs_repair
    if len(plans) == 0 and not needs_install_or_repair:
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
    
    private_script_existed = os.path.exists(private_script)
    private_script_original_bytes = None
    private_script_original_mode = None
    if private_script_existed:
        try:
            with open(private_script, 'rb') as f:
                private_script_original_bytes = f.read()
            private_script_original_mode = os.stat(private_script).st_mode & 0o777
        except Exception:
            pass

    private_dir_existed = os.path.isdir(private_dir)
    private_dir_original_mode = None
    if private_dir_existed:
        try:
            private_dir_original_mode = os.stat(private_dir).st_mode & 0o777
        except Exception:
            pass

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
        if sys.platform != 'win32':
            os.chmod(backup_root, 0o700)
        else:
            username = os.environ.get('USERNAME')
            if username:
                subprocess.run(['icacls', backup_root, '/inheritance:r', '/grant:r', f'{username}:(OI)(CI)F'], capture_output=True)

        manifest_files = []
        for plan in plans:
            backup_file = os.path.join(backup_root, plan['relative'])
            if plan['existed']:
                os.makedirs(os.path.dirname(backup_file), exist_ok=True)
                if sys.platform != 'win32':
                    os.chmod(os.path.dirname(backup_file), 0o700)
                else:
                    username = os.environ.get('USERNAME')
                    if username:
                        subprocess.run(['icacls', os.path.dirname(backup_file), '/inheritance:r', '/grant:r', f'{username}:(OI)(CI)F'], capture_output=True)
                shutil.copy2(plan['path'], backup_file)
                if sys.platform != 'win32':
                    os.chmod(backup_file, 0o600)
                else:
                    username = os.environ.get('USERNAME')
                    if username:
                        subprocess.run(['icacls', backup_file, '/inheritance:r', '/grant:r', f'{username}:F'], capture_output=True)
                with open(backup_file, 'rb') as f:
                    backup_bytes = f.read()
                if backup_bytes != plan['original']:
                    raise Exception('Backup verification failed; no configuration was written.')
            manifest_files.append({
                'relativePath': plan['relative'],
                'targetPath': plan['path'],
                'originalMode': plan['original_mode'],
                'existed': plan['existed']
            })
            
        manifest_data = {
            'configRoot': config_root,
            'files': manifest_files
        }
        m_path = os.path.join(backup_root, 'manifest.json')
        with open(m_path, 'w', encoding='utf-8') as f:
            json.dump(manifest_data, f, separators=(',', ':'))
        if sys.platform != 'win32':
            os.chmod(m_path, 0o600)
        else:
            username = os.environ.get('USERNAME')
            if username:
                subprocess.run(['icacls', m_path, '/inheritance:r', '/grant:r', f'{username}:F'], capture_output=True)
            
        print(f"Backup: {backup_root}")
        
        # Copy assets to a sibling staging directory, then atomically replace the
        # installed app. A successful upgrade retains the prior app in the same
        # timestamped backup as the configuration snapshots.
        if app_changed:
            app_dir_tmp = app_dir + '.tmp-' + rand_suffix
            copy_app_assets(repo_root, app_dir_tmp)

            # Generate/write native-install.js into app_dir_tmp
            js_tmp_path = os.path.join(app_dir_tmp, 'assets/js/media/native-install.js')
            os.makedirs(os.path.dirname(js_tmp_path), exist_ok=True)
            with open(js_tmp_path, 'w', encoding='utf-8') as f_js:
                f_js.write(expected_js_content)

            if os.path.exists(app_dir):
                app_dir_backup = app_dir + '.backup-' + rand_suffix
                os.rename(app_dir, app_dir_backup)
                app_dir_renamed = True

            os.rename(app_dir_tmp, app_dir)
            app_dir_installed = True
        
        # Write private connection script securely
        assert_no_symlink(private_dir)
        if not os.path.exists(private_dir):
            os.makedirs(private_dir, exist_ok=True)
        if sys.platform != 'win32':
            os.chmod(private_dir, 0o700)
        else:
            username = os.environ.get('USERNAME')
            if username:
                subprocess.run(['icacls', private_dir, '/inheritance:r', '/grant:r', f'{username}:(OI)(CI)F'], capture_output=True)

        temp_private_file = private_script + '.tmp-' + uuid.uuid4().hex[:8]
        temp_files.append(temp_private_file)
        with open(temp_private_file, 'w', encoding='utf-8') as f_priv:
            f_priv.write(private_js_content)
        
        if sys.platform != 'win32':
            os.chmod(temp_private_file, 0o600)
        else:
            username = os.environ.get('USERNAME')
            if username:
                subprocess.run(['icacls', temp_private_file, '/inheritance:r', '/grant:r', f'{username}:F'], capture_output=True)
                
        assert_no_symlink(temp_private_file)
        if os.path.exists(private_script):
            assert_no_symlink(private_script)
            os.replace(temp_private_file, private_script)
        else:
            os.rename(temp_private_file, private_script)
            
        if sys.platform != 'win32':
            os.chmod(private_script, 0o600)
        else:
            username = os.environ.get('USERNAME')
            if username:
                subprocess.run(['icacls', private_script, '/inheritance:r', '/grant:r', f'{username}:F'], capture_output=True)

        # Verify DACL/permissions after final move
        if sys.platform != 'win32':
            mode = os.stat(private_script).st_mode & 0o777
            if mode != 0o600:
                raise Exception(f"File permission verification failed on private connection script. Got: {oct(mode)}")
            dir_mode = os.stat(private_dir).st_mode & 0o777
            if dir_mode != 0o700:
                raise Exception(f"Directory permission verification failed on private sibling directory. Got: {oct(dir_mode)}")
        else:
            username = os.environ.get('USERNAME')
            if username:
                res = subprocess.run(['icacls', private_script], capture_output=True, text=True)
                if username.lower() not in res.stdout.lower():
                    raise Exception("DACL verification failed: username not found in permissions.")

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
                
            if plan.get('existed') and plan.get('original_mode') is not None:
                os.chmod(temporary, plan['original_mode'])
            if plan.get('executable'):
                os.chmod(temporary, 0o755)
                
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
        
        # Rollback/cleanup private files
        try:
            if private_script_existed:
                # Restore original private script
                if not os.path.exists(private_dir):
                    os.makedirs(private_dir, exist_ok=True)
                    if private_dir_original_mode is not None:
                        os.chmod(private_dir, private_dir_original_mode)
                orig_bytes = private_script_original_bytes
                if orig_bytes is not None:
                    with open(private_script, 'wb') as f:
                        f.write(orig_bytes)
                if private_script_original_mode is not None:
                    os.chmod(private_script, private_script_original_mode)
            else:
                # Delete what we created
                if os.path.exists(private_script):
                    os.remove(private_script)
                if os.path.isdir(private_dir) and not os.listdir(private_dir):
                    os.rmdir(private_dir)
        except Exception as priv_err:
            restore_errors.append(f"Failed to restore private script: {priv_err}")

        for plan in reversed(written):
            try:
                if plan['existed']:
                    backup_file = os.path.join(backup_root, plan['relative'])
                    shutil.copy2(backup_file, plan['path'])
                    if plan.get('original_mode') is not None:
                        os.chmod(plan['path'], plan['original_mode'])
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
                
    print("Installed Emberstage docks and output sources. New output items are hidden; existing item visibility and stream state are unchanged. Start OBS yourself.")
    print("Launch OBS normally. Add cameras as OBS Video Capture Device sources, then Em - Cameras will connect automatically. No browser camera flag is required.")
    print("Enable the hidden nested 'Emberstage Program' scene when ready. Keep legacy sources hidden for rollback; do not repoint them to native graphics pages.")
    print("For a new Lua entry: choose Output scene manually to match the app, assign Settings > Hotkeys, then enable to arm.")
    print(f"Rollback: close OBS; restore the relative files listed in {os.path.join(backup_root, 'manifest.json')} (remove files marked existed=false).")

if __name__ == '__main__':
    main()

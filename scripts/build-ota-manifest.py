#!/usr/bin/env python3
"""Generate OTA asset manifest (site/ota-manifest.json) for zero-touch OTA updates."""
import hashlib
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / 'site'
OTA_DIR = SITE_DIR / 'ota'

OTA_FILES = [
    'control_panel.html',
    'browser_source.html',
    'media_dock.html',
    'camera_dock.html',
    'streaming_dock.html',
    'emberstage_output.html',
    'media_output.html',
    'camera_output.html',
]

OTA_ASSET_DIRS = [
    'assets/css',
    'assets/js',
    'assets/brand',
]

EXCLUDED_PATHS = {
    'assets/js/media/native-install.js',
}


def collect_ota_files():
    files = []
    for rel in OTA_FILES:
        p = ROOT / rel
        if p.is_file():
            files.append(rel)
    for d in OTA_ASSET_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for p in sorted(base.rglob('*')):
            if not p.is_file():
                continue
            if p.name.startswith('.') or p.suffix == '.tmp':
                continue
            rel = p.relative_to(ROOT).as_posix()
            if rel in EXCLUDED_PATHS:
                continue
            files.append(rel)
    return sorted(set(files))


def main():
    version_file = SITE_DIR / 'version.json'
    version_data = json.loads(version_file.read_text('utf-8'))
    version = version_data['version']

    if OTA_DIR.exists():
        shutil.rmtree(OTA_DIR)
    OTA_DIR.mkdir(parents=True, exist_ok=True)

    manifest_files = {}
    for rel in collect_ota_files():
        src = ROOT / rel
        raw = src.read_bytes()
        sha256 = hashlib.sha256(raw).hexdigest().lower()
        dst = OTA_DIR / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(raw)
        manifest_files[rel] = {
            'sha256': sha256,
            'size': len(raw),
            'url': f'https://emberstage.pages.dev/ota/{rel}',
        }

    ota_manifest = {
        'version': version,
        'publishedAt': version_data.get('publishedAt', ''),
        'channel': version_data.get('channel', 'beta'),
        'protectedPaths': sorted(EXCLUDED_PATHS),
        'files': manifest_files,
    }

    out_path = SITE_DIR / 'ota-manifest.json'
    out_path.write_text(json.dumps(ota_manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Generated {out_path.relative_to(ROOT)} with {len(manifest_files)} OTA files for v{version}')


if __name__ == '__main__':
    main()

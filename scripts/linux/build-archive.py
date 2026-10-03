#!/usr/bin/env python3
"""Build the offline host installer for native/Flatpak OBS, without server data."""
import importlib.util
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install-media-deck.py')
assert spec is not None and spec.loader is not None
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
files = [ROOT / name for name in installer.APP_FILES] + [
    ROOT / 'LICENSE',
    ROOT / 'THIRD_PARTY_NOTICES.md',
    ROOT / 'scripts/install-media-deck.py',
    ROOT / 'scripts/media-deck-hotkeys.lua',
    ROOT / 'scripts/start-obs-camera-mode-linux.sh',
    ROOT / 'scripts/linux/install-emberstage.sh',
    ROOT / 'scripts/linux/README.md',
]
files += sorted(p for p in (ROOT / 'assets').rglob('*') if not p.is_dir())
files = [p for p in files if p.name != '.DS_Store' and p.suffix not in ('.tmp', '.pyc')]
for path in files:
    if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents)):
        raise SystemExit(f'Missing or unsafe package file: {path}')
# Reject directory symlinks too; archive paths must all stay within this checkout.
if any(p.is_symlink() for p in (ROOT / 'assets').rglob('*')):
    raise SystemExit('Symlinks are not allowed in the assets payload')
output = ROOT / 'dist/Emberstage-Linux.tar.gz'
output.parent.mkdir(exist_ok=True)
with tarfile.open(output, 'w:gz') as archive:
    for path in files:
        info = archive.gettarinfo(str(path), 'Emberstage/' + path.relative_to(ROOT).as_posix())
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        info.mode = 0o755 if path.suffix in ('.sh', '.py') else 0o644
        with path.open('rb') as stream:
            archive.addfile(info, stream)
with tarfile.open(output) as archive:
    assert len(archive.getmembers()) == len(files)
    assert all(member.isfile() and member.name.startswith('Emberstage/') for member in archive)
print(f'Built {output} ({len(files)} files, {output.stat().st_size} bytes)')

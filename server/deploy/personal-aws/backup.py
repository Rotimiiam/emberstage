#!/usr/bin/python3
"""Guest-only consistent backup; never output database/secret bytes."""
import datetime
import os
from pathlib import Path
import sqlite3
import shutil

os.umask(0o077)
def safe(path):
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('symlink refused')

try:
    source = Path('/var/lib/emberstage/emberstage.db')
    target = Path('/var/backups/emberstage')
    safe(source); safe(target)
    assert source.is_file() and os.geteuid() == 0
    assert shutil.disk_usage(target.parent).free > 2 * 1024**3 + 2 * source.stat().st_size
    target.mkdir(mode=0o700, exist_ok=True)
    name = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ.db')
    destination = target / name
    safe(destination)
    destination.open('xb').close()
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src:
        with sqlite3.connect(destination) as dst:
            src.backup(dst)
            assert dst.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    print('EMBERSTAGE_BACKUP_VERIFIED')
except Exception:
    print('EMBERSTAGE_BACKUP_FAILED')
    raise SystemExit(1)

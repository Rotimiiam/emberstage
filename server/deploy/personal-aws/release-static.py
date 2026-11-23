#!/usr/bin/python3
"""One exact static-only guest release; preserve live DB/secret and code rollback."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request

OLD = 'ec82503100eca6fc37926a6f421dd2e424ae0c9eb554f718aa218fb84be7dab4'
INSTANCE = 'i-0c84a5d8668e47d8b'
ORIGIN = 'https://account.emberstage.live'
ALLOWED = {'server/public/app.html', 'server/public/app.css', 'server/public/app.js',
           'assets/brand/favicon.svg', 'assets/brand/emberstage-logo.svg',
           'assets/css/emberstage_brand.css'}
PROTECTED = ['/etc/emberstage/runtime.env', '/etc/nginx/nginx.conf',
             '/etc/nginx/emberstage-tls.conf', '/etc/systemd/system/emberstage.service',
             '/etc/systemd/system/emberstage-backup.service',
             '/etc/systemd/system/emberstage-backup.timer']


def safe(path):
    path = Path(path).absolute()
    assert not any(p.is_symlink() for p in [path, *path.parents])
    return path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def protected():
    result = {}
    for raw in PROTECTED:
        p = safe(raw); s = p.stat()
        result[raw] = [s.st_uid, s.st_gid, s.st_mode, s.st_ino, digest(p.read_bytes())]
    assert result['/etc/emberstage/runtime.env'][0] == 0
    assert result['/etc/emberstage/runtime.env'][2] & 0o777 == 0o600
    return result


def manifest(data):
    result = {}
    for line in data.decode().splitlines():
        h, n = line.split('  ', 1)
        assert re.fullmatch('[a-f0-9]{64}', h) and n not in result
        p = Path(n)
        assert not p.is_absolute() and '..' not in p.parts
        result[n] = h
    assert len(result) == 23
    return result


def command(args):
    r = subprocess.run(args, capture_output=True, timeout=60)
    assert r.returncode == 0
    return r


def fetch(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.status, r.read(4 * 1024 * 1024)


def health(expected):
    ready = False
    for _ in range(30):
        try:
            status, _ = fetch('http://127.0.0.1:3000/api/auth/config')
            ready = status == 200
        except Exception:
            pass
        if ready:
            break
        time.sleep(0.5)
    assert ready
    command(['systemctl', 'is-active', 'emberstage'])
    status, body = fetch(ORIGIN + '/api/auth/config')
    auth = json.loads(body)
    assert status == 200 and not auth['google']['enabled'] and not auth['auth0']['enabled']
    status, body = fetch(ORIGIN + '/api/billing/plan')
    billing = json.loads(body)
    assert status == 200 and not billing['checkoutAvailable'] and billing['mode'] == 'unconfigured'
    routes = {'/app': 'server/public/app.html', '/app/app.css': 'server/public/app.css',
              '/app/app.js': 'server/public/app.js',
              '/assets/brand/favicon.svg': 'assets/brand/favicon.svg',
              '/assets/brand/emberstage-logo.svg': 'assets/brand/emberstage-logo.svg',
              '/assets/css/emberstage_brand.css': 'assets/css/emberstage_brand.css'}
    for route, file in routes.items():
        status, body = fetch(ORIGIN + route)
        assert status == 200 and digest(body) == expected[file]


state = {}
journal = None
armed = False
switched = False
start = time.monotonic()


def record(phase):
    state['phase'] = phase
    with journal.open('w') as f:
        json.dump(state, f, sort_keys=True)
        f.flush(); os.fsync(f.fileno())


def stop(signum, frame):
    raise RuntimeError('SIGNAL_CONTAINMENT')


def replace_current(target, label):
    link = safe('/opt/emberstage/' + label)
    assert not link.exists()
    os.symlink('releases/' + target, link)
    os.replace(link, '/opt/emberstage/current')  # no target-directory semantics
    fd = os.open('/opt/emberstage', os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


try:
    assert os.geteuid() == 0 and sys.argv[1] == '--execute'
    bundle = safe(sys.argv[2]); new = sys.argv[3]
    assert re.fullmatch('[a-f0-9]{64}', new) and new != OLD
    os.umask(0o077)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, stop)
    token_req = urllib.request.Request('http://169.254.169.254/latest/api/token',
        method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
    with urllib.request.urlopen(token_req, timeout=10) as r: token = r.read().decode()
    req = urllib.request.Request('http://169.254.169.254/latest/dynamic/instance-identity/document',
        headers={'X-aws-ec2-metadata-token': token})
    with urllib.request.urlopen(req, timeout=10) as r: identity = json.load(r)
    assert identity['instanceId'] == INSTANCE and identity['accountId'] == '962379336291' and identity['region'] == 'us-east-1'
    del token, identity
    lock_path = safe('/run/emberstage-static-release.lock')
    lock = lock_path.open('a'); os.chmod(lock_path, 0o600)
    assert lock_path.stat().st_uid == 0
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    root = safe('/opt/emberstage'); old_path = safe(root / 'releases' / OLD)
    current = root / 'current'
    assert current.is_symlink() and os.readlink(current) == 'releases/' + OLD
    old_manifest = manifest(safe(old_path / 'SHA256SUMS').read_bytes())
    for n, h in old_manifest.items():
        p = safe(old_path / n); assert p.stat().st_uid == 0 and digest(p.read_bytes()) == h
    assert digest(bundle.read_bytes()) == new
    with tarfile.open(bundle) as archive:
        members = archive.getmembers()
        assert len(members) == 24 and len({m.name for m in members}) == 24
        assert all(m.isfile() and m.size < 4 * 1024 * 1024 for m in members)
        new_manifest = manifest(archive.extractfile('SHA256SUMS').read())
        assert set(new_manifest) == set(old_manifest)
        assert {m.name for m in members} == set(new_manifest) | {'SHA256SUMS'}
        assert all(new_manifest[n] == old_manifest[n] for n in old_manifest if n not in ALLOWED)
        content = {m.name: archive.extractfile(m).read() for m in members}
        assert all(digest(content[n]) == h for n, h in new_manifest.items())
    state = {'old_release': OLD, 'new_release': new, 'protected': protected()}
    database = safe('/var/lib/emberstage/emberstage.db')
    db_stat = database.stat(); state['database_identity'] = [db_stat.st_dev, db_stat.st_ino]
    journal = safe('/var/backups/emberstage/static-release-' + new + '.json')
    journal.open('x').close(); journal.chmod(0o600)
    record('validated_before_backup')
    backup = command(['/usr/local/sbin/emberstage-backup'])
    assert backup.stdout == b'EMBERSTAGE_BACKUP_VERIFIED\n'
    print('EMBERSTAGE_STATIC_RELEASE_BACKUP_VERIFIED', flush=True)
    target = safe(root / 'releases' / new)
    assert not target.exists()
    os.umask(0o022)  # staged code directories must be traversable by service UID
    target.mkdir(mode=0o755)
    for n, data in content.items():
        p = safe(target / n)
        p.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        p.write_bytes(data); p.chmod(0o644)
    os.umask(0o077)
    assert protected() == state['protected']
    assert current.is_symlink() and os.readlink(current) == 'releases/' + OLD
    record('rollback_armed_before_atomic_switch'); armed = True
    switch_start = time.monotonic()
    replace_current(new, '.current-stage-' + new)
    switched = True; record('new_code_current')
    command(['systemctl', 'restart', 'emberstage'])
    health(new_manifest)
    assert protected() == state['protected']
    now = database.stat(); assert [now.st_dev, now.st_ino] == state['database_identity']
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    state['transaction_ms'] = round((time.monotonic() - start) * 1000)
    state['restart_window_ms'] = round((time.monotonic() - switch_start) * 1000)
    record('committed_protected_state_preserved'); armed = False
    print('EMBERSTAGE_STATIC_RELEASE_SOURCE_EXACT')
    print('EMBERSTAGE_STATIC_RELEASE_DB_SECRET_CONFIG_PRESERVED')
    print('EMBERSTAGE_STATIC_RELEASE_ASSET_HASHES_VERIFIED')
    print('EMBERSTAGE_STATIC_RELEASE_COMMITTED')
except Exception:
    if armed:
        try:
            replace_current(OLD, '.current-rollback-' + state['new_release'])
            command(['systemctl', 'restart', 'emberstage'])
            health(old_manifest)
            assert protected() == state['protected']
            record('rolled_back_old_code_live_db_retained')
            print('EMBERSTAGE_STATIC_RELEASE_ROLLED_BACK_CODE_ONLY')
        except Exception:
            print('EMBERSTAGE_STATIC_RELEASE_ROLLBACK_BLOCK_RECONCILE_REQUIRED')
    else:
        print('EMBERSTAGE_STATIC_RELEASE_FAILED_BEFORE_SWITCH')
    raise SystemExit(1)

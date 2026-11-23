#!/bin/bash
# Invoke only after exact new-instance + console SSH-fingerprint proof.
set -euo pipefail
set +x
exec 3>&1
exec >/dev/null 2>&1
trap 'printf "EMBERSTAGE_GUEST_FAILED\n" >&3' ERR
test "$(id -u)" = 0
test "${1:-}" = --execute
operation=${2:-}
expected_instance=${3:?}
[[ "$expected_instance" =~ ^i-[a-f0-9]{17}$ ]]
# Every guest operation binds to the newly recorded EC2 identity, never a name/IP alone.
token=$(curl --fail --silent -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
identity=$(curl --fail --silent -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/dynamic/instance-identity/document)
printf '%s' "$identity" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["accountId"]=="962379336291" and d["region"]=="us-east-1" and d["instanceId"]==sys.argv[1]' "$expected_instance"
unset token identity
safe() {
    python3 - "$@" <<'PY'
import pathlib,sys
for raw in sys.argv[1:]:
    path=pathlib.Path(raw).absolute()
    assert not any(p.is_symlink() for p in [path,*path.parents])
PY
}
safe /opt/emberstage /etc/emberstage /var/lib/emberstage /var/backups/emberstage /etc/nginx /var/www/letsencrypt
if [ "$operation" = bootstrap ]; then
    test ! -e /etc/emberstage/runtime.env
    test ! -e /opt/emberstage
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils nginx libnginx-mod-rtmp ffmpeg certbot sqlite3
    systemctl stop nginx
    useradd --system --home-dir /var/lib/emberstage --shell /usr/sbin/nologin emberstage
    install -d -m 0755 /opt/emberstage /opt/emberstage/releases
    install -d -m 0700 /etc/emberstage /var/backups/emberstage
    install -d -o emberstage -g emberstage -m 0700 /var/lib/emberstage
    install -d -m 0755 /var/www/letsencrypt
    safe /opt/node-v24.22.3-linux-x64
    work=$(mktemp -d /var/tmp/emberstage-node.XXXXXXXX)
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
        https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz -o "$work/node.tar.xz"
    echo "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb  $work/node.tar.xz" | sha256sum --check --status
    tar -xJf "$work/node.tar.xz" -C /opt --no-same-owner
    /opt/node-v24.22.3-linux-x64/bin/node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(':memory:'); d.close();"
    python3 - <<'PY'
import os,secrets
os.umask(0o077)
with open('/etc/emberstage/runtime.env','x') as f:
    f.write('NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\n')
    f.write('APP_BASE_URL=https://account.emberstage.live\nDATABASE_URL=/var/lib/emberstage/emberstage.db\n')
    f.write('ENCRYPTION_SECRET='+secrets.token_hex(32)+'\n')
    f.write('CAMERA_ROOMS_ENABLED=false\nFAKE_WORKERS=false\nFFMPEG_PATH=/usr/bin/ffmpeg\n')
    f.write('CONTRIBUTION_INGEST_URL=rtmp://127.0.0.1/live\n')
    # Intentionally NOT rtmps: production prepare rejects ingest until separate TLS review.
    f.write('RTMP_INGEST_BASE_URL=rtmp://127.0.0.1/live\n')
PY
    printf 'EMBERSTAGE_BOOTSTRAP_READY\n' >&3
elif [ "$operation" = install ]; then
    bundle=${4:?}; digest=${5:?}
    [[ "$digest" =~ ^[a-f0-9]{64}$ ]]
    safe "$bundle" /opt/emberstage/releases/"$digest"
    echo "$digest  $bundle" | sha256sum --check --status
    python3 - "$bundle" "$digest" <<'PY'
import hashlib,pathlib,sys,tarfile
base=pathlib.Path('/opt/emberstage/releases')/sys.argv[2]
assert not base.exists()
with tarfile.open(sys.argv[1]) as t:
    members=t.getmembers()
    names=[m.name for m in members]
    assert len(names)==len(set(names))
    for m in members:
        p=pathlib.PurePosixPath(m.name)
        assert m.isfile() and not p.is_absolute() and '..' not in p.parts
        assert m.size < 4*1024*1024
    manifest=t.extractfile('SHA256SUMS').read().decode().splitlines()
    expected={}
    for line in manifest:
        h,n=line.split('  ',1); assert len(h)==64; expected[n]=h
    assert set(expected)==set(names)-{'SHA256SUMS'}
    content={m.name:t.extractfile(m).read() for m in members}
    assert all(hashlib.sha256(content[n]).hexdigest()==h for n,h in expected.items())
    base.mkdir(mode=0o755)
    for n,data in content.items():
        dest=base/n
        dest.parent.mkdir(parents=True,exist_ok=True)
        dest.write_bytes(data); dest.chmod(0o644)
PY
    ops=/opt/emberstage/releases/"$digest"/server/deploy/personal-aws
    safe /etc/systemd/system/emberstage.service /etc/nginx/nginx.conf /etc/nginx/emberstage-tls.conf /usr/local/sbin/emberstage-backup
    install -m 0644 "$ops/emberstage.service" /etc/systemd/system/emberstage.service
    install -m 0644 "$ops/nginx.conf" /etc/nginx/nginx.conf
    if [ ! -e /etc/nginx/emberstage-tls.conf ]; then install -m 0644 /dev/null /etc/nginx/emberstage-tls.conf; fi
    install -m 0700 "$ops/backup.py" /usr/local/sbin/emberstage-backup
    # current is the sole permitted managed symlink; all other parents checked above.
    test ! -e /opt/emberstage/current && test ! -L /opt/emberstage/current
    ln -s "releases/$digest" /opt/emberstage/current
    nginx -t
    systemctl daemon-reload
    systemctl enable --now emberstage nginx
    for attempt in {1..30}; do
        if curl --fail --silent http://127.0.0.1:3000/api/auth/config >/dev/null; then break; fi
        sleep 1
    done
    curl --fail --silent http://127.0.0.1:3000/app >/dev/null
    /usr/local/sbin/emberstage-backup
    safe /etc/systemd/system/emberstage-backup.service /etc/systemd/system/emberstage-backup.timer
    python3 - <<'PY'
from pathlib import Path
Path('/etc/systemd/system/emberstage-backup.service').write_text('''[Unit]
Description=Guest-only Emberstage SQLite backup
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/emberstage-backup
UMask=0077
StandardOutput=null
StandardError=null
''')
Path('/etc/systemd/system/emberstage-backup.timer').write_text('''[Unit]
Description=Daily guest-only Emberstage backup
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
''')
PY
    systemctl daemon-reload
    systemctl enable --now emberstage-backup.timer
    printf 'EMBERSTAGE_LOOPBACK_READY\n' >&3
elif [ "$operation" = tls ]; then
    test ! -e /etc/letsencrypt/live/account.emberstage.live
    certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
        --webroot -w /var/www/letsencrypt -d account.emberstage.live
    safe /etc/nginx/emberstage-tls.conf /etc/letsencrypt/renewal-hooks/deploy/emberstage-nginx
    python3 - <<'PY'
from pathlib import Path
Path('/etc/nginx/emberstage-tls.conf').write_text('''
server {
    listen 443 ssl;
    server_name account.emberstage.live;
    ssl_certificate /etc/letsencrypt/live/account.emberstage.live/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/account.emberstage.live/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=86400" always;
    add_header X-Content-Type-Options nosniff always;
    location = / { return 302 /app; }
    location ^~ /api/streams/ { return 403; }
    location ^~ /camera { return 503; }
    location ~ ^/api/auth/(login|register)$ {
        limit_req zone=auth burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host account.emberstage.live;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host account.emberstage.live;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
''')
hook=Path('/etc/letsencrypt/renewal-hooks/deploy/emberstage-nginx')
assert not hook.is_symlink()
hook.write_text('#!/bin/sh\n/usr/sbin/nginx -t >/dev/null 2>&1 && /bin/systemctl reload nginx\n')
hook.chmod(0o700)
PY
    nginx -t
    systemctl reload nginx
    systemctl enable --now certbot.timer
    curl --fail --silent https://account.emberstage.live/api/auth/config >/dev/null
    printf 'EMBERSTAGE_TLS_READY\n' >&3
else
    false
fi

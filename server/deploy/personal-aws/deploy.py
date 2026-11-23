#!/usr/bin/env python3
"""Prepare locally by default; provision ONLY with --execute after review."""
import argparse
import base64
import hashlib
import io
import ipaddress
import json
import os
import re
from pathlib import Path
import subprocess
import tarfile

HERE = Path(__file__).absolute().parent
ROOT = HERE.parents[2]
ACCOUNT = '962379336291'
AMI = 'ami-0a951420c495183dc'
VPC = 'vpc-0d1c1a3126d9ef07f'
SUBNET = 'subnet-04c51171b39585dcb'
NAME = 'emberstage-account'
FILES = [f'server/src/{name}.js' for name in (
    'index', 'config', 'db', 'server', 'crypto-utils', 'worker-manager',
    'nango-client', 'camera-rooms', 'device-summary')]
FILES += ['server/package.json']
FILES += [f'server/public/app.{ext}' for ext in ('html', 'js', 'css')]
FILES += ['server/public/camera.html', 'server/public/camera.js']
FILES += ['assets/brand/favicon.svg', 'assets/brand/emberstage-logo.svg',
          'assets/brand/emberstage-wordmark.svg', 'assets/css/emberstage_brand.css']
FILES += [f'server/deploy/personal-aws/{name}' for name in
          ('guest.sh', 'emberstage.service', 'nginx.conf', 'backup.py')]


def no_links(path):
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError('symlink path refused')


def aws(*args):
    result = subprocess.run(['aws', '--profile', 'personal-plundead', '--region',
                             'us-east-1', *args, '--output', 'json'],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('AWS_COMMAND_FAILED_RECONCILE_BEFORE_RETRY')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def pack(out):
    no_links(out)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = {}
    for name in FILES:
        path = ROOT / name
        no_links(path)
        if not path.is_file():
            raise ValueError('allowlisted file missing')
        payload[name] = path.read_bytes()
    manifest = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n'
                       for name, data in sorted(payload.items())).encode()
    payload['SHA256SUMS'] = manifest
    bundle = out / 'release.tar.gz'
    with bundle.open('xb') as raw:
        os.chmod(bundle, 0o600)
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            for name, data in sorted(payload.items()):
                item = tarfile.TarInfo(name)
                item.size = len(data)
                item.mode = 0o644
                archive.addfile(item, io.BytesIO(data))
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    (out / 'release.sha256').write_text(digest + '\n')
    print(json.dumps({'bundle': str(bundle), 'sha256': digest, 'files': len(FILES)}))


def provision(out, public_key, cidr):
    identity = aws('sts', 'get-caller-identity')
    assert identity['Account'] == ACCOUNT
    assert identity['Arn'] == f'arn:aws:iam::{ACCOUNT}:user/personal-plundead'
    network = ipaddress.ip_network(cidr)
    assert network.version == 4 and network.prefixlen == 32
    assert network.network_address.is_global
    no_links(public_key)
    assert public_key.read_text().startswith('ssh-ed25519 ')
    no_links(out)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_path = out / 'resources.json'
    # Never silently replay a possibly successful request or adopt existing hosts.
    state_path.open('x').close()
    state = {'account': ACCOUNT, 'region': 'us-east-1', 'name': NAME}
    def save():
        state_path.write_text(json.dumps(state, indent=2) + '\n')
        os.chmod(state_path, 0o600)
    save()
    existing = aws('ec2', 'describe-instances', '--filters',
                   f'Name=tag:Name,Values={NAME}',
                   'Name=instance-state-name,Values=pending,running,stopping,stopped')
    assert not existing['Reservations'], 'dedicated host already exists; reconcile'
    tags = [{'Key': 'Name', 'Value': NAME}, {'Key': 'Project', 'Value': 'Emberstage'},
            {'Key': 'ManagedBy', 'Value': 'personal-aws-reviewed'}]
    key = aws('ec2', 'import-key-pair', '--key-name', NAME,
              '--public-key-material', f'fileb://{public_key}',
              '--tag-specifications', json.dumps([{'ResourceType': 'key-pair', 'Tags': tags}]))
    state['key'] = key['KeyName']; save()
    group = aws('ec2', 'create-security-group', '--group-name', NAME,
                '--description', 'Dedicated Emberstage account portal', '--vpc-id', VPC,
                '--tag-specifications', json.dumps([{'ResourceType': 'security-group', 'Tags': tags}]))
    state['sg'] = group['GroupId']; save()
    permissions = [{'IpProtocol': 'tcp', 'FromPort': port, 'ToPort': port,
                    'IpRanges': [{'CidrIp': cidr if port == 22 else '0.0.0.0/0'}]}
                   for port in (22, 80, 443)]
    aws('ec2', 'authorize-security-group-ingress', '--group-id', state['sg'],
        '--ip-permissions', json.dumps(permissions))
    instance = aws('ec2', 'run-instances', '--image-id', AMI,
                   '--instance-type', 't3.small', '--count', '1', '--key-name', state['key'],
                   '--network-interfaces', json.dumps([{'DeviceIndex': 0, 'SubnetId': SUBNET,
                       'Groups': [state['sg']], 'AssociatePublicIpAddress': True,
                       'DeleteOnTermination': True}]),
                   '--credit-specification', 'CpuCredits=standard',
                   '--metadata-options', 'HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled',
                   '--block-device-mappings', json.dumps([{'DeviceName': '/dev/sda1', 'Ebs': {
                       'VolumeSize': 16, 'VolumeType': 'gp3', 'Encrypted': True,
                       'DeleteOnTermination': False}}]),
                   '--tag-specifications', json.dumps([{'ResourceType': resource, 'Tags': tags}
                                                       for resource in ('instance', 'volume')]),
                   '--client-token', hashlib.sha256(str(out).encode()).hexdigest())
    state['instance'] = instance['Instances'][0]['InstanceId']; save()
    address = aws('ec2', 'allocate-address', '--domain', 'vpc', '--tag-specifications',
                  json.dumps([{'ResourceType': 'elastic-ip', 'Tags': tags}]))
    state['allocation'] = address['AllocationId']; state['ip'] = address['PublicIp']; save()
    aws('ec2', 'wait', 'instance-running', '--instance-ids', state['instance'])
    aws('ec2', 'associate-address', '--instance-id', state['instance'],
        '--allocation-id', state['allocation'], '--no-allow-reassociation')
    print(json.dumps(state))


def trust_host(out):
    no_links(out)
    state_path = out / 'resources.json'
    no_links(state_path)
    state = json.loads(state_path.read_text())
    identity = aws('sts', 'get-caller-identity')
    assert identity['Account'] == ACCOUNT and identity['Arn'] == f'arn:aws:iam::{ACCOUNT}:user/personal-plundead'
    instance = aws('ec2', 'describe-instances', '--instance-ids', state['instance'])['Reservations'][0]['Instances'][0]
    assert instance['PublicIpAddress'] == state['ip'] and instance['ImageId'] == AMI
    assert {t['Key']: t['Value'] for t in instance['Tags']}['Name'] == NAME
    console = aws('ec2', 'get-console-output', '--instance-id', state['instance'], '--latest')['Output']
    if 'SSH HOST KEY FINGERPRINTS' not in console:
        console = base64.b64decode(console, validate=True).decode()
    blocks = re.findall(r'BEGIN SSH HOST KEY FINGERPRINTS(.*?)END SSH HOST KEY FINGERPRINTS', console, re.S)
    assert len(blocks) == 1
    fingerprints = re.findall(r'\b(SHA256:[A-Za-z0-9+/]+)[^\r\n]*\(ED25519\)', blocks[0])
    assert len(fingerprints) == 1
    candidate = subprocess.run(['ssh-keyscan', '-T', '10', '-t', 'ed25519', state['ip']], capture_output=True)
    assert candidate.returncode == 0
    lines = [x for x in candidate.stdout.decode().splitlines() if not x.startswith('#')]
    assert len(lines) == 1 and lines[0].split()[0] == state['ip']
    assert lines[0].split()[1] == 'ssh-ed25519'
    wire_key = base64.b64decode(lines[0].split()[2], validate=True)
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(wire_key).digest()).decode().rstrip('=')
    assert fingerprint == fingerprints[0]
    path = out / 'known_hosts'
    no_links(path)
    with path.open('x') as f:
        f.write(lines[0] + '\n')
    os.chmod(path, 0o600)
    print('EMBERSTAGE_CONSOLE_HOST_KEY_VERIFIED')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['pack', 'provision', 'trust-host'])
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--public-key', type=Path)
    parser.add_argument('--ssh-cidr')
    args = parser.parse_args()
    try:
        if args.operation == 'pack':
            pack(args.out.absolute())
        elif args.operation == 'trust-host':
            trust_host(args.out.absolute())
        elif not args.execute:
            print('DRY_RUN: one dedicated t3.small, retained encrypted16GiB gp3, SG22/32+80+443, key, EIP; no IAM/DNS')
        else:
            assert args.public_key and args.ssh_cidr
            provision(args.out.absolute(), args.public_key.absolute(), args.ssh_cidr)
    except Exception:
        print('DEPLOY_FAILED_RECONCILE_REQUIRED')
        raise SystemExit(1)

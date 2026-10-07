#!/usr/bin/env python3
"""Back up private media bytes with a manifest; never print credentials or object names."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
import uuid

PRODUCTION_REF = 'fivatgdpuenszxxnijpc'
FORMAT = 'smc-storage-v1'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, headers, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={**headers, 'Content-Type': 'application/json'})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024:
        raise ValueError('Storage response exceeds the backup size limit')
    return data


def credentials():
    url = os.environ.get('SUPABASE_URL', f'https://{PRODUCTION_REF}.supabase.co').rstrip('/')
    parsed = urllib.parse.urlsplit(url)
    if not ((parsed.scheme == 'https' and parsed.hostname == f'{PRODUCTION_REF}.supabase.co') or
            (parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost'} and parsed.port == 54331)):
        raise ValueError('Storage source must be the configured Sasha project or isolated QA service')
    if parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Storage source must be a bare origin')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        if parsed.hostname != f'{PRODUCTION_REF}.supabase.co':
            raise ValueError('Local QA requires its own service key')
        token = os.environ.get('SUPABASE_ACCESS_TOKEN')
        if not token:
            token = subprocess.run([str(Path.home() / 'bin/zsvault'), 'get', 'supabase_access_token'],
                                   capture_output=True, text=True, check=True).stdout.strip()
        keys = json.loads(request(f'https://api.supabase.com/v1/projects/{PRODUCTION_REF}/api-keys',
                                  {'Authorization': f'Bearer {token}'}))
        key = next(item['api_key'] for item in keys if item['name'] == 'service_role')
    return url + '/storage/v1', {'Authorization': f'Bearer {key}', 'apikey': key}


def inventory(base, headers, bucket):
    result = []
    pending = ['']
    while pending:
        prefix = pending.pop()
        offset = 0
        while True:
            rows = json.loads(request(f'{base}/object/list/{bucket}', headers,
                                      {'prefix': prefix, 'limit': 1000, 'offset': offset,
                                       'sortBy': {'column': 'name', 'order': 'asc'}}))
            if not isinstance(rows, list):
                raise ValueError('Invalid storage listing')
            for row in rows:
                name = f"{prefix}/{row['name']}".lstrip('/')
                if not row.get('id'):
                    pending.append(name)
                else:
                    result.append({'name': name, 'id': row['id'], 'updated_at': row.get('updated_at'),
                                   'size': row.get('metadata', {}).get('size'),
                                   'content_type': row.get('metadata', {}).get('mimetype')})
            if len(result) + len(pending) > 10000 or len(prefix.split('/')) > 32:
                raise ValueError('Storage inventory exceeds the supported backup bound')
            if len(rows) < 1000:
                break
            offset += 1000
    return sorted(result, key=lambda item: item['name'])


def verify(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('format') != FORMAT:
        raise ValueError('Unsupported storage backup')
    total = 0
    for entry in manifest['objects']:
        digest = entry['sha256']
        if not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('Invalid content hash')
        path = directory / 'objects' / digest
        if path.is_symlink():
            raise ValueError('Backup objects cannot be symlinks')
        data = path.read_bytes()
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('Storage backup checksum mismatch')
        total += len(data)
    return {'objects': len(manifest['objects']), 'bytes': total}


def durable_write(path, data):
    with path.open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def backup(destination):
    os.umask(0o077)
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    base, headers = credentials()
    bucket = 'media'
    before = inventory(base, headers, bucket)
    stage = Path(tempfile.mkdtemp(prefix='.storage-', dir=destination))
    try:
        (stage / 'objects').mkdir(mode=0o700)
        objects = []
        for item in before:
            data = request(f"{base}/object/{bucket}/{urllib.parse.quote(item['name'], safe='/')}", headers)
            if item['size'] is not None and len(data) != int(item['size']):
                raise ValueError('Storage object changed during backup')
            digest = hashlib.sha256(data).hexdigest()
            durable_write(stage / 'objects' / digest, data)
            objects.append({**item, 'bucket': bucket, 'sha256': digest, 'bytes': len(data)})
        if before != inventory(base, headers, bucket):
            raise ValueError('Storage inventory changed during backup; retry for a stable copy')
        durable_write(stage / 'manifest.json', (json.dumps({'format': FORMAT, 'source': base,
            'taken_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'objects': objects}, indent=2) + '\n').encode())
        sync_directory(stage / 'objects')
        sync_directory(stage)
        result = verify(stage)
        name = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H%M%SZ') + '-storage-' + uuid.uuid4().hex[:8]
        final = destination / name
        stage.rename(final)
        sync_directory(destination)
        result['directory'] = str(final)
        # Retain only this script's completed runs. Never touch older SQL or other directories.
        runs = sorted((p for p in destination.iterdir() if p != final and p.is_dir() and not p.is_symlink()
                       and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{6}Z-storage-[a-f0-9]{8}', p.name)),
                      key=lambda p: p.stat().st_mtime_ns, reverse=True)
        for old in runs[13:]:
            if json.loads((old / 'manifest.json').read_text()).get('format') == FORMAT:
                shutil.rmtree(old)
        return result
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--dest', type=Path, default=Path.home() / 'Backups/supabase/meal-companion')
    args = parser.parse_args()
    try:
        result = verify(args.verify) if args.verify else backup(args.dest)
        print(json.dumps({'ok': True, **result}))
    except Exception as error:
        # API/libpq/subprocess exceptions can contain sensitive paths or headers.
        print(json.dumps({'ok': False, 'error': type(error).__name__}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup_storage', Path(__file__).with_name('backup-storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageBackupTests(unittest.TestCase):
    def test_backup_roundtrip_private_files_and_detect_corruption(self):
        item = {'name': '../../unsafe.png', 'id': 'one', 'updated_at': '2026-09-15', 'size': 5,
                'content_type': 'image/png'}
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'credentials', return_value=('http://qa', {})), \
                patch.object(storage, 'inventory', return_value=[item]), patch.object(storage, 'request', return_value=b'hello'):
            result = storage.backup(directory)
            saved = Path(result['directory'])
            self.assertEqual(storage.verify(saved), {'objects': 1, 'bytes': 5})
            manifest = json.loads((saved / 'manifest.json').read_text())
            obj = saved / 'objects' / manifest['objects'][0]['sha256']
            self.assertEqual(obj.stat().st_mode & 0o777, 0o600)
            self.assertEqual(saved.stat().st_mode & 0o777, 0o700)
            obj.write_bytes(b'broken')
            with self.assertRaises(ValueError):
                storage.verify(saved)

    def test_changed_inventory_never_publishes_or_removes_existing_backup(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'credentials', return_value=('http://qa', {})), \
                patch.object(storage, 'inventory', side_effect=[[], [{'name': 'new'}]]):
            old = Path(directory) / 'existing.sql'
            old.write_bytes(b'previous good dump')
            with self.assertRaises(ValueError):
                storage.backup(directory)
            self.assertEqual(list(Path(directory).iterdir()), [old])
            self.assertEqual(old.read_bytes(), b'previous good dump')

    def test_nested_listing_and_stable_pagination(self):
        folder = {'name': 'folder', 'id': None}
        first = [{'name': f'{i}.png', 'id': str(i), 'metadata': {'size': 1}} for i in range(999)] + [folder]
        child = [{'name': 'child.png', 'id': 'child', 'metadata': {'size': 1}}]
        with patch.object(storage, 'request', side_effect=[json.dumps(first).encode(), b'[]', json.dumps(child).encode()]) as request:
            result = storage.inventory('http://qa', {}, 'media')
        self.assertEqual(len(result), 1000)
        self.assertTrue(any(x['name'] == 'folder/child.png' for x in result))
        self.assertEqual(request.call_args_list[1].args[2]['offset'], 1000)
        self.assertEqual(request.call_args_list[2].args[2]['prefix'], 'folder')

    def test_retention_always_keeps_just_published_backup(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'credentials', return_value=('http://qa', {})), \
                patch.object(storage, 'inventory', return_value=[]):
            for i in range(14):
                old = Path(directory) / f'2099-01-01T000000Z-storage-{i:08x}'
                old.mkdir()
                (old / 'manifest.json').write_text(json.dumps({'format': storage.FORMAT, 'objects': []}))
            result = storage.backup(directory)
            self.assertTrue(Path(result['directory']).exists())
            self.assertEqual(len(list(Path(directory).iterdir())), 14)

    def test_source_origin_guard_prevents_credential_disclosure(self):
        for url in ['https://attacker.example', 'http://localhost:3000',
                    'https://fivatgdpuenszxxnijpc.supabase.co/other',
                    'https://user@fivatgdpuenszxxnijpc.supabase.co']:
            with patch.dict(os.environ, {'SUPABASE_URL': url, 'SUPABASE_SERVICE_ROLE_KEY': 'not-real'}):
                with self.assertRaises(ValueError):
                    storage.credentials()


if __name__ == '__main__':
    unittest.main()

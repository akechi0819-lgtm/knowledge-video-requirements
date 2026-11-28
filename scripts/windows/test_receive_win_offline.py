import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('receive-win-offline.py')
NAME = 'Jiangjie-Setup-Offline-x64.exe'


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.public = self.root / 'public'
        self.stage = self.root / 'stage'
        self.public.mkdir()
        self.stage.mkdir()

    def run_receiver(self, body, tag='v1.2.3-rc.1', digest=None, size=None, command=None):
        digest = digest or hashlib.sha256(body).hexdigest()
        size = len(body) if size is None else size
        env = dict(os.environ, SSH_ORIGINAL_COMMAND=command or f'publish {tag} {digest} {size}')
        result = subprocess.run(['/usr/bin/python3', str(SCRIPT), str(self.public), str(self.stage)],
                                input=body, env=env, capture_output=True)
        self.assertEqual(list(self.stage.iterdir()), [])
        return result

    def test_success_repeat_and_mutation(self):
        content = b'installer content'
        target = self.public / 'v1.2.3-rc.1' / NAME
        result = self.run_receiver(content)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_bytes(), content)
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.run_receiver(content).stdout.strip(), b'already published')
        result = self.run_receiver(b'changed content')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), content)
        result = self.run_receiver(b'bad', digest=hashlib.sha256(content).hexdigest())
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), content)

    def test_bad_transfers_do_not_create_version(self):
        for body, digest, size in [(b'abc', '0' * 64, 3), (b'ab', None, 3), (b'abcd', None, 3)]:
            with self.subTest(body=body, digest=digest, size=size):
                result = self.run_receiver(body, digest=digest, size=size)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(list(self.public.iterdir()), [])

    def test_invalid_commands(self):
        h = hashlib.sha256(b'x').hexdigest()
        for command in [f'publish v01.2.3 {h} 1', f'publish v1.2.3-01 {h} 1',
                        f'publish v1.2.3 {h.upper()} 1', f'publish v1.2.3 {h} 0',
                        f'publish v1.2.3 {h} 1 extra', f'publish v1.2.3 {h} 1\n']:
            with self.subTest(command=command):
                self.assertNotEqual(self.run_receiver(b'x', command=command).returncode, 0)
                self.assertEqual(list(self.public.iterdir()), [])


if __name__ == '__main__':
    unittest.main()

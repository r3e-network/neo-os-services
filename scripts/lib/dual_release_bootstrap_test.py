"""Real isolated bootstrap children; no repository or release admission."""
import base64
import hashlib
import json
from pathlib import Path
import re
import selectors
import subprocess
import sys
import unittest


SOURCE = Path(__file__).resolve().parents[1] / 'check-dual-release.mjs'
MATCH = re.search(r'const bootstrap = String.raw`\n(.*?)\n`;', SOURCE.read_text(), re.S)
if MATCH is None:
    raise RuntimeError('missing isolated bootstrap')
BOOTSTRAP = MATCH.group(1)


class FramedBootstrap(unittest.TestCase):
    def payload(self, text='verified-π'):
        code = ('def main():\n    print(' + repr(text) + ', flush=True)\n    return 1\n').encode()
        return json.dumps({
            'sources': {'scripts/lib/check_dual_release.py': {
                'mode': '100644', 'data': base64.b64encode(code).decode(),
                'sha256': hashlib.sha256(code).hexdigest(),
            }},
            'source_root': '/synthetic-π-链', 'root': '/synthetic-π-链', 'head': 'a' * 40,
            'base': 'b' * 40,
        }, ensure_ascii=False).encode()

    def launch(self, count):
        return subprocess.Popen(
            [sys.executable, '-I', '-S', '-B', '-c', BOOTSTRAP, str(count)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'},
        )

    def stop(self, child):
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=3)

    def test_complete_frame_runs_without_waiting_for_pipe_eof(self):
        data = self.payload()
        child = self.launch(len(data))
        try:
            child.stdin.write(data)
            child.stdin.flush()
            # Intentionally keep stdin OPEN. The complete frame must be enough.
            with selectors.DefaultSelector() as ready:
                ready.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(2), 'complete frame waited for EOF')
            self.assertEqual(child.stdout.readline(), 'verified-π\n'.encode())
            self.assertEqual(child.wait(timeout=2), 1)
        finally:
            self.stop(child)

    def test_partial_frame_cannot_execute_before_remaining_bytes_arrive(self):
        data = self.payload()
        child = self.launch(len(data))
        try:
            child.stdin.write(data[:-8])
            child.stdin.flush()
            with selectors.DefaultSelector() as ready:
                ready.register(child.stdout, selectors.EVENT_READ)
                self.assertFalse(ready.select(0.1))
            child.stdin.write(data[-8:])
            child.stdin.flush()
            with selectors.DefaultSelector() as ready:
                ready.register(child.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(2), 'completed partial frame waited for EOF')
            self.assertEqual(child.stdout.readline(), 'verified-π\n'.encode())
            self.assertEqual(child.wait(timeout=2), 1)
        finally:
            self.stop(child)

    def test_short_closed_frame_is_rejected_before_module_execution(self):
        data = self.payload()
        child = self.launch(len(data) + 1)
        stdout, _ = child.communicate(data, timeout=3)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(stdout, b'')

    def test_invalid_or_excessive_frame_length_refuses_without_input(self):
        for count in ('0', '-1', '01', '1.5', 'x', '８', str(8 * 1024 * 1024 + 1)):
            with self.subTest(count=count):
                child = self.launch(count)
                try:
                    try:
                        status = child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        self.fail('invalid frame length waited for input')
                    self.assertNotEqual(status, 0)
                    self.assertEqual(child.stdout.read(), b'')
                finally:
                    self.stop(child)

    def test_frame_does_not_remove_source_digest_validation(self):
        data = self.payload().replace(b'"sha256": "', b'"sha256": "0', 1)
        child = self.launch(len(data))
        stdout, _ = child.communicate(data, timeout=3)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(stdout, b'')

    def test_invalid_json_is_rejected_without_execution(self):
        data = self.payload()[:-1] + b'!'
        child = self.launch(len(data))
        stdout, _ = child.communicate(data, timeout=3)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(stdout, b'')


if __name__ == '__main__':
    unittest.main()

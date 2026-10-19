import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('dual_diagnostics', ROOT / 'deploy/nitro/build-dual-enclave.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class Diagnostics(unittest.TestCase):
    def setUp(self):
        if hasattr(b, 'reset_diagnostics'):
            b.reset_diagnostics()

    def test_real_failed_child_has_bounded_diagnostic_not_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = b.safe_env(Path(tmp))
            with self.assertRaises(ValueError):
                b.run([sys.executable, '-c', "import sys;sys.stderr.write('PRIVATE_CANARY error[E0432]: unresolved import\\n');sys.exit(7)"], env)
        receipt = b.failure_diagnostic(ValueError('PRIVATE_CANARY')) if hasattr(b, 'failure_diagnostic') else None
        self.assertIsNotNone(receipt, 'failed child has no structured diagnostic')
        self.assertEqual(receipt['primary']['kind'], 'command_failed')
        self.assertEqual(receipt['primary']['exit_code'], 7)
        self.assertEqual(receipt['primary']['error_codes'], ['E0432'])
        self.assertNotIn('PRIVATE_CANARY', json.dumps(receipt))

    def test_cli_emits_only_fixed_schema_and_no_exception_message(self):
        self.assertTrue(hasattr(b, 'cli'), 'CLI drops all structured failure information')
        output = io.StringIO()
        with patch.object(b, 'main', side_effect=ValueError('PRIVATE_CANARY')), contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as caught:
                b.cli()
        self.assertEqual(caught.exception.code, 1)
        self.assertNotIn('PRIVATE_CANARY', output.getvalue())
        line = output.getvalue().splitlines()[-1]
        self.assertTrue(line.startswith('DUAL-BUILD-FAILURE '))
        self.assertEqual(json.loads(line.split(' ', 1)[1])['schema'], 'neoos/dual-build-failure/v1')

    def test_first_failure_survives_cleanup_failure(self):
        self.assertTrue(hasattr(b, 'diagnostic_stage'))
        b.diagnostic_stage('image-build', 2)
        b.record_failure('command_failed', 7, b'error[E0432]')
        b.diagnostic_stage('cleanup')
        b.record_failure('command_failed', 9, b'PRIVATE_CANARY')
        b.DIAGNOSTIC['cleanup_failed'] = True
        r = b.failure_diagnostic(ValueError('PRIVATE_CANARY'))
        self.assertEqual(r['primary']['stage'], 'image-build')
        self.assertEqual(r['primary']['attempt'], 2)
        self.assertEqual(r['primary']['exit_code'], 7)
        self.assertTrue(r['cleanup_failed'])

    def test_classification_is_bounded_and_fixed_vocabulary(self):
        self.assertTrue(hasattr(b, 'record_failure'))
        text = ('PRIVATE_CANARY No space left on device error[E0432] error[E0432] ' + ''.join('error[E%04d]' % i for i in range(30))).encode()
        b.record_failure('command_failed', 1, text)
        r = b.failure_diagnostic(ValueError())
        self.assertLessEqual(len(r['primary']['error_codes']), 16)
        self.assertEqual(r['primary']['error_codes'], sorted(set(r['primary']['error_codes'])))
        self.assertEqual(r['primary']['hints'], ['disk-full', 'rust-compile'])
        self.assertNotIn('PRIVATE_CANARY', json.dumps(r))

    def test_timeout_has_no_argv_or_output(self):
        self.assertTrue(hasattr(b, 'failure_diagnostic'))
        r = b.failure_diagnostic(subprocess.TimeoutExpired('PRIVATE_CANARY', 1, output=b'PRIVATE_CANARY'))
        self.assertEqual(r['primary']['kind'], 'timeout')
        self.assertIsNone(r['primary']['exit_code'])
        self.assertNotIn('PRIVATE_CANARY', json.dumps(r))

    def test_reset_cannot_leak_previous_attempt(self):
        self.assertTrue(hasattr(b, 'reset_diagnostics'))
        b.diagnostic_stage('image-build', 2)
        b.record_failure('command_failed', 7)
        b.reset_diagnostics()
        r = b.failure_diagnostic(OSError('PRIVATE_CANARY'))
        self.assertEqual(r['primary']['stage'], 'admission')
        self.assertEqual(r['primary']['attempt'], 0)
        self.assertEqual(r['primary']['kind'], 'os_error')

    def test_actual_build_flow_keeps_failed_child_when_cleanup_also_fails(self):
        self.assertTrue(hasattr(b, 'failure_diagnostic'))
        real_run = b.run
        commands = []
        publication = Mock()

        def command(args, env, **kwargs):
            commands.append([str(a) for a in args])
            if 'build' in args:
                return real_run([sys.executable, '-c', "import sys;sys.stderr.write('PRIVATE_CANARY error[E0432]');sys.exit(7)"], env)
            if 'stop' in args:
                return real_run([sys.executable, '-c', 'raise SystemExit(9)'], env)
            return b''

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = root / 'context'
            context.mkdir()
            with patch.object(b, 'canonical', return_value='a' * 40), patch.object(b, 'run', side_effect=command):
                with self.assertRaises(ValueError):
                    b.build_into(root, context, {'git_commit': 'a' * 40}, b.safe_env(root), 'synthetic-docker', 'synthetic-nitro', root, publication)
        receipt = b.failure_diagnostic(ValueError())
        self.assertEqual(receipt['primary'], {'stage': 'image-build', 'attempt': 1,
            'kind': 'command_failed', 'exit_code': 7, 'error_codes': ['E0432'], 'hints': ['rust-compile']})
        self.assertTrue(receipt['cleanup_failed'])
        self.assertTrue(any('stop' in args for args in commands))
        self.assertTrue(any('--force' in args for args in commands))
        self.assertTrue(any('image' in args and 'rm' in args for args in commands))
        self.assertEqual(publication.mock_calls, [])

    def test_buildkit_create_failure_reports_stage_and_runs_cleanup(self):
        self.assertTrue(hasattr(b, 'failure_diagnostic'))
        commands = []

        def command(args, env, **kwargs):
            commands.append(args)
            if 'create' in args:
                raise OSError('PRIVATE_CANARY')
            return b''

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(b, 'canonical', return_value='a' * 40), patch.object(b, 'run', side_effect=command):
                with self.assertRaises(OSError):
                    b.build_into(root, root / 'context', {'git_commit': 'a' * 40}, b.safe_env(root), 'synthetic-docker', 'synthetic-nitro', root, Mock())
        receipt = b.failure_diagnostic(ValueError())
        self.assertEqual(receipt['primary']['stage'], 'buildkit-create')
        self.assertEqual(receipt['primary']['kind'], 'os_error')
        self.assertEqual(receipt['primary']['attempt'], 0)
        self.assertFalse(receipt['cleanup_failed'])
        self.assertEqual(len(commands), 3)

    def test_tail_read_is_bounded_even_for_large_sparse_output(self):
        self.assertTrue(hasattr(b, 'diagnostic_tail'))
        with tempfile.TemporaryFile() as stream:
            stream.seek(b.OUTPUT_LIMIT - 32)
            stream.write(b'error[E0432] PRIVATE_CANARY')
            stream.flush()
            tail = b.diagnostic_tail(stream)
            self.assertEqual(len(tail), 262144)
            self.assertTrue(tail.endswith(b'error[E0432] PRIVATE_CANARY'))
        with tempfile.TemporaryFile() as closed:
            pass
        self.assertEqual(b.diagnostic_tail(closed), b'')

    def test_actual_timeout_is_failure_with_no_command_disclosure(self):
        self.assertTrue(hasattr(b, 'failure_diagnostic'))
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(subprocess.TimeoutExpired):
                b.run([sys.executable, '-c', "import time;time.sleep(10) # PRIVATE_CANARY"], b.safe_env(Path(tmp)), timeout=0.05)
        receipt = b.failure_diagnostic(ValueError())
        self.assertEqual(receipt['primary']['kind'], 'timeout')
        self.assertNotIn('PRIVATE_CANARY', json.dumps(receipt))

    def test_successful_child_does_not_record_failure(self):
        self.assertTrue(hasattr(b, 'DIAGNOSTIC'))
        with tempfile.TemporaryDirectory() as tmp:
            output = b.run([sys.executable, '-c', "print('error[E0432]')"], b.safe_env(Path(tmp)))
        self.assertEqual(output, b'error[E0432]\n')
        self.assertIsNone(b.DIAGNOSTIC['primary'])


if __name__ == '__main__':
    unittest.main()

"""Offline behavioral tests: fake external tools, real stock builder fixtures.

No Docker/Cargo/socket/network is invoked. Local Git and synthetic child/launcher
processes are intentional. Imported Packaging is not a discovered TestCase.
"""
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import hosted_native_candidate as c

spec = importlib.util.spec_from_file_location('stock_fixture', c.ROOT / 'deploy/nitro/dual_image_test.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
CID = 'a' * 64
BK = 'sha256:' + 'b' * 64
RUST = 'sha256:' + 'c' * 64
EMPTY = {'containers': [], 'images': [], 'volumes': []}


def environment(source='1' * 40):
    return {'GITHUB_REPOSITORY': c.REPOSITORY, 'GITHUB_REF': 'refs/heads/main',
            'GITHUB_EVENT_NAME': 'workflow_dispatch', 'CANDIDATE_REPOSITORY_PRIVATE': 'false',
            'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
            'GITHUB_WORKFLOW_REF': c.REPOSITORY + '/.github/workflows/measured-candidate.yml@refs/heads/main',
            'GITHUB_SHA': source, 'GITHUB_WORKFLOW_SHA': source, 'CANDIDATE_SOURCE_SHA': source,
            'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'PUBLIC_BUNDLE_SHA256': '2' * 64}


def packed(files):
    raw = json.dumps({'schema': 'neoos/dual-public-bundle/v1', 'files': files}).encode()
    return base64.b64encode(raw).decode(), c.sha(raw)


def tool_item(cid, name, image, identity, inputs, work, network):
    return {'Id': cid, 'Name': '/' + name, 'Image': image,
            'Config': {'User': str(os.getuid()) + ':' + str(os.getgid()), 'Labels': {c.OWNER_LABEL: identity}},
            'HostConfig': {'Memory': 4 * 1024**3, 'MemorySwap': 4 * 1024**3, 'NanoCpus': 10**9, 'PidsLimit': 256,
                           'NetworkMode': network, 'Privileged': False, 'RestartPolicy': {'Name': 'no'},
                           'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges']},
            'Mounts': [{'Type': 'bind', 'Source': str(inputs), 'Destination': '/inputs', 'RW': False},
                       {'Type': 'bind', 'Source': str(work), 'Destination': '/work', 'RW': True}],
            'State': {'Running': False, 'OOMKilled': False, 'ExitCode': 0}}


def business_frame():
    return {'schema': 'neoos/dual-build-failure/v1',
            'primary': {'stage': 'image-build', 'attempt': 1, 'kind': 'command_failed',
                        'exit_code': 23, 'error_codes': ['E0001', 'E0100'],
                        'hints': ['disk-full', 'rust-compile']}, 'cleanup_failed': True}


def frame_line(value):
    return b'DUAL-BUILD-FAILURE ' + json.dumps(value).encode() + b'\n'


def child_program(stderr, code=7):
    return 'import sys;sys.stderr.buffer.write(' + repr(stderr) + ');sys.stderr.flush();sys.exit(' + str(code) + ')'


def measurement_failure():
    value = business_frame()
    value['primary'].update(stage='measurements', attempt=2, kind='validation',
                            exit_code=None, error_codes=[], hints=[])
    value['cleanup_failed'] = False
    return value


def build_vectors():
    first = {'image_id': 'sha256:' + 'a' * 64,
             'pcrs': {'PCR0': '1' * 96, 'PCR1': '2' * 96, 'PCR2': '3' * 96},
             'eif_sha256': 'b' * 64}
    second = copy.deepcopy(first)
    second['pcrs']['PCR0'] = '4' * 96
    second['eif_sha256'] = 'c' * 64
    return [first, second]


def build_line(value):
    return b'BUILD-EVIDENCE ' + json.dumps(value).encode() + b'\n'


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hosted-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        # Existing controls isolate their original orchestration boundaries;
        # DockerUpgrade below exercises the real installer with external tools mocked.
        installer = patch.object(c.hosted_docker_install, 'install', return_value={})
        installer.start(); self.addCleanup(installer.stop)
        # Any accidental real HTTP/network operation fails the offline suite.
        self.network = patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden'))
        self.network.start(); self.addCleanup(self.network.stop)

    def packaging(self):
        f = fixture.Packaging(); f.setUp(); self.addCleanup(f.doCleanups)
        return f

    def runner(self):
        path = self.root / str(len(list(self.root.iterdir()))); path.mkdir()
        return c.Runner(path)

    def test_admission_exact_source_case_privacy_and_host(self):
        env = environment()
        self.assertEqual(c.admission(env), '1' * 40)
        cases = {key: ['', None, value.upper()] for key, value in env.items() if key not in ('PUBLIC_BUNDLE_SHA256',)}
        cases['CANDIDATE_REPOSITORY_PRIVATE'] = ['', 'null', '0', 'False', 'true', '"false"']
        cases['CANDIDATE_SOURCE_SHA'] = ['3' * 40]
        cases['GITHUB_WORKFLOW_SHA'] = ['3' * 40]
        cases['RUNNER_ENVIRONMENT'] += ['self-hosted']
        for key, values in cases.items():
            for value in values:
                if value == env[key]: continue
                with self.subTest(key=key, value=value), self.assertRaises((ValueError, TypeError)):
                    c.admission({**env, key: value})
        for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY'):
            with self.assertRaises(c.Refused): c.admission({**env, key: ''})

    def test_actual_local_git_checkout_origin_pair_only(self):
        repo = self.root / 'repo'; repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        r = self.runner(); r.resources = Mock()
        for origin in (c.ORIGIN[:-4], c.ORIGIN, c.ORIGIN + '/evil', c.ORIGIN.upper(), 'git@github.com:r3e-network/neo-os-services.git'):
            subprocess.run(['git', '-C', str(repo), 'config', 'remote.origin.url', origin], check=True)
            if origin in (c.ORIGIN, c.ORIGIN[:-4]):
                self.assertEqual(c.canonical_origin(r, repo), origin)
                self.assertEqual(subprocess.check_output(['git', '-C', str(repo), 'config', 'remote.origin.url']).decode().strip(), c.ORIGIN)
            else:
                with self.assertRaises(c.Refused): c.canonical_origin(r, repo)
                self.assertEqual(subprocess.check_output(['git', '-C', str(repo), 'config', 'remote.origin.url']).decode().strip(), origin)

    def test_bundle_and_real_public_input_validation(self):
        f = self.packaging()
        files = {name: (f.root / name).read_text() for name in ('mainnet.json', 'testnet.json')}
        files['dual-input.json'] = f.input_path.read_text()
        data, digest = packed(files)
        decoded = c.decode_bundle(data, digest)
        path = c.stage_bundle(decoded, self.root / 'public', f.commit, f.repo, fixture.dual)
        self.assertEqual(path.read_bytes(), f.input_path.read_bytes())
        bad = copy.deepcopy(files); bad['mainnet.json'] = bad['testnet.json']
        with self.assertRaises(ValueError): c.stage_bundle(bad, self.root / 'bad', f.commit, f.repo, fixture.dual)
        with self.assertRaises(c.Refused): c.stage_bundle(files, self.root / 'wrong-source', 'f' * 40, f.repo, fixture.dual)

    def test_bundle_unknown_duplicate_paths_limits_digest(self):
        files = {'dual-input.json': '{}', 'mainnet.json': '{}', 'testnet.json': '{}'}
        data, digest = packed(files)
        self.assertEqual(c.decode_bundle(data, digest), files)
        for extra in ('../extra', '/tmp/x', 'private.env'):
            encoded, hashed = packed({**files, extra: '{}'})
            with self.assertRaises(c.Refused): c.decode_bundle(encoded, hashed)
        for encoded, hashed in ((data, '0' * 64), ('!' + data, digest), ('A' * 60001, digest)):
            with self.assertRaises((ValueError, TypeError)): c.decode_bundle(encoded, hashed)
        raw = b'{"schema":"x","schema":"y","files":{}}'
        with self.assertRaises(c.Refused): c.decode_bundle(base64.b64encode(raw).decode(), c.sha(raw))
        encoded, hashed = packed({**files, 'mainnet.json': '{"x":"' + 'x' * 16384 + '"}'})
        with self.assertRaises(c.Refused): c.decode_bundle(encoded, hashed)

    def test_actual_emitted_build_schema_and_negative_measurements(self):
        f = self.packaging()
        with patch('sys.stderr', new=io.StringIO()): value, _ = f.simulate()
        output = f.root / 'result'
        self.assertEqual(c.validate_candidate(output, f.commit, f.hash, fixture.dual), value)
        for mutate in (lambda v: v.update(reviewed_input_sha256='0' * 64),
                       lambda v: v.update(git_commit='0' * 40),
                       lambda v: v.update(reproducible_verified=False),
                       lambda v: v.update(builds=v['builds'][:1]),
                       lambda v: v['builds'][1]['pcrs'].update(PCR0='2' * 96),
                       lambda v: v['builds'][0]['pcrs'].update(PCR0='0' * 96),
                       lambda v: v['builds'][0].update(eif_sha256='0' * 64)):
            changed = copy.deepcopy(value); mutate(changed)
            c.write_json(output / 'build-evidence.json', changed)
            with self.assertRaises(ValueError): c.validate_candidate(output, f.commit, f.hash, fixture.dual)
        c.write_json(output / 'build-evidence.json', value)
        (output / 'extra').touch()
        with self.assertRaises(c.Refused): c.validate_candidate(output, f.commit, f.hash, fixture.dual)
        (output / 'extra').unlink()
        (output / 'enclave.eif').unlink(); (output / 'enclave.eif').symlink_to(output / 'build-evidence.json')
        with self.assertRaises(c.Refused): c.validate_candidate(output, f.commit, f.hash, fixture.dual)

    def test_final_readback_blocks_actual_stock_stop_success_witness(self):
        f = self.packaging(); state = {'running': False}
        def observe(args):
            if args[3:5] == ['buildx', 'build']: state['running'] = True
        with patch('sys.stderr', new=io.StringIO()): value, calls = f.simulate(observe=observe)
        self.assertTrue(state['running'])
        self.assertTrue((f.root / 'result/enclave.eif').is_file())
        self.assertTrue(any(a[3:5] == ['buildx', 'stop'] for a in calls))
        r = self.runner(); r.observed = {CID: {'kind': 'buildkit', 'image_id': BK}}
        r.inventory = Mock(return_value={**EMPTY, 'containers': [CID], 'images': [BK]})
        with self.assertRaises(c.Refused): c.final_daemon_check(r, EMPTY, value['builds'])
        r.inventory.return_value = {**EMPTY, 'images': [BK]}
        self.assertEqual(c.final_daemon_check(r, EMPTY, value['builds']), r.inventory.return_value)
        for field, entries in (('volumes', ['leftover']), ('images', [BK, value['builds'][0]['image_id']]), ('images', [RUST])):
            r.inventory.return_value = {**EMPTY, field: entries}
            with self.assertRaises(c.Refused): c.final_daemon_check(r, EMPTY, value['builds'])
        r.inventory.side_effect = c.CommandFailure('command_failed')
        with self.assertRaises(c.Refused): c.final_daemon_check(r, EMPTY, value['builds'])

    def test_inspect_disappearance_requires_fresh_exact_absence(self):
        r = self.runner(); r.inventory = Mock(return_value={**EMPTY, 'containers': [CID]})
        r.inspect_container = Mock(side_effect=c.CommandFailure('command_failed'))
        r.container_ids = Mock(return_value=[])
        r.observe(); r.container_ids.assert_called_once()
        self.assertEqual(r.observed, {})
        r.container_ids.return_value = [CID]
        with self.assertRaises(c.Refused): r.observe()
        r.container_ids.side_effect = c.CommandFailure('command_failed')
        with self.assertRaises(c.Refused): r.observe()
        r.inspect_container.side_effect = c.Refused('validation')
        r.container_ids.reset_mock()
        with self.assertRaises(c.Refused): r.observe()
        r.container_ids.assert_not_called()

    def test_transient_names_inventory_not_cleanup_authority(self):
        r = self.runner(); r.inventory = Mock(return_value={**EMPTY, 'containers': [CID], 'images': [BK]})
        r.inspect_container = Mock(return_value={'Id': CID, 'Name': '/linuxkit-transient', 'Image': BK})
        r.observe(); self.assertEqual(r.observed[CID]['kind'], 'transient')
        with self.assertRaises(c.Refused): c.final_daemon_check(r, EMPTY, [])
        r.inspect_container.return_value['Image'] = RUST
        with self.assertRaises(c.Refused): r.observe()

    def test_resource_floors_and_log_budget(self):
        value = Mock(f_bavail=c.MIN_FREE, f_frsize=1, f_favail=c.MIN_INODES)
        with patch.object(c.os, 'statvfs', return_value=value):
            self.assertEqual(c.resource_check([self.root])['free_bytes'], c.MIN_FREE)
            value.f_bavail -= 1
            with self.assertRaises(c.Refused): c.resource_check([self.root])
            value.f_bavail += 1; value.f_favail -= 1
            with self.assertRaises(c.Refused): c.resource_check([self.root])
        r = self.runner(); logs = r.root / 'tools/logs'; logs.mkdir(parents=True)
        (logs / 'log').write_bytes(b'12345')
        with patch.object(c, 'resource_check', return_value={'free_bytes': c.MIN_FREE, 'free_inodes': c.MIN_INODES}), patch.object(c, 'CAPTURE_LIMIT', 4):
            with self.assertRaises(c.Refused): r.resources()

    def test_actual_launcher_describe_env_and_obstructed_logs(self):
        tools = self.root / 'tools'; lib = tools / 'native/lib'; lib.mkdir(parents=True)
        loader = lib / 'ld-linux-x86-64.so.2'
        loader.write_text('#!/bin/sh\nset -eu\ntest "$5" = describe-eif\ntest -d "$NITRO_CLI_LOGS_PATH"\ntest "$NITRO_CLI_LOGS_PATH" = "' + str(tools / 'logs') + '"\nprintf ok\n')
        loader.chmod(0o755)
        launcher = tools / 'nitro-cli'; launcher.write_text(c.LAUNCHER); launcher.chmod(0o755)
        result = subprocess.run([launcher, 'describe-eif', '--eif-path', '/synthetic'], env={'PATH': '/usr/bin:/bin', 'NITRO_CLI_LOGS_PATH': '/untrusted'}, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'ok')
        self.assertEqual((tools / 'logs').stat().st_mode & 0o777, 0o700)
        (tools / 'logs').rmdir(); (tools / 'logs').write_text('obstructed')
        self.assertNotEqual(subprocess.run([launcher, 'describe-eif'], capture_output=True).returncode, 0)
        (tools / 'logs').unlink(); (tools / 'logs').symlink_to(self.root)
        self.assertNotEqual(subprocess.run([launcher, 'describe-eif'], capture_output=True).returncode, 0)

    def test_process_failure_timeout_output_and_redaction(self):
        r = self.runner(); r.resources = Mock()
        self.assertEqual(r.run([sys.executable, '-c', 'print("ok")'], tool='python'), b'ok\n')
        with self.assertRaises(c.CommandFailure): r.run([sys.executable, '-c', 'import sys;sys.stderr.write("CANARY");sys.exit(7)'], tool='python')
        receipt = c.failure_receipt(c.CommandFailure('CANARY'), environment())
        self.assertEqual(receipt['exit_code'], 7); self.assertEqual(receipt['tool'], 'python')
        self.assertNotIn('CANARY', json.dumps(receipt))
        with self.assertRaisesRegex(c.Refused, 'timeout'): r.run([sys.executable, '-c', 'import time;time.sleep(10)'], timeout=0.01, tool='python')
        with patch.object(c, 'CAPTURE_LIMIT', 10), self.assertRaisesRegex(c.Refused, 'output_limit'):
            r.run([sys.executable, '-c', 'print("x"*100)'], tool='python')
        self.assertNotIn('CANARY', json.dumps(c.failure_receipt(ValueError('CANARY'), {'GITHUB_RUN_ID': 'CANARY'})))

    def test_download_exact_bytes_no_redirect_and_bounds(self):
        data = b'public source'
        record = {'size': len(data), 'sha256': c.sha(data), 'git_blob': __import__('hashlib').sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}
        r = self.runner(); r.resources = Mock()
        def attempt(content, rec, name, deadline=None):
            response = io.BytesIO(content); response.status = 200
            opener = Mock(); opener.open.return_value = response
            with patch.object(c.urllib.request, 'build_opener', return_value=opener):
                c.download('https://synthetic.invalid/fixed', rec, self.root / name, r, time.monotonic()+10 if deadline is None else deadline)
        attempt(data, record, 'good')
        for content, rec in ((data+b'x', record), (data[:-1], record), (data, {**record, 'sha256': '0'*64}), (data, {**record, 'git_blob': '0'*40})):
            with self.assertRaises(c.Refused): attempt(content, rec, str(len(list(self.root.iterdir()))))
        with self.assertRaisesRegex(c.Refused, 'timeout'): attempt(data, record, 'late', 0)
        with self.assertRaises(c.Refused): c.NoRedirect().redirect_request(None, None, None, None, None, None)

    def test_tool_identity_limits_mounts_and_lost_reply_cleanup(self):
        inputs = self.root / 'inputs'; inputs.mkdir(); work = self.root / 'work'; work.mkdir()
        r = self.runner(); item = {}; removed = []; calls = []
        def run(args, **_kwargs):
            calls.append(args)
            if args[3] == 'create':
                name = args[args.index('--name')+1]; identity = args[args.index('--label')+1].split('=')[1]
                item.update(tool_item(CID, name, RUST, identity, inputs, work, 'none'))
                Path(args[args.index('--cidfile')+1]).write_text(CID)
                raise c.CommandFailure('command_failed')
            if args[3] == 'rm': removed.append(args[-1]); return b''
            raise AssertionError(args)
        r.run = run; r.inspect_container = Mock(side_effect=lambda _: item); r.container_ids = Mock(return_value=[])
        with self.assertRaises(c.CommandFailure): c.owned_tool(r, RUST, inputs, work, 'true', 'none', 5)
        self.assertEqual(removed, [CID]); self.assertFalse(any('start' in call for call in calls))
        good = copy.deepcopy(item); name = good['Name'][1:]; identity = good['Config']['Labels'][c.OWNER_LABEL]
        c.verify_tool(good, CID, name, RUST, identity, inputs, work, 'none')
        for mutate in (lambda x: x.update(Image=BK), lambda x: x['Config']['Labels'].clear(),
                       lambda x: x['HostConfig'].update(Memory=0), lambda x: x['HostConfig'].update(NanoCpus=0),
                       lambda x: x['HostConfig'].update(NetworkMode='host'), lambda x: x['Mounts'][0].update(RW=True)):
            bad = copy.deepcopy(good); mutate(bad)
            with self.assertRaises(c.Refused): c.verify_tool(bad, CID, name, RUST, identity, inputs, work, 'none')

    def test_elf_closure_and_compile_header_network_contract(self):
        lib = self.root / 'lib'; lib.mkdir()
        header = bytearray(20); header[:6] = b'\x7fELF\x02\x01'; header[18:20] = b'\x3e\x00'
        (lib / 'libc.so.6').write_bytes(header); (lib / 'ld-linux-x86-64.so.2').write_bytes(header)
        c.validate_elf(lib / 'libc.so.6')
        output = ('linux-vdso.so.1 (0x123)\nlibc.so.6 => ' + str(lib/'libc.so.6') + ' (0x234)\n' + str(lib/'ld-linux-x86-64.so.2') + ' (0x345)\n').encode()
        self.assertEqual(c.validate_closure(output, lib), ['libc.so.6'])
        with self.assertRaises(c.Refused): c.validate_closure(output.replace(str(lib).encode(), b'/usr/lib'), lib)
        with self.assertRaises(c.Refused): c.validate_closure(output.replace(str(lib/'libc.so.6').encode(), b'/usr/lib/libc.so.6'), lib)
        header[18:20] = b'\xb7\x00'; (lib/'libc.so.6').write_bytes(header)
        with self.assertRaises(c.Refused): c.validate_elf(lib/'libc.so.6')
        self.assertIn('--locked --offline --jobs 1', c.COMPILE)
        self.assertIn('CFLAGS=-I/work/openssl/usr/include/x86_64-linux-gnu', c.COMPILE)
        self.assertIn('OPENSSL_INCLUDE_DIR=/work/openssl/usr/include', c.COMPILE)
        self.assertNotIn('--offline', c.FETCH)

    def test_safe_environment_and_api_interval(self):
        with patch.dict(os.environ, {'AWS_SECRET_ACCESS_KEY': 'CANARY', 'LD_LIBRARY_PATH': '/evil', 'HTTPS_PROXY': 'CANARY'}):
            env = c.safe_env(self.root/'home')
        self.assertNotIn('CANARY', json.dumps(env)); self.assertNotIn('LD_LIBRARY_PATH', env)
        self.assertEqual(c.api_version('1.49'), (1,49))
        for value in ('1.49 evil', None, '99.999'):
            with self.assertRaises(c.Refused): c.api_version(value)


    def test_bootstrap_actual_sequence_with_synthetic_external_tools(self):
        pins = c.parse((c.ROOT / 'deploy/nitro/hosted-native-tools.json').read_bytes())
        r = self.runner(); r.resources = Mock(); r.container_ids = Mock(return_value=[])
        calls = []; operations = []; image_override = {}
        header = bytearray(20); header[:6] = b'\x7fELF\x02\x01'; header[18:20] = b'\x3e\x00'
        def acquire(url, record, destination, runner, deadline):
            self.assertIs(runner, r); self.assertGreater(deadline, time.monotonic())
            self.assertTrue(url.startswith(('https://raw.githubusercontent.com/aws/aws-nitro-enclaves-cli/', 'https://security.debian.org/')))
            destination.parent.mkdir(parents=True, exist_ok=True); destination.write_bytes(b'synthetic')
        def own(runner, image, inputs, work, command, network, timeout):
            self.assertIs(runner, r); self.assertEqual(image, pins['rust_config'])
            operations.append((command, network, timeout))
            if command == c.COMPILE:
                out = work / 'export'; lib = out / 'lib'; lib.mkdir(parents=True)
                for path in (out/'nitro-cli.bin', lib/'libc.so.6', lib/'ld-linux-x86-64.so.2'):
                    path.write_bytes(header)
        def run(args, **kwargs):
            calls.append([str(arg) for arg in args])
            if args[3:5] == ['image', 'inspect']:
                return json.dumps([{'Id': pins['rust_config'], 'Architecture': 'amd64', 'Os': 'linux', 'RepoDigests': ['rust@'+pins['rust_child']], **image_override}]).encode()
            if '--list' in args:
                lib = r.root/'tools/native/lib'
                return ('libc.so.6 => '+str(lib/'libc.so.6')+' (0x123)\n/lib64/ld-linux-x86-64.so.2 (0x456)\n').encode()
            if '--version' in args: return b'Nitro CLI 1.5.2\n'
            self.assertEqual(args[3], 'pull'); self.assertIn('--platform=linux/amd64', args)
            return b''
        r.run = run
        with patch.object(c, 'download', side_effect=acquire), patch.object(c, 'owned_tool', side_effect=own):
            launcher, blobs, receipt = c.bootstrap(r, pins)
        self.assertEqual(operations, [(c.FETCH, 'bridge', 1200), (c.COMPILE, 'none', 3600)])
        self.assertIn('NITRO_CLI_LOGS_PATH', launcher.read_text())
        self.assertEqual(len(list(blobs.iterdir())), 6)
        self.assertEqual(receipt['rust_image_id'], pins['rust_config'])
        self.assertEqual(receipt['files']['native/nitro-cli.bin'], c.sha(header))
        self.assertFalse((r.root/'tool-work').exists()); self.assertFalse((r.root/'tool-inputs').exists())
        for image_override in ({'Os': 'darwin'}, {'Architecture': 'arm64'}, {'Id': BK}, {'RepoDigests': []}):
            r = self.runner(); r.resources = Mock(); r.container_ids = Mock(return_value=[]); r.run = run
            operations.clear()
            with patch.object(c, 'download', side_effect=acquire), patch.object(c, 'owned_tool', side_effect=own):
                with self.assertRaises(c.Refused): c.bootstrap(r, pins)
            self.assertEqual(operations, [], 'unverified image must never run a tool container')

    def test_complete_synthetic_execute_requires_all_artifacts_and_final_absence(self):
        f = self.packaging()
        with patch('sys.stderr', new=io.StringIO()): value, _ = f.simulate()
        expected = f.root/'result'
        pins = f.repo/'deploy/nitro/hosted-native-tools.json'
        pins.write_bytes((c.ROOT/'deploy/nitro/hosted-native-tools.json').read_bytes())
        workflow = f.repo/'.github/workflows/measured-candidate.yml'; workflow.parent.mkdir(parents=True)
        workflow.write_text('synthetic workflow identity')
        files = {name: (f.root/name).read_text() for name in ('mainnet.json','testnet.json')}
        files['dual-input.json'] = f.input_path.read_text()
        encoded, digest = packed(files)
        env = {**environment(f.commit), 'PUBLIC_BUNDLE_BASE64': encoded, 'PUBLIC_BUNDLE_SHA256': digest}
        real_sha = c.file_sha
        class External(c.Runner):
            def __init__(self, root):
                super().__init__(root); self.pulled = False; self.built = False
            def resources(self): pass
            def inventory(self):
                return {'containers': [CID] if self.built and fault == 'leftover' else [],
                        'images': ([RUST] if self.pulled else []) + ([BK] if self.built else []), 'volumes': []}
            def run(self, args, **kwargs):
                args = [str(arg) for arg in args]
                if 'rev-parse' in args: return (f.commit+'\n').encode()
                if 'status' in args: return b''
                if 'get-url' in args: return (c.ORIGIN+'\n').encode()
                if 'ls-remote' in args: return (f.commit+'\trefs/heads/main\n').encode()
                if args[3:4] == ['info']: return json.dumps({'DockerRootDir': str(self.root)}).encode()
                if args[3:4] == ['version']: return b'{"MinAPIVersion":"1.44","ApiVersion":"1.53"}'
                if args[3:5] == ['buildx','version']: return b'github.com/docker/buildx v0.37.2 abc123'
                if args[3:5] == ['image','inspect']: return json.dumps([{'Id': BK, 'Os':'linux', 'Architecture':'amd64', 'Config':{}, 'RepoDigests':[]}]).encode()
                if 'build' in args:
                    self.built = True
                    self.observed = {CID: {'id': CID, 'name': '/buildx_buildkit_neoos-dual-'+'1'*32+'0', 'kind':'buildkit','image_id':BK}}
                    self.observed_images = {RUST,BK}
                    output = Path(args[args.index('--output')+1]); shutil.copytree(expected, output)
                    if fault == 'missing-eif': (output/'enclave.eif').unlink()
                    if fault == 'build-failure': raise c.CommandFailure('command_failed')
                    return b''
                raise AssertionError(args)
        def bootstrap(runner, _pins):
            runner.pulled = True
            return self.root/'synthetic-nitro', self.root/'synthetic-blobs', {'rust_image_id': RUST, 'files': {}}
        for fault in ('none', 'leftover', 'missing-eif', 'build-failure'):
            root = self.root/fault; root.mkdir()
            with patch.object(c, 'ROOT', f.repo), patch.object(c, 'Runner', External), patch.object(c, 'check_host', return_value=16*1024**3), patch.object(c, 'bootstrap', side_effect=bootstrap), patch.object(c, 'load_builder', return_value=fixture.dual), patch.object(c, 'file_sha', side_effect=lambda path: 'd'*64 if Path(path)==Path('/usr/bin/docker') else real_sha(path)):
                if fault == 'none':
                    output = c.execute(root, env); c.checked_artifacts(output)
                    receipt = c.parse((output/'hosted-evidence.json').read_bytes())
                    self.assertEqual(receipt['source_sha'], receipt['workflow_sha'])
                    self.assertFalse(receipt['operational_admission'])
                    self.assertEqual(receipt['reviewed_input_sha256'], f.hash)
                    for name in ('enclave.eif','build-evidence.json','hosted-evidence.json','SHA256SUMS'):
                        original = (output/name).read_bytes(); (output/name).unlink()
                        with self.assertRaises(c.Refused): c.checked_artifacts(output)
                        (output/name).write_bytes(original)
                    original = (output/'enclave.eif').read_bytes()
                    (output/'enclave.eif').write_bytes(original+b'tampered')
                    with self.assertRaises(c.Refused): c.checked_artifacts(output)
                    (output/'enclave.eif').write_bytes(original)
                else:
                    with self.assertRaises(c.Refused): c.execute(root, env)
                    self.assertFalse((root/'candidate/hosted-evidence.json').exists())

    def diagnostic_execute(self, fault, child=None):
        env = environment()
        root = self.root / fault; root.mkdir()
        source_input = root / 'input.json'; source_input.write_text('{}')
        state = {'bootstrapped': False, 'business': False}
        class BusinessReached(Exception): pass
        class External(c.Runner):
            def resources(self): pass
            def observe(self): pass
            def run(self, args, **kwargs):
                c.STATUS.update(tool=kwargs.get('tool', 'docker'), exit_code=0)
                args = [str(arg) for arg in args]
                if 'rev-parse' in args: return (env['GITHUB_SHA']+'\n').encode()
                if 'status' in args: return b''
                if 'get-url' in args: return (c.ORIGIN+'\n').encode()
                if 'ls-remote' in args: return (env['GITHUB_SHA']+'\trefs/heads/main\n').encode()
                if args[3:4] == ['info']: return json.dumps({'DockerRootDir': str(root)}).encode()
                if args[3:5] == ['container', 'ls']:
                    if state['bootstrapped'] and fault == 'container-format': return b'CANARY\n'
                    if state['bootstrapped'] and fault == 'container-duplicate': return ((CID+'\n')*2).encode()
                    if state['bootstrapped'] and fault == 'inventory-command':
                        c.STATUS.update(exit_code=7); raise c.CommandFailure('CANARY')
                    if state['bootstrapped'] and fault == 'inventory-resource': raise c.Refused('resource_reserve')
                    return (CID+'\n').encode() if state['bootstrapped'] and fault == 'containers' else b''
                if args[3:5] == ['volume', 'ls']:
                    if state['bootstrapped'] and fault == 'volume-format': return b'../CANARY'
                    return b'owned-volume\n' if state['bootstrapped'] and fault == 'volumes' else b''
                if args[3:5] == ['image', 'ls']:
                    if state['bootstrapped'] and fault == 'image-decode': return bytes([255])
                    return (BK+'\n').encode() if state['bootstrapped'] and fault == 'images' else b''
                if args[3:4] == ['version']:
                    values = {'api-json': b'{CANARY', 'api-type': b'[]', 'api-duplicate': b'{"ApiVersion":"1.49","ApiVersion":"1.53"}',
                              'api-field': b'{"MinAPIVersion":null,"ApiVersion":"CANARY"}',
                              'api-low': b'{"MinAPIVersion":"1.24","ApiVersion":"1.48"}',
                              'api-high': b'{"MinAPIVersion":"1.50","ApiVersion":"1.53"}'}
                    return values.get(fault, b'{"MinAPIVersion":"1.44","ApiVersion":"1.53"}')
                if args[3:5] == ['buildx', 'version']:
                    if fault == 'buildx-decode': return bytes([255])
                    if fault == 'buildx-format': return b'CANARY unsupported buildx'
                    if fault == 'buildx-command':
                        c.STATUS.update(exit_code=7); raise c.CommandFailure('CANARY')
                    return b'github.com/docker/buildx v0.38.0 abc123'
                if 'build' in args:
                    state['business'] = True
                    if child is not None:
                        return super().run([sys.executable, '-B', '-c', child], **kwargs)
                    raise BusinessReached()
                raise AssertionError('unexpected synthetic operation')
        def boot(*_):
            state['bootstrapped'] = True; c.phase('native-validation')
            return root/'nitro', root/'blobs', {'rust_image_id': RUST}
        with patch.object(c, 'Runner', External), patch.object(c, 'check_host', return_value=16*1024**3), patch.object(c, 'decode_bundle', return_value={}), patch.object(c, 'stage_bundle', return_value=source_input), patch.object(c, 'load_builder', return_value=None), patch.object(c, 'bootstrap', side_effect=boot):
            try: c.execute(root, env)
            except BusinessReached: return None, state
            except Exception as error: return c.failure_receipt(error, env), state
        self.fail('synthetic execute unexpectedly published')

    def payload_case(self):
        spec = importlib.util.spec_from_file_location('payload_fixture', c.ROOT/'scripts/lib/dual_build_payload_diagnostics_test.py')
        fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
        helper = fixtures.module(c.ROOT/'scripts/lib/dual_build_payload_diagnostics.py', 'payload_helper')
        captures = []; builds = []
        for i, data in enumerate((b'one', b'two')):
            raw, pcrs = fixtures.eif_fixture([{'name':b'PRIVATE_PATH_CANARY','data':data}])
            path = self.root/('fixture-'+str(i)+'.eif');path.write_bytes(raw)
            digest = c.sha(raw); captures.append(helper.capture(path,pcrs,digest))
            builds.append({'image_id':'sha256:'+'a'*64,'pcrs':pcrs,'eif_sha256':digest})
        return builds, helper.frame(captures).encode()+b'\n'

    def test_payload_comparison_actual_child_receipt(self):
        builds, payload = self.payload_case()
        receipt,state = self.diagnostic_execute('payload-child', child_program(build_line(builds)+payload+frame_line(measurement_failure())))
        self.assertTrue(state['business'])
        self.assertIn('business_payload_comparison',receipt)
        detail = receipt['business_payload_comparison']
        self.assertEqual(detail['status'],'complete')
        self.assertEqual(detail['comparison']['counts']['content'],1)
        self.assertEqual([x['eif_sha256'] for x in detail['attempts']],[x['eif_sha256'] for x in builds])
        self.assertEqual(receipt['exit_code'],7);self.assertFalse(receipt['artifact_admitted'])
        self.assertEqual(receipt['business_failure'],measurement_failure())
        self.assertIs(receipt['outer_cleanup_failed'],False)
        self.assertNotIn('PRIVATE_PATH_CANARY',json.dumps(receipt))
        self.assertLessEqual(len(json.dumps(receipt).encode()),16384)
        error=c.BusinessCommandFailure(7,build_line(builds)+payload+frame_line(measurement_failure()))
        # Even an internal optional-detail regression cannot expand the public envelope.
        error.payload_comparison={'internal':'x'*16384}
        bounded=c.failure_receipt(error,environment())
        self.assertNotIn('business_payload_comparison',bounded)
        self.assertEqual(bounded['business_failure'],measurement_failure())
        self.assertEqual(bounded['exit_code'],7)

    def test_payload_optional_negative_frames_preserve_primary_and_cleanup(self):
        builds,line=self.payload_case();value=json.loads(line.split(b' ',1)[1])
        bad_values=[None,{},[],True,{**value,'extra':'PRIVATE_CANARY'},{**value,'schema':'unknown'},
                    {**value,'status':'unknown'},{'schema':value['schema'],'status':'unavailable','extra':1}]
        def changed(path, item):
            bad=copy.deepcopy(value);target=bad
            for part in path[:-1]:target=target[part]
            target[path[-1]]=item;bad_values.append(bad)
        for path,items in [
            (('attempts',),[[],value['attempts'][:1],value['attempts']*2]),
            (('attempts',0,'eif_sha256'),['0'*64,None,True]),
            (('attempts',0,'sections'),[{},None]),
            (('attempts',0,'sections','customer'),[{}, {'bytes':1,'sha256':'A'*64}]),
            (('attempts',0,'sections','customer','bytes'),[True,-1,2**64]),
            (('attempts',0,'cpio','entries'),[True,-1,65537]),
            (('attempts',0,'cpio','payload_sha256'),['CANARY','A'*64]),
            (('comparison','counts','content'),[True,-1,65537]),
            (('comparison','counts','added'),[1]),
            (('comparison','samples'),[value['comparison']['samples']*9]),
            (('comparison','samples',0,'label'),['PRIVATE_CANARY','cmd']),
            (('comparison','samples',0,'path_sha256'),['A'*64,'canary']),
            (('comparison','samples',0,'occurrence'),[True,-1,65536]),
            (('comparison','samples',0,'changes'),[[],['CANARY'],['added','content'],['content','content']]),
            (('comparison','unclassified_customer_bytes'),[True,0,None]),
        ]:
            for item in items:changed(path,item)
        invalid=[b'',b'BUILD-PAYLOAD-DIAGNOSTIC CANARY\n',line+line,b' '+line,b'CANARY '+line,
                 line.replace(b'"schema":',b'"schema":"bad","schema":',1),
                 line.replace(b'"entries":1',b'"entries":NaN',1),
                 b'BUILD-PAYLOAD-DIAGNOSTIC '+b' '*8193+b'{}\n',
                 b'BUILD-PAYLOAD-DIAGNOSTIC '+b'['*1500+b']'*1500+b'\n']
        invalid += [b'BUILD-PAYLOAD-DIAGNOSTIC '+json.dumps(x).encode()+b'\n' for x in bad_values]
        for inner in (False,True):
            frame=measurement_failure();frame['cleanup_failed']=inner
            for outer in (False,True):
                for index,data in enumerate(invalid):
                    with self.subTest(inner=inner,outer=outer,index=index):
                        error=c.BusinessCommandFailure(7,build_line(builds)+data+frame_line(frame))
                        error.outer_cleanup_failed=outer
                        receipt=c.failure_receipt(error,environment())
                        self.assertNotIn('business_payload_comparison',receipt)
                        self.assertEqual(receipt['business_failure'],frame)
                        self.assertIs(receipt['outer_cleanup_failed'],outer)
                        self.assertEqual(receipt['exit_code'],7);self.assertFalse(receipt['artifact_admitted'])
                        self.assertNotIn('CANARY',json.dumps(receipt))
        for key,item in [('stage','image-build'),('attempt',1),('kind','timeout')]:
            frame=measurement_failure();frame['primary'][key]=item
            receipt=c.failure_receipt(c.BusinessCommandFailure(7,build_line(builds)+line+frame_line(frame)),environment())
            self.assertNotIn('business_payload_comparison',receipt)
        for stderr in (line+frame_line(measurement_failure()),line+build_line(builds)+frame_line(measurement_failure()),build_line(builds)+frame_line(measurement_failure())+line):
            self.assertNotIn('business_payload_comparison',c.failure_receipt(c.BusinessCommandFailure(7,stderr),environment()))
        unavailable=b'BUILD-PAYLOAD-DIAGNOSTIC '+json.dumps({'schema':value['schema'],'status':'unavailable'}).encode()+b'\n'
        receipt=c.failure_receipt(c.BusinessCommandFailure(7,build_line(builds)+unavailable+frame_line(measurement_failure())),environment())
        self.assertNotIn('business_payload_comparison',receipt)
        self.assertFalse(receipt['artifact_admitted'])

    def test_payload_actual_child_cleanup_and_unrelated_success_never_admit(self):
        builds,line=self.payload_case();frame=measurement_failure();frame['cleanup_failed']=True
        stderr=build_line(builds)+line+frame_line(frame)
        r=self.runner();r.resources=Mock();real_stop=c.stop_process
        def cleanup(process):
            real_stop(process);raise PermissionError('PRIVATE_CANARY')
        c.phase('business-build')
        with patch.object(c,'stop_process',side_effect=cleanup):
            with self.assertRaises(c.BusinessCommandFailure) as failed:
                r.run([sys.executable,'-B','-c',child_program(stderr)],tool='python',business_diagnostic=True)
        receipt=c.failure_receipt(failed.exception,environment())
        self.assertIn('business_payload_comparison',receipt)
        self.assertEqual(receipt['business_failure'],frame);self.assertIs(receipt['outer_cleanup_failed'],True)
        self.assertEqual(receipt['exit_code'],7);self.assertFalse(receipt['artifact_admitted'])
        self.assertNotIn('PRIVATE_CANARY',json.dumps(receipt))
        with self.assertRaises(c.CommandFailure) as unrelated:
            r.run([sys.executable,'-B','-c',child_program(stderr)],tool='python')
        self.assertNotIn('business_payload_comparison',c.failure_receipt(unrelated.exception,environment()))
        with patch.object(c,'business_payload_comparison',side_effect=AssertionError('must not parse success')):
            self.assertEqual(r.run([sys.executable,'-B','-c',child_program(stderr,0)],tool='python',business_diagnostic=True),b'')
        next_error=c.BusinessCommandFailure(7,frame_line(frame))
        self.assertNotIn('business_payload_comparison',c.failure_receipt(next_error,environment()))

    def test_measurement_comparison_actual_execute_failure(self):
        values = build_vectors(); frame = measurement_failure()
        receipt, state = self.diagnostic_execute('comparison-child', child_program(
            b'CANARY\n' + build_line(values) + frame_line(frame)))
        self.assertTrue(state['business'])
        self.assertEqual(receipt.get('business_comparison'), {
            'builds': values,
            'equal': {'image_id': True, 'eif_sha256': False,
                      'pcrs': {'PCR0': False, 'PCR1': True, 'PCR2': True}}})
        self.assertEqual(receipt['business_failure'], frame)
        self.assertEqual((receipt['tool'], receipt['exit_code'], receipt['reason']), ('python', 7, 'command_failed'))
        self.assertIs(receipt['outer_cleanup_failed'], False)
        self.assertFalse(receipt['artifact_admitted']); self.assertNotIn('CANARY', json.dumps(receipt))
        self.assertFalse((self.root/'comparison-child/candidate/hosted-evidence.json').exists())

    def test_comparison_shape_digest_and_context_negatives(self):
        frame = measurement_failure(); values = build_vectors()
        invalid = [None, {}, 'CANARY', True, [], values[:1], values+[values[0]], [None, values[1]], [True, values[1]]]
        for index in (0, 1):
            for key in values[index]:
                changed = copy.deepcopy(values); del changed[index][key]; invalid.append(changed)
            changed = copy.deepcopy(values); changed[index]['message'] = 'CANARY'; invalid.append(changed)
            for key, bad_values in {
                    'image_id': [None, True, [], 'a'*64, 'sha256:'+'a'*63, 'sha256:'+'A'*64, 'sha256:'+'a'*65, 'sha256:'+'a'*64+'\n'],
                    'eif_sha256': [None, 0, [], 'b'*63, 'B'*64, 'b'*65, 'b'*64+'\n'],
                    'pcrs': [None, [], True, {'PCR0':'1'*96}, {**values[index]['pcrs'], 'PCR3':'4'*96}]}.items():
                for value in bad_values:
                    changed = copy.deepcopy(values); changed[index][key] = value; invalid.append(changed)
            for key in ('PCR0', 'PCR1', 'PCR2'):
                for value in (None, False, [], 1, '0'*96, 'a'*95, 'a'*97, 'A'*96, 'a'*96+'\n', '１'*96):
                    changed = copy.deepcopy(values); changed[index]['pcrs'][key] = value; invalid.append(changed)
        for index, value in enumerate(invalid):
            with self.subTest(index=index):
                error = c.BusinessCommandFailure(7, build_line(value)+frame_line(frame))
                receipt = c.failure_receipt(error, environment())
                self.assertNotIn('business_comparison', receipt)
                self.assertEqual(receipt['business_failure'], frame)
                self.assertEqual(receipt['exit_code'], 7); self.assertIs(receipt['outer_cleanup_failed'], False)
                self.assertFalse(receipt['artifact_admitted']); self.assertNotIn('CANARY', json.dumps(receipt))
        for field, value in (('stage', 'image-build'), ('stage', 'cleanup'), ('attempt', 0), ('attempt', 1),
                             ('attempt', 2.0), ('kind', 'command_failed'), ('kind', 'timeout'), ('kind', 'os_error')):
            changed = copy.deepcopy(frame); changed['primary'][field] = value
            error = c.BusinessCommandFailure(7, build_line(values)+frame_line(changed))
            self.assertNotIn('business_comparison', c.failure_receipt(error, environment()))

    def test_comparison_framing_duplicates_limits_and_order(self):
        values = build_vectors(); line = build_line(values); final = frame_line(measurement_failure())
        for prefix in (b'CANARY\xff\n', b''):
            error = c.BusinessCommandFailure(7, prefix+line+b'cleanup noise\n'+final+b' \n')
            self.assertIsInstance(error.comparison, dict)
            self.assertEqual(error.comparison['builds'], values)
        bad = [b'', b'BUILD-EVIDENCE CANARY\n', line+line, b' '+line, b'CANARY '+line,
               line.replace(b'"image_id":', b'"image_id":"sha256:'+b'a'*64+b'","image_id":', 1),
               line.replace(b'"PCR0":', b'"PCR0":"'+b'1'*96+b'","PCR0":', 1),
               line.replace(b'"eif_sha256": "'+b'b'*64+b'"', b'"eif_sha256": NaN'),
               line.replace(b'"eif_sha256": "'+b'b'*64+b'"', b'"eif_sha256": Infinity'),
               line.replace(b'"eif_sha256": "'+b'b'*64+b'"', b'"eif_sha256": -Infinity'),
               line.replace(b'sha256:', b'sha256:\xff', 1), line.rstrip()+b'{}\n',
               b'BUILD-EVIDENCE '+b'['*1500+b']'*1500+b'\n']
        for index, prefix in enumerate(bad):
            with self.subTest(index=index):
                receipt = c.failure_receipt(c.BusinessCommandFailure(7, prefix+final), environment())
                self.assertNotIn('business_comparison', receipt)
                self.assertEqual(receipt['business_failure'], measurement_failure())
        for stderr in (final+line, line+final+final, line+b'DUAL-BUILD-FAILURE CANARY\n', line):
            receipt = c.failure_receipt(c.BusinessCommandFailure(7, stderr), environment())
            self.assertNotIn('business_comparison', receipt)
            self.assertEqual(receipt['exit_code'], 7); self.assertIs(receipt['outer_cleanup_failed'], False)
        payload = json.dumps(values).encode()
        at_limit = b'BUILD-EVIDENCE '+b' '*(4096-len(payload))+payload+b'\n'
        self.assertIsNotNone(c.BusinessCommandFailure(7, at_limit+final).comparison)
        receipt = c.failure_receipt(c.BusinessCommandFailure(7, at_limit.replace(b'BUILD-EVIDENCE ', b'BUILD-EVIDENCE  ')+final), environment())
        self.assertNotIn('business_comparison', receipt); self.assertEqual(receipt['business_failure'], measurement_failure())
        data = line+final
        with patch.object(c, 'CAPTURE_LIMIT', len(data)):
            self.assertIsNotNone(c.BusinessCommandFailure(7, data).comparison)
            self.assertIsNone(c.BusinessCommandFailure(7, b'\n'+data).comparison)
        # Preserve actual attempt order, including equal image IDs. No root-cause
        # or inequality is inferred from the refusal; all fields are comparisons.
        for field in ('image_id', 'eif_sha256', 'PCR0', 'PCR1', 'PCR2', 'all-equal'):
            changed = copy.deepcopy(values)
            if field in ('image_id', 'eif_sha256'):
                changed[1][field] = ('sha256:' if field == 'image_id' else '')+'d'*64
            elif field != 'all-equal': changed[1]['pcrs'][field] = 'e'*96
            else: changed[1] = copy.deepcopy(changed[0])
            for ordered in (changed, list(reversed(changed))):
                comparison = c.BusinessCommandFailure(7, build_line(ordered)+final).comparison
                self.assertIsInstance(comparison, dict)
                self.assertEqual(set(comparison), {'builds', 'equal'})
                self.assertEqual(comparison['builds'], ordered)
                self.assertEqual(comparison['equal'], {
                    'image_id': ordered[0]['image_id']==ordered[1]['image_id'],
                    'eif_sha256': ordered[0]['eif_sha256']==ordered[1]['eif_sha256'],
                    'pcrs': {key:ordered[0]['pcrs'][key]==ordered[1]['pcrs'][key] for key in ('PCR0','PCR1','PCR2')}})

    def test_comparison_actual_child_cleanup_scope_and_stale_isolation(self):
        r = self.runner(); r.resources = Mock(); real_stop = c.stop_process
        for inner_cleanup in (False, True):
            for evidence_case in ('missing', 'malformed', 'valid'):
                evidence_valid = evidence_case == 'valid'
                frame = measurement_failure(); frame['cleanup_failed'] = inner_cleanup
                prefix = build_line(build_vectors()) if evidence_valid else (b'' if evidence_case == 'missing' else b'BUILD-EVIDENCE CANARY\n')
                def cleanup(process):
                    real_stop(process); c.STATUS.update(tool='docker', exit_code=99)
                    raise PermissionError('CANARY')
                c.phase('business-build')
                with patch.object(c, 'stop_process', side_effect=cleanup):
                    try:
                        r.run([sys.executable, '-B', '-c', child_program(prefix+frame_line(frame))],
                              tool='python', business_diagnostic=True)
                    except Exception as error:
                        self.assertIsInstance(error, c.BusinessCommandFailure)
                        receipt = c.failure_receipt(error, environment())
                        if evidence_valid: last_error = error
                    else: self.fail('nonzero business child admitted')
                self.assertEqual(receipt['business_failure'], frame)
                self.assertEqual('business_comparison' in receipt, evidence_valid)
                self.assertIs(receipt['outer_cleanup_failed'], True)
                self.assertEqual((receipt['tool'], receipt['exit_code']), ('python', 7))
                self.assertFalse(receipt['artifact_admitted']); self.assertNotIn('CANARY', json.dumps(receipt))
        env = environment(); env.update(RUNNER_TEMP=str(self.root), GITHUB_OUTPUT=str(self.root/'comparison-output'))
        old_handler = c.signal.getsignal(c.signal.SIGTERM)
        self.addCleanup(c.signal.signal, c.signal.SIGTERM, old_handler)
        with patch.dict(os.environ, env, clear=True), patch.object(c, 'execute', side_effect=last_error), patch('sys.stderr', new=io.StringIO()) as captured:
            with self.assertRaises(SystemExit) as raised: c.main()
            self.assertEqual(raised.exception.code, 1)
            emitted = json.loads(captured.getvalue())
            self.assertIn('business_comparison', emitted)
            self.assertEqual(emitted['business_comparison']['builds'], build_vectors())
            self.assertIs(emitted['business_failure']['cleanup_failed'], True)
            self.assertIs(emitted['outer_cleanup_failed'], True)
            self.assertEqual(emitted['exit_code'], 7); self.assertFalse(emitted['artifact_admitted'])
            self.assertFalse((self.root/'comparison-output').exists()); self.assertNotIn('CANARY', captured.getvalue())
        stderr = build_line(build_vectors())+frame_line(measurement_failure())
        c.phase('business-build')
        with self.assertRaises(c.CommandFailure) as raised:
            r.run([sys.executable, '-B', '-c', child_program(stderr)], tool='python')
        self.assertNotIn('business_comparison', c.failure_receipt(raised.exception, environment()))
        with patch.object(c, 'business_build_comparison', side_effect=AssertionError('success must not parse')):
            self.assertEqual(r.run([sys.executable, '-B', '-c', child_program(stderr, 0)],
                                  tool='python', business_diagnostic=True), b'')
        r.observe = Mock(side_effect=c.CommandFailure('CANARY'))
        with self.assertRaises(c.CommandFailure) as raised:
            r.run([sys.executable, '-B', '-c', child_program(stderr)], tool='python', observe=True, business_diagnostic=True)
        self.assertNotIn('business_comparison', c.failure_receipt(raised.exception, environment()))
        c.phase('business-build')
        with self.assertRaises(c.CommandFailure) as raised:
            r.run([sys.executable, '-B', '-c', child_program(b'CANARY')], tool='python', business_diagnostic=True)
        self.assertNotIn('business_comparison', c.failure_receipt(raised.exception, environment()))
        self.assertNotIn('business_comparison', c.failure_receipt(c.Refused('validation'), environment()))

    def test_business_child_frame_through_execute(self):
        frame = business_frame()
        receipt, state = self.diagnostic_execute('business-child', child_program(frame_line(frame)))
        self.assertTrue(state['business'])
        self.assertEqual(receipt.get('business_failure'), frame)
        self.assertEqual((receipt['phase'], receipt['tool'], receipt['exit_code'], receipt['reason']),
                         ('business-build', 'python', 7, 'command_failed'))
        self.assertFalse(receipt['artifact_admitted'])
        self.assertFalse((self.root/'business-child/candidate/hosted-evidence.json').exists())
        self.assertNotIn('CANARY', json.dumps(receipt))

    def test_business_frame_exact_schema_types_enums_and_bounds(self):
        frame = business_frame()
        for stage in ('admission', 'staging', 'canonical', 'buildkit-create', 'image-build',
                      'image-inspect', 'image-export', 'image-verify', 'enclave-build',
                      'enclave-describe', 'measurements', 'cleanup', 'publication', 'unknown'):
            changed = copy.deepcopy(frame); changed['primary']['stage'] = stage
            self.assertEqual(c.business_failure_detail(frame_line(changed)), changed)
        for kind in ('validation', 'command_failed', 'timeout', 'os_error', 'interrupted', 'unknown'):
            changed = copy.deepcopy(frame); changed['primary']['kind'] = kind
            self.assertEqual(c.business_failure_detail(frame_line(changed)), changed)
        for attempt in (0, 1, 2):
            for code in (None, -128, 0, 255):
                changed = copy.deepcopy(frame); changed['primary'].update(attempt=attempt, exit_code=code)
                changed['cleanup_failed'] = False
                changed['primary']['error_codes'] = ['E%04d' % i for i in range(16)]
                changed['primary']['hints'] = ['cargo-resolution', 'disk-full', 'memory-exhaustion',
                                                'network', 'package-unavailable', 'rust-compile']
                self.assertEqual(c.business_failure_detail(frame_line(changed)), changed)
        empty = copy.deepcopy(frame); empty['primary'].update(error_codes=[], hints=[])
        self.assertEqual(c.business_failure_detail(frame_line(empty)), empty)
        invalid = []
        for container in (None, 'primary'):
            original = frame if container is None else frame['primary']
            for key in original:
                changed = copy.deepcopy(frame)
                target = changed if container is None else changed['primary']
                del target[key]; invalid.append(changed)
            changed = copy.deepcopy(frame)
            (changed if container is None else changed['primary'])['message'] = 'CANARY'
            invalid.append(changed)
        for key, values in {
                'stage': ['CANARY', '', 'IMAGE-BUILD', [], None],
                'kind': ['CANARY', [], None], 'attempt': [True, False, -1, 3, 1.0, '1', None],
                'exit_code': [True, False, -129, 256, 0.0, '0', []],
                'error_codes': [None, 'E0001', [1], [['E0001']], ['E123'], ['E１２３４'],
                                ['E1234\n'], ['E0001', 'E0001'], ['E0002', 'E0001'],
                                ['E%04d' % i for i in range(17)]],
                'hints': [None, 'network', ['CANARY'], [False], [['network']],
                          ['network', 'network'], ['rust-compile', 'disk-full']]}.items():
            for value in values:
                changed = copy.deepcopy(frame); changed['primary'][key] = value; invalid.append(changed)
        for key, values in {'schema': ['CANARY', None, []], 'primary': [None, [], 'CANARY'],
                            'cleanup_failed': [0, 1, None, 'true', []]}.items():
            for value in values:
                changed = copy.deepcopy(frame); changed[key] = value; invalid.append(changed)
        for index, changed in enumerate(invalid):
            with self.subTest(index=index): self.assertIsNone(c.business_failure_detail(frame_line(changed)))
        for value in ([], None, 'CANARY', 1):
            self.assertIsNone(c.business_failure_detail(frame_line(value)))

    def test_business_frame_framing_duplicates_size_and_no_raw_leak(self):
        frame = business_frame(); line = frame_line(frame)
        self.assertEqual(c.business_failure_detail(b'CANARY\xff\n' + line + b' \r\n\n'), frame)
        malformed = [b'', b'CANARY', line+b'CANARY\n', line+line, b'noise '+line,
                     b' '+line, b'DUAL-BUILD-FAILURE CANARY\n'+line,
                     line.replace(b'"schema":', b'"schema":"neoos/dual-build-failure/v1","schema":'),
                     line.replace(b'"attempt":', b'"attempt":1,"attempt":'),
                     line.replace(b'"attempt": 1', b'"attempt": NaN'),
                     line.replace(b'"attempt": 1', b'"attempt": Infinity'),
                     line.replace(b'image-build', b'\xff'), line.rstrip()+b'{}\n',
                     b'DUAL-BUILD-FAILURE '+b'['*1500+b']'*1500,
                     b'DUAL-BUILD-FAILURE '+b' '*4097+line[len(b'DUAL-BUILD-FAILURE '):]]
        for index, stderr in enumerate(malformed):
            with self.subTest(index=index): self.assertIsNone(c.business_failure_detail(stderr))
        with patch.object(c, 'CAPTURE_LIMIT', len(line)):
            self.assertEqual(c.business_failure_detail(line), frame)
            self.assertIsNone(c.business_failure_detail(b'\n'+line))

    def test_business_child_invalid_frames_preserve_actual_failure(self):
        frame = business_frame(); line = frame_line(frame)
        invalid_type = copy.deepcopy(frame); invalid_type['primary']['attempt'] = True
        for index, stderr in enumerate((b'CANARY', line+b'CANARY', line+line, frame_line(invalid_type),
                                        line.replace(b'"stage":', b'"stage":"unknown","stage":'))):
            with self.subTest(index=index):
                receipt, state = self.diagnostic_execute('bad-child-'+str(index), child_program(stderr))
                self.assertTrue(state['business'])
                self.assertNotIn('business_failure', receipt)
                self.assertEqual((receipt['tool'], receipt['exit_code'], receipt['reason']), ('python', 7, 'command_failed'))
                self.assertFalse(receipt['artifact_admitted']); self.assertNotIn('CANARY', json.dumps(receipt))

    def test_business_capture_read_error_retains_nonzero_child(self):
        r = self.runner(); r.resources = Mock(); c.phase('business-build')
        real_file = c.tempfile.TemporaryFile
        files = []
        def capture(**kwargs):
            stream = real_file(**kwargs); files.append(stream)
            if len(files) == 2:
                stream.read = Mock(side_effect=OSError('CANARY'))
            return stream
        with patch.object(c.tempfile, 'TemporaryFile', side_effect=capture):
            try:
                r.run([sys.executable, '-B', '-c', child_program(frame_line(business_frame()))],
                      tool='python', business_diagnostic=True)
            except Exception as error:
                self.assertIsInstance(error, c.CommandFailure)
                receipt = c.failure_receipt(error, environment())
            else:
                self.fail('nonzero child admitted')
        self.assertEqual((receipt['tool'], receipt['exit_code'], receipt['reason']), ('python', 7, 'command_failed'))
        self.assertNotIn('business_failure', receipt)
        self.assertNotIn('CANARY', json.dumps(receipt)); self.assertFalse(receipt['artifact_admitted'])

    def test_business_outer_cleanup_failure_is_independent(self):
        for inner_cleanup in (False, True, None, 'malformed'):
            for cleanup_fails in (False, True):
                with self.subTest(inner=inner_cleanup, cleanup_fails=cleanup_fails):
                    frame = business_frame()
                    if type(inner_cleanup) is bool:
                        frame['cleanup_failed'] = inner_cleanup
                        stderr = frame_line(frame)
                    else:
                        stderr = b'' if inner_cleanup is None else b'DUAL-BUILD-FAILURE CANARY\n'
                    r = self.runner(); r.resources = Mock(); c.phase('business-build')
                    processes = []; real_spawn = c.subprocess.Popen; real_killpg = c.os.killpg
                    def spawn(*args, **kwargs):
                        process = real_spawn(*args, **kwargs); processes.append(process); return process
                    def killpg(*args):
                        if cleanup_fails: raise PermissionError('CANARY')
                        return real_killpg(*args)
                    try:
                        with patch.object(c.subprocess, 'Popen', side_effect=spawn), patch.object(c.os, 'killpg', side_effect=killpg):
                            try:
                                r.run([sys.executable, '-B', '-c', child_program(stderr)],
                                      tool='python', business_diagnostic=True)
                            except BaseException as error:
                                self.assertIsInstance(error, c.CommandFailure)
                                receipt = c.failure_receipt(error, environment())
                            else:
                                self.fail('nonzero child admitted')
                        self.assertIs(receipt.get('outer_cleanup_failed'), cleanup_fails)
                        self.assertEqual((receipt['tool'], receipt['exit_code'], receipt['reason']), ('python', 7, 'command_failed'))
                        self.assertFalse(receipt['artifact_admitted']); self.assertNotIn('CANARY', json.dumps(receipt))
                        if type(inner_cleanup) is bool:
                            self.assertEqual(receipt.get('business_failure'), frame)
                        else:
                            self.assertNotIn('business_failure', receipt)
                    finally:
                        # The injected permission refusal must not leave test processes.
                        for process in processes:
                            c.stop_process(process)
                            self.assertEqual(process.wait(timeout=5), 7)
        for error in (c.CommandFailure('CANARY'), c.Refused('validation')):
            self.assertNotIn('outer_cleanup_failed', c.failure_receipt(error, environment()))
        # A successful child whose cleanup fails still fails through the
        # existing generic path, never as a fabricated business command failure.
        r = self.runner(); r.resources = Mock(); c.phase('business-build')
        real_stop = c.stop_process
        def failed_cleanup(process):
            real_stop(process)
            raise PermissionError('CANARY')
        with patch.object(c, 'stop_process', side_effect=failed_cleanup):
            try:
                r.run([sys.executable, '-B', '-c', child_program(b'', 0)], tool='python', business_diagnostic=True)
            except BaseException as error:
                self.assertIsInstance(error, PermissionError)
                receipt = c.failure_receipt(error, environment())
            else:
                self.fail('successful child admitted despite cleanup failure')
        self.assertNotIn('outer_cleanup_failed', receipt)
        self.assertNotIn('business_failure', receipt)
        self.assertFalse(receipt['artifact_admitted']); self.assertNotIn('CANARY', json.dumps(receipt))

    def test_business_outer_cleanup_interruptions_preserve_primary(self):
        real_stop = c.stop_process
        for failure in (InterruptedError('CANARY'), KeyboardInterrupt('CANARY'), subprocess.TimeoutExpired('CANARY', 5)):
            r = self.runner(); r.resources = Mock(); c.phase('business-build')
            def cleanup(process):
                real_stop(process)
                raise failure
            with patch.object(c, 'stop_process', side_effect=cleanup):
                try:
                    r.run([sys.executable, '-B', '-c', child_program(b'')], tool='python', business_diagnostic=True)
                except BaseException as error:
                    self.assertIsInstance(error, c.CommandFailure)
                    receipt = c.failure_receipt(error, environment())
                else:
                    self.fail('nonzero child admitted')
            self.assertIs(receipt.get('outer_cleanup_failed'), True)
            self.assertEqual((receipt['tool'], receipt['exit_code']), ('python', 7))
            self.assertFalse(receipt['artifact_admitted']); self.assertNotIn('business_failure', receipt)
            self.assertNotIn('CANARY', json.dumps(receipt))

    def abort_receipt(self, observer, cleanup_failure=None):
        r = self.runner(); r.resources = Mock(); c.phase('business-build')
        processes = []; real_spawn = c.subprocess.Popen; real_stop = c.stop_process
        real_clock = time.monotonic
        ready = [self.root / 'business-ready', self.root / 'observer-ready']
        def spawn(*args, **kwargs):
            child = real_spawn(*args, **kwargs); processes.append(child)
            deadline = real_clock() + 3
            while not ready[len(processes)-1].exists() and real_clock() < deadline:
                time.sleep(0.005)
            self.assertTrue(ready[len(processes)-1].exists(), 'real child must run before injected deadline')
            return child
        def clock():
            # The nested observer keeps its real15s budget. Advance only after
            # both real synthetic children exist; the11500s parent is not due.
            return real_clock() + (16 if observer and len(processes) >= 2 else 0)
        def cleanup(child):
            real_stop(child)
            target = processes[-1] if cleanup_failure == 'observer' else processes[0]
            if cleanup_failure and child is target: raise PermissionError('CLEANUP_CANARY')
        def sleeping_child(marker):
            return ('import sys,time;from pathlib import Path;sys.stderr.write("RAW_CANARY\\n");'
                    'sys.stderr.flush();Path(' + repr(str(marker)) + ').write_text("ready");time.sleep(30)')
        r.docker = [sys.executable, '-B', '-c', sleeping_child(ready[1])]
        if observer: r.observe = r.container_ids
        try:
            with patch.object(c.subprocess, 'Popen', side_effect=spawn), patch.object(c.time, 'monotonic', side_effect=clock), patch.object(c, 'stop_process', side_effect=cleanup):
                try:
                    r.run([sys.executable, '-B', '-c', sleeping_child(ready[0])],
                          timeout=11500 if observer else 0, tool='python', observe=observer, business_diagnostic=True)
                except BaseException as error:
                    receipt = c.failure_receipt(error, environment())
                else: self.fail('aborted child admitted')
        finally:
            for child in processes: real_stop(child)
            for marker in ready:
                marker.unlink(missing_ok=True)
        self.assertEqual(len(processes), 2 if observer else 1)
        self.assertTrue(all(child.poll() is not None for child in processes))
        return receipt

    def test_nested_observer_timeout_retains_command_context(self):
        receipt = self.abort_receipt(True)
        self.assertEqual((receipt['phase'], receipt['tool'], receipt['reason'], receipt['exit_code']),
                         ('business-build', 'docker', 'timeout', None))
        self.assertEqual(receipt.get('command_failure'), {'schema':'neoos/hosted-command-failure/v1',
                         'scope':'observer', 'operation':'container-list'})
        self.assertIs(receipt.get('outer_cleanup_failed'), False)
        self.assertIs(receipt['artifact_admitted'], False)
        self.assertNotIn('business_failure', receipt)
        self.assertNotIn('CANARY', json.dumps(receipt))

    def test_abort_cleanup_preserves_primary_and_independent_flag(self):
        for observer, cleanup in ((True,'observer'), (True,'outer'), (False,'outer'), (False,None)):
            with self.subTest(observer=observer, cleanup=cleanup):
                receipt = self.abort_receipt(observer, cleanup)
                self.assertEqual((receipt['reason'], receipt['tool'], receipt['exit_code']),
                                 ('timeout', 'docker' if observer else 'python', None))
                self.assertEqual(receipt.get('command_failure'), {'schema':'neoos/hosted-command-failure/v1',
                                 'scope':'observer' if observer else 'business-child',
                                 'operation':'container-list' if observer else 'business-build'})
                self.assertIs(receipt.get('outer_cleanup_failed'), cleanup is not None)
                self.assertIs(receipt['artifact_admitted'], False)
                self.assertNotIn('business_failure', receipt)
                self.assertNotIn('CANARY', json.dumps(receipt))

    def test_command_context_static_operations_and_unrelated_isolation(self):
        r = self.runner()
        with patch.object(r, 'run', side_effect=[b'', b'', b'']) as command:
            self.assertEqual(r.inventory(), EMPTY)
            self.assertEqual([x.kwargs['operation'] for x in command.call_args_list],
                             ['container-list', 'image-list', 'volume-list'])
            self.assertTrue(all(x.kwargs['timeout'] == 15 for x in command.call_args_list))
        with patch.object(r, 'run', return_value=json.dumps([{'Id': CID}]).encode()) as command:
            r.inspect_container(CID)
            self.assertEqual(command.call_args.kwargs, {'timeout':15, 'operation':'container-inspect'})
        r.resources = Mock(); c.phase('business-build')
        with patch.object(c.subprocess, 'Popen') as spawn, self.assertRaises(c.Refused):
            r.run(['CANARY'], operation='CANARY')
        spawn.assert_not_called()
        self.assertEqual(r._observer_depth, 0)
        r.observe = Mock(side_effect=c.Refused('timeout'))
        with self.assertRaises(c.Refused) as observer_failure:
            r.run([sys.executable, '-B', '-c', 'import time;time.sleep(2)'],
                  tool='python', observe=True, business_diagnostic=True)
        observed = c.failure_receipt(observer_failure.exception, environment())
        self.assertEqual((observed['tool'], observed['reason']), ('none', 'timeout'))
        self.assertEqual(observed['command_failure']['scope'], 'observer')
        self.assertEqual(observed['command_failure']['operation'], 'command')
        self.assertEqual(r._observer_depth, 0)
        # Subsequent unrelated and successful calls inherit no failure detail.
        with self.assertRaises(c.CommandFailure) as failed:
            r.run([sys.executable, '-B', '-c', child_program(b'CANARY')], tool='python')
        receipt = c.failure_receipt(failed.exception, environment())
        self.assertNotIn('command_failure', receipt)
        self.assertNotIn('outer_cleanup_failed', receipt)
        self.assertNotIn('CANARY', json.dumps(receipt))
        self.assertEqual(r.run([sys.executable, '-B', '-c', 'print("ok")'], tool='python'), b'ok\n')

    def test_command_context_is_immutable_and_public_enums_only(self):
        error = c.Refused('timeout')
        valid = c.CommandDiagnostic('business-build', 'docker', 'timeout', None, 'observer', 'container-list')
        with self.assertRaises(AttributeError): valid.tool = 'CANARY'
        for field, value in [('phase','CANARY'), ('tool','CANARY'), ('reason','CANARY'),
                             ('scope','CANARY'), ('operation','CANARY'), ('code',True), ('code',256),
                             ('phase',[]), ('tool',{}), ('operation',None)]:
            error._hosted_command = valid._replace(**{field:value})
            receipt = c.failure_receipt(error, environment())
            self.assertNotIn('command_failure', receipt)
            self.assertNotIn('CANARY', json.dumps(receipt))
        for operation in c.COMMAND_OPERATIONS:
            error._hosted_command = valid._replace(operation=operation)
            receipt = c.failure_receipt(error, environment())
            self.assertEqual(set(receipt['command_failure']), {'schema','scope','operation'})
            self.assertEqual(receipt['command_failure']['operation'], operation)
            self.assertLess(len(json.dumps(receipt)), 2048)
        self.assertNotIn('command_failure', c.failure_receipt(c.Refused('timeout'), environment()))

    def test_observer_nonzero_context_and_main_keep_failure_closed(self):
        r = self.runner(); r.resources = Mock(); c.phase('business-build')
        r.docker = [sys.executable, '-B', '-c', child_program(b'RAW_CANARY', 23)]
        r.observe = r.container_ids
        with self.assertRaises(c.CommandFailure) as failed:
            r.run([sys.executable, '-B', '-c', 'import time;time.sleep(3)'],
                  tool='python', observe=True, business_diagnostic=True)
        error = failed.exception
        receipt = c.failure_receipt(error, environment())
        self.assertEqual((receipt['tool'], receipt['exit_code'], receipt['reason']), ('docker',23,'command_failed'))
        self.assertEqual(receipt['command_failure']['scope'], 'observer')
        self.assertNotIn('business_failure', receipt)
        self.assertNotIn('CANARY', json.dumps(receipt))
        env = environment(); env.update(RUNNER_TEMP=str(self.root), GITHUB_OUTPUT=str(self.root/'no-output'))
        old_handler = c.signal.getsignal(c.signal.SIGTERM)
        self.addCleanup(c.signal.signal, c.signal.SIGTERM, old_handler)
        with patch.dict(os.environ, env, clear=True), patch.object(c, 'execute', side_effect=error), patch('sys.stderr', new=io.StringIO()) as captured:
            with self.assertRaises(SystemExit) as terminal: c.main()
        self.assertEqual(terminal.exception.code, 1)
        self.assertEqual(json.loads(captured.getvalue()), receipt)
        self.assertFalse((self.root/'no-output').exists())

    def test_business_child_scope_success_observer_timeout_and_main(self):
        line = frame_line(business_frame())
        r = self.runner(); r.resources = Mock(); c.phase('business-build')
        # Same phase/tool/frame without the exact call site's opt-in is unrelated.
        with self.assertRaises(c.CommandFailure) as raised:
            r.run([sys.executable, '-B', '-c', child_program(line)], tool='python')
        self.assertNotIn('business_failure', c.failure_receipt(raised.exception, environment()))
        for phase_name, tool in (('native-validation', 'python'), ('business-build', 'docker')):
            c.phase(phase_name)
            with patch.object(c.subprocess, 'Popen') as spawn, self.assertRaises(c.Refused):
                r.run(['never'], tool=tool, business_diagnostic=True)
            spawn.assert_not_called()
        c.phase('business-build')
        with patch.object(c, 'business_failure_detail', side_effect=AssertionError('success must not parse')):
            self.assertEqual(r.run([sys.executable, '-B', '-c', child_program(line, 0)],
                                  tool='python', business_diagnostic=True), b'')
        r.observe = Mock(side_effect=c.CommandFailure('CANARY'))
        with self.assertRaises(c.CommandFailure) as raised:
            r.run([sys.executable, '-B', '-c', child_program(line)],
                  tool='python', observe=True, business_diagnostic=True)
        self.assertNotIn('business_failure', c.failure_receipt(raised.exception, environment()))
        with self.assertRaises(c.Refused) as raised:
            r.run([sys.executable, '-B', '-c', 'import time;time.sleep(5)'],
                  tool='python', timeout=0, business_diagnostic=True)
        self.assertNotIn('business_failure', c.failure_receipt(raised.exception, environment()))
        with patch.object(c, 'CAPTURE_LIMIT', 16), self.assertRaises(c.Refused) as raised:
            r.run([sys.executable, '-B', '-c', child_program(line)], tool='python', business_diagnostic=True)
        self.assertNotIn('business_failure', c.failure_receipt(raised.exception, environment()))
        # Real nonzero child, then an observer/cleanup status overwrite/error.
        real_stop = c.stop_process
        def cleanup(process):
            real_stop(process); c.STATUS.update(tool='docker', exit_code=99)
            raise c.CommandFailure('CANARY')
        with patch.object(c, 'stop_process', side_effect=cleanup), self.assertRaises(c.CommandFailure) as raised:
            r.run([sys.executable, '-B', '-c', child_program(b'CANARY\n'+line)],
                  tool='python', business_diagnostic=True)
        error = raised.exception
        receipt = c.failure_receipt(error, environment())
        self.assertEqual((receipt['tool'], receipt['exit_code']), ('python', 7))
        self.assertEqual(receipt.get('business_failure'), business_frame())
        env = environment(); env.update(RUNNER_TEMP=str(self.root), GITHUB_OUTPUT=str(self.root/'job-output'))
        old_handler = c.signal.getsignal(c.signal.SIGTERM)
        self.addCleanup(c.signal.signal, c.signal.SIGTERM, old_handler)
        with patch.dict(os.environ, env, clear=True), patch.object(c, 'execute', side_effect=error), patch('sys.stderr', new=io.StringIO()) as captured:
            with self.assertRaises(SystemExit) as exit_error: c.main()
            self.assertEqual(exit_error.exception.code, 1)
            self.assertEqual(json.loads(captured.getvalue()).get('business_failure'), business_frame())
            self.assertIs(json.loads(captured.getvalue()).get('outer_cleanup_failed'), True)
            self.assertNotIn('CANARY', captured.getvalue()); self.assertFalse((self.root/'job-output').exists())
        # No ambient detail survives a subsequent unrelated failure.
        self.assertNotIn('business_failure', c.failure_receipt(c.Refused('validation'), env))

    def test_execute_diagnostics_distinguish_post_bootstrap_rejections(self):
        cases = {'containers': ('post-bootstrap-inventory', 'baseline_containers'),
                 'volumes': ('post-bootstrap-inventory', 'baseline_volumes'),
                 'images': ('post-bootstrap-inventory', 'baseline_images'),
                 'container-format': ('post-bootstrap-inventory', 'inventory_response'),
                 'container-duplicate': ('post-bootstrap-inventory', 'inventory_response'),
                 'volume-format': ('post-bootstrap-inventory', 'inventory_response'),
                 'image-decode': ('post-bootstrap-inventory', 'inventory_response'),
                 'inventory-command': ('post-bootstrap-inventory', 'command_failed'),
                 'inventory-resource': ('post-bootstrap-inventory', 'resource_reserve'),
                 'api-json': ('docker-api', 'docker_api_response'),
                 'api-type': ('docker-api', 'docker_api_response'),
                 'api-duplicate': ('docker-api', 'docker_api_response'),
                 'api-field': ('docker-api', 'docker_api_response'),
                 'api-low': ('docker-api', 'docker_api_range'),
                 'api-high': ('docker-api', 'docker_api_range'),
                 'buildx-decode': ('buildx', 'buildx_response'),
                 'buildx-format': ('buildx', 'buildx_format'),
                 'buildx-command': ('buildx', 'command_failed')}
        for fault, expected in cases.items():
            with self.subTest(fault=fault):
                receipt, state = self.diagnostic_execute(fault)
                self.assertIsNotNone(receipt)
                self.assertEqual((receipt['phase'], receipt['reason']), expected)
                self.assertEqual(receipt['tool'], 'docker')
                self.assertEqual(receipt['exit_code'], 7 if fault in ('buildx-command', 'inventory-command') else 0)
                self.assertFalse(receipt['artifact_admitted']); self.assertFalse(state['business'])
                self.assertNotIn('CANARY', json.dumps(receipt))
                self.assertEqual(set(receipt), {'schema', 'artifact_admitted', 'phase', 'tool', 'reason', 'exit_code', 'candidate_source_sha', 'github_workflow_sha', 'github_run_id', 'github_run_attempt'})

    def test_execute_compatibility_refusal_precedes_tool_bootstrap(self):
        for fault in ('api-low', 'api-type', 'buildx-format'):
            with self.subTest(fault=fault):
                receipt, state = self.diagnostic_execute(fault)
                self.assertIsNotNone(receipt)
                self.assertFalse(state['bootstrapped'])
                self.assertFalse(state['business'])
        receipt, state = self.diagnostic_execute('valid')
        self.assertIsNone(receipt)
        self.assertTrue(state['bootstrapped']); self.assertTrue(state['business'])

    def test_main_failure_and_cancellation_never_emit_verified(self):
        env = environment(); env.update(RUNNER_TEMP=str(self.root), GITHUB_OUTPUT=str(self.root/'job-output'))
        old_handler = c.signal.getsignal(c.signal.SIGTERM)
        self.addCleanup(c.signal.signal, c.signal.SIGTERM, old_handler)
        for error in (c.CommandFailure('CANARY'), InterruptedError('CANARY'), c.Refused('resource_reserve')):
            with patch.dict(os.environ, env, clear=True), patch.object(c, 'execute', side_effect=error), patch('sys.stderr', new=io.StringIO()) as captured:
                with self.assertRaises(SystemExit) as raised: c.main()
                self.assertEqual(raised.exception.code, 1)
                result = json.loads(captured.getvalue())
                self.assertFalse(result['artifact_admitted']); self.assertNotIn('CANARY', captured.getvalue())
                self.assertFalse((self.root/'job-output').exists())


from hosted_docker_install_test import DockerUpgrade


if __name__ == '__main__':
    unittest.main()

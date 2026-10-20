#!/usr/bin/env python3
"""Manual public hosted candidate orchestration; never deployment admission.

The business builder remains authoritative for profile validation and repeated
measurements. This driver adds exclusive-runner resource/readback gates. A
failed or interrupted run has no artifact output and must discard its VM.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import hosted_docker_install

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = 'r3e-network/neo-os-services'
ORIGIN = 'https://github.com/' + REPOSITORY + '.git'
HEX40 = re.compile(r'[0-9a-f]{40}')
HEX64 = re.compile(r'[0-9a-f]{64}')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}')
MIN_FREE = 2 * 1024**3
MIN_INODES = 50000
CAPTURE_LIMIT = 16 * 1024**2
OWNER_LABEL = 'com.neoos.hosted-tool-owner'
PHASES = {'admission', 'source', 'public-tools', 'tool-fetch', 'tool-compile',
          'native-validation', 'docker-api', 'buildx', 'post-bootstrap-inventory',
          'business-build', 'final-readback', 'publication',
          'docker-install-check', 'docker-install', 'docker-install-readback'}
TOOLS = {'none', 'git', 'docker', 'python', 'loader', 'nitro', 'download'}
STATUS = {'phase': 'admission', 'tool': 'none', 'exit_code': None}


BUSINESS_PREFIX = b'DUAL-BUILD-FAILURE '
BUILD_EVIDENCE_PREFIX = b'BUILD-EVIDENCE '
BUSINESS_STAGES = {'admission', 'staging', 'canonical', 'buildkit-create', 'image-build',
                   'image-inspect', 'image-export', 'image-verify', 'enclave-build',
                   'enclave-describe', 'measurements', 'cleanup', 'publication', 'unknown'}
BUSINESS_KINDS = {'validation', 'command_failed', 'timeout', 'os_error', 'interrupted', 'unknown'}
BUSINESS_HINTS = {'rust-compile', 'cargo-resolution', 'disk-full', 'memory-exhaustion',
                  'network', 'package-unavailable'}


class Refused(ValueError):
    """Only a static reason enum, never child output or input data."""


class CommandFailure(Refused):
    pass


def require(ok, reason='validation'):
    if not ok:
        raise Refused(reason)


def phase(name):
    require(name in PHASES)
    STATUS.update(phase=name, tool='none', exit_code=None)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            digest.update(block)
    return digest.hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def parse(data):
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda _: require(False))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n')


def admission(env):
    expected = {'GITHUB_REPOSITORY': REPOSITORY, 'GITHUB_REF': 'refs/heads/main',
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'CANDIDATE_REPOSITORY_PRIVATE': 'false',
                'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
                'GITHUB_WORKFLOW_REF': REPOSITORY + '/.github/workflows/measured-candidate.yml@refs/heads/main'}
    require(all(env.get(key) == value for key, value in expected.items()))
    for key in ('CANDIDATE_SOURCE_SHA', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA'):
        require(HEX40.fullmatch(env.get(key, '')) is not None)
    require(env['CANDIDATE_SOURCE_SHA'] == env['GITHUB_SHA'] == env['GITHUB_WORKFLOW_SHA'])
    require(HEX64.fullmatch(env.get('PUBLIC_BUNDLE_SHA256', '')) is not None)
    for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        require(re.fullmatch(r'[1-9][0-9]{0,19}', env.get(key, '')) is not None)
    require(not any(key in env for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY')))
    return env['CANDIDATE_SOURCE_SHA']


def decode_bundle(encoded, digest):
    require(isinstance(encoded, str) and len(encoded) <= 60000)
    raw = base64.b64decode(encoded, validate=True)
    require(len(raw) <= 45000 and sha(raw) == digest)
    value = parse(raw)
    require(isinstance(value, dict) and set(value) == {'schema', 'files'})
    require(value['schema'] == 'neoos/dual-public-bundle/v1')
    files = value['files']
    required = {'dual-input.json', 'mainnet.json', 'testnet.json'}
    require(isinstance(files, dict) and set(files) in (required, required | {'testnet-enrollment.json'}))
    for text in files.values():
        require(isinstance(text, str) and len(text.encode()) <= 16384 and isinstance(parse(text), dict))
    return files


def load_builder(repo):
    spec = importlib.util.spec_from_file_location('hosted_business_builder', Path(repo) / 'deploy/nitro/build-dual-enclave.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stage_bundle(files, destination, source, repo, builder):
    destination.mkdir(mode=0o700)
    for name, content in files.items():
        (destination / name).write_bytes(content.encode())
    path = destination / 'dual-input.json'
    require(parse(path.read_bytes()).get('source_commit') == source)
    registry = {name: parse((repo / 'config/networks' / (name + '.json')).read_bytes()) for name in ('mainnet', 'testnet')}
    spec, _, _ = builder.public_inputs(path, file_sha(path), registry)
    require(('testnet-enrollment.json' in files) == ('enrollment' in spec['networks']['testnet']))
    return path


def safe_env(home):
    home.mkdir(mode=0o700)
    (home / 'docker').mkdir(mode=0o700)
    write_json(home / 'docker/config.json', {'auths': {}})
    return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'DOCKER_CONFIG': str(home / 'docker'),
            'LANG': 'C', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_TERMINAL_PROMPT': '0', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_GRAFT_FILE': os.devnull}


def resource_check(paths):
    values = [os.statvfs(path) for path in paths]
    free = min(value.f_bavail * value.f_frsize for value in values)
    inodes = min(value.f_favail for value in values)
    require(free >= MIN_FREE and inodes >= MIN_INODES, 'resource_reserve')
    return {'free_bytes': free, 'free_inodes': inodes}


def business_failure_detail(stderr):
    """Optional bounded enum-only detail; invalid frames never replace failure."""
    try:
        require(len(stderr) <= CAPTURE_LIMIT and stderr.count(BUSINESS_PREFIX) == 1)
        lines = [line for line in stderr.splitlines() if line.strip()]
        require(bool(lines) and lines[-1].startswith(BUSINESS_PREFIX))
        frame = lines[-1][len(BUSINESS_PREFIX):]
        require(len(frame) <= 4096)
        value = parse(frame)
        require(type(value) is dict and set(value) == {'schema', 'primary', 'cleanup_failed'})
        require(value['schema'] == 'neoos/dual-build-failure/v1' and type(value['cleanup_failed']) is bool)
        primary = value['primary']
        require(type(primary) is dict and set(primary) == {'stage', 'attempt', 'kind', 'exit_code', 'error_codes', 'hints'})
        require(type(primary['stage']) is str and primary['stage'] in BUSINESS_STAGES)
        require(type(primary['kind']) is str and primary['kind'] in BUSINESS_KINDS)
        require(type(primary['attempt']) is int and primary['attempt'] in (0, 1, 2))
        code = primary['exit_code']
        require(code is None or (type(code) is int and -128 <= code <= 255))
        codes, hints = primary['error_codes'], primary['hints']
        require(type(codes) is list and len(codes) <= 16)
        require(all(type(item) is str and re.fullmatch(r'E[0-9]{4}', item) for item in codes))
        require(codes == sorted(set(codes)))
        require(type(hints) is list and len(hints) <= len(BUSINESS_HINTS))
        require(all(type(item) is str and item in BUSINESS_HINTS for item in hints))
        require(hints == sorted(set(hints)))
        return value
    except (ValueError, TypeError, RecursionError):
        return None


def business_build_comparison(stderr, detail):
    """Existing public digest vectors only; equality is not a root-cause label."""
    if detail is None:
        return None
    primary = detail['primary']
    if (primary['stage'], primary['attempt'], primary['kind']) != ('measurements', 2, 'validation'):
        return None
    try:
        require(len(stderr) <= CAPTURE_LIMIT and stderr.count(BUILD_EVIDENCE_PREFIX) == 1)
        # detail came from the same capture's validated final failure frame.
        # The comparison must be its own earlier line, never later or embedded.
        lines = [line for line in stderr.splitlines() if line.strip()]
        frames = [line[len(BUILD_EVIDENCE_PREFIX):] for line in lines[:-1]
                  if line.startswith(BUILD_EVIDENCE_PREFIX)]
        require(len(frames) == 1 and len(frames[0]) <= 4096)
        builds = parse(frames[0])
        require(type(builds) is list and len(builds) == 2)
        for item in builds:
            require(type(item) is dict and set(item) == {'image_id', 'pcrs', 'eif_sha256'})
            require(type(item['image_id']) is str and re.fullmatch(r'sha256:[0-9a-f]{64}', item['image_id']))
            require(type(item['eif_sha256']) is str and re.fullmatch(r'[0-9a-f]{64}', item['eif_sha256']))
            pcrs = item['pcrs']
            require(type(pcrs) is dict and set(pcrs) == {'PCR0', 'PCR1', 'PCR2'})
            require(all(type(value) is str and re.fullmatch(r'[0-9a-f]{96}', value)
                        and set(value) != {'0'} for value in pcrs.values()))
        first, second = builds
        return {'builds': builds, 'equal': {
            'image_id': first['image_id'] == second['image_id'],
            'eif_sha256': first['eif_sha256'] == second['eif_sha256'],
            'pcrs': {key: first['pcrs'][key] == second['pcrs'][key] for key in ('PCR0', 'PCR1', 'PCR2')},
        }}
    except (ValueError, TypeError, RecursionError):
        return None


def business_payload_comparison(stderr, comparison):
    # A validated existing comparison supplies the ordered EIF bindings and the
    # measurements/attempt2/validation context. Invalid optional data is dropped.
    if comparison is None:
        return None
    prefix = b'BUILD-PAYLOAD-DIAGNOSTIC '
    try:
        require(len(stderr) <= CAPTURE_LIMIT and stderr.count(prefix) == 1)
        lines = [line for line in stderr.splitlines() if line.strip()]
        frames = [line[len(prefix):] for line in lines[:-1] if line.startswith(prefix)]
        require(len(frames) == 1 and len(frames[0]) <= 8192)
        require(next(i for i,line in enumerate(lines) if line.startswith(BUILD_EVIDENCE_PREFIX))
                < next(i for i,line in enumerate(lines) if line.startswith(prefix)))
        # Keep public-input and prepare-only imports independent of this helper.
        spec = importlib.util.spec_from_file_location('hosted_payload_diagnostics', ROOT/'scripts/lib/dual_build_payload_diagnostics.py')
        helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
        return helper.validate(parse(frames[0]), comparison['builds'])
    except InterruptedError:
        raise
    except Exception:
        return None


class BusinessCommandFailure(CommandFailure):
    def __init__(self, code, stderr):
        super().__init__('command_failed')
        self.code = code
        self.outer_cleanup_failed = False
        # No raw stderr is retained on the exception or in the public receipt.
        self.detail = business_failure_detail(stderr)
        self.comparison = business_build_comparison(stderr, self.detail)
        self.payload_comparison = business_payload_comparison(stderr, self.comparison)


def failure_receipt(error, env):
    reason = str(error) if type(error) is Refused else 'validation'
    if isinstance(error, CommandFailure):
        reason = 'command_failed'
    elif isinstance(error, (KeyboardInterrupt, InterruptedError)):
        reason = 'cancelled'
    elif isinstance(error, TimeoutError):
        reason = 'timeout'
    allowed = {'validation', 'command_failed', 'cancelled', 'timeout', 'resource_reserve', 'output_limit', 'log_limit',
               'inventory_response', 'baseline_containers', 'baseline_volumes', 'baseline_images',
               'docker_api_response', 'docker_api_range', 'buildx_response', 'buildx_format', 'docker_install_validation'}
    result = {'schema': 'neoos/hosted-candidate-failure/v1', 'artifact_admitted': False,
              'phase': STATUS['phase'] if STATUS['phase'] in PHASES else 'admission',
              'tool': STATUS['tool'] if STATUS['tool'] in TOOLS else 'none',
              'reason': reason if reason in allowed else 'validation',
              'exit_code': STATUS['exit_code'] if type(STATUS['exit_code']) is int and -128 <= STATUS['exit_code'] <= 255 else None}
    if type(error) is BusinessCommandFailure:
        result.update(phase='business-build', tool='python',
                      exit_code=error.code if type(error.code) is int and -128 <= error.code <= 255 else None)
        result['outer_cleanup_failed'] = error.outer_cleanup_failed
        if error.detail is not None:
            result['business_failure'] = error.detail
        if error.comparison is not None:
            result['business_comparison'] = error.comparison
        if error.payload_comparison is not None:
            result['business_payload_comparison'] = error.payload_comparison
    for key, pattern in (('CANDIDATE_SOURCE_SHA', HEX40), ('GITHUB_WORKFLOW_SHA', HEX40),
                         ('GITHUB_RUN_ID', re.compile(r'[1-9][0-9]{0,19}')),
                         ('GITHUB_RUN_ATTEMPT', re.compile(r'[1-9][0-9]{0,19}'))):
        if pattern.fullmatch(env.get(key, '')):
            result[key.lower()] = env[key]
    # The complete public receipt stays bounded; only optional detail is dropped.
    if 'business_payload_comparison' in result and len(json.dumps(result).encode()) > 16384:
        del result['business_payload_comparison']
    return result


def stop_process(process):
    # Reap even when the leader has exited: descendants can retain the group.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


class Runner:
    def __init__(self, root):
        self.root = root
        self.env = safe_env(root / 'home')
        self.paths = [root]
        self.minimum = {'free_bytes': 2**63, 'free_inodes': 2**63}
        self.observed = {}
        self.observed_images = set()
        self.docker = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']

    def resources(self):
        current = resource_check(self.paths)
        self.minimum = {key: min(current[key], value) for key, value in self.minimum.items()}
        logs = self.root / 'tools/logs'
        if logs.exists():
            require(logs.is_dir() and not logs.is_symlink())
            size = 0
            for path in logs.iterdir():
                info = path.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                size += info.st_size
            require(size <= CAPTURE_LIMIT, 'log_limit')

    def run(self, args, timeout=120, tool='docker', observe=False, business_diagnostic=False):
        require(tool in TOOLS)
        require(not business_diagnostic or (tool == 'python' and STATUS['phase'] == 'business-build'))
        STATUS.update(tool=tool, exit_code=None)
        self.resources()
        deadline = time.monotonic() + timeout
        # Captures live only on this disposable VM; never expose raw child data.
        with tempfile.TemporaryFile(dir=self.root) as out, tempfile.TemporaryFile(dir=self.root) as err:
            process = subprocess.Popen([str(arg) for arg in args], env=self.env,
                                       stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       start_new_session=True)
            business_error = None
            try:
                while True:
                    self.resources()
                    require(max(os.fstat(out.fileno()).st_size, os.fstat(err.fileno()).st_size) <= CAPTURE_LIMIT, 'output_limit')
                    if observe:
                        self.observe()
                    if process.poll() is not None:
                        break
                    require(time.monotonic() < deadline, 'timeout')
                    time.sleep(0.2)
                STATUS.update(tool=tool, exit_code=process.returncode)
                if process.returncode != 0:
                    if business_diagnostic:
                        try:
                            err.seek(0)
                            stderr = err.read(CAPTURE_LIMIT + 1)
                        except OSError:
                            stderr = b''
                        business_error = BusinessCommandFailure(process.returncode, stderr)
                        raise business_error
                    raise CommandFailure('command_failed')
                out.seek(0)
                return out.read(CAPTURE_LIMIT + 1)
            finally:
                # Nested observer commands must not replace the failing tool.
                STATUS.update(tool=tool, exit_code=process.poll())
                try:
                    stop_process(process)
                except BaseException:
                    if business_error is None:
                        raise
                    business_error.outer_cleanup_failed = True
                finally:
                    # Observer/cleanup status cannot overwrite this child failure.
                    if business_error is not None:
                        raise business_error from None

    def container_ids(self):
        ids = self.run([*self.docker, 'container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'], timeout=15).decode().splitlines()
        require(len(ids) <= 64 and len(ids) == len(set(ids)) and all(HEX64.fullmatch(item) for item in ids))
        return ids

    def inventory(self):
        containers = self.container_ids()
        images = self.run([*self.docker, 'image', 'ls', '--all', '--no-trunc', '--quiet'], timeout=15).decode().splitlines()
        volumes = self.run([*self.docker, 'volume', 'ls', '--quiet'], timeout=15).decode().splitlines()
        require(len(images) <= 1024 and all(IMAGE.fullmatch(item) for item in images))
        require(len(volumes) <= 64 and all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', item) for item in volumes))
        return {'containers': sorted(containers), 'images': sorted(set(images)), 'volumes': sorted(volumes)}

    def inspect_container(self, cid):
        require(HEX64.fullmatch(cid) is not None)
        details = parse(self.run([*self.docker, 'container', 'inspect', cid], timeout=15))
        require(isinstance(details, list) and len(details) == 1 and details[0].get('Id') == cid)
        return details[0]

    def observe(self):
        inventory = self.inventory()
        self.observed_images.update(inventory['images'])
        for cid in inventory['containers']:
            try:
                item = self.inspect_container(cid)
            except CommandFailure:
                # A successful fresh list proving exact-ID absence is the only
                # permitted list/inspect race. Malformed replies remain HOLD.
                require(cid not in self.container_ids())
                continue
            require(IMAGE.fullmatch(item.get('Image', '')) is not None)
            name = item.get('Name', '')
            require(re.fullmatch(r'/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name) is not None)
            kind = 'buildkit' if re.fullmatch(r'/buildx_buildkit_neoos-dual-[0-9a-f]{32}0', name) else 'transient'
            # Nitro's pinned LinuxKit can create its own transient containers.
            # Inventory is provenance, never permission to delete/adopt by name.
            record = {'id': cid, 'name': name, 'image_id': item['Image'], 'kind': kind}
            require(cid not in self.observed or self.observed[cid] == record)
            self.observed[cid] = record


def final_daemon_check(runner, baseline, builds):
    final = runner.inventory()
    require(not baseline['containers'] and not baseline['volumes'])
    require(not final['containers'] and not final['volumes'])
    builders = [item for item in runner.observed.values() if item['kind'] == 'buildkit']
    require(len(builders) == 1)
    allowed = set(baseline['images']) | {item['image_id'] for item in builders}
    require(set(final['images']) <= allowed)
    require(all(item['image_id'] not in final['images'] for item in builds))
    return final


def validate_candidate(output, source, input_sha, builder):
    require(set(path.name for path in output.iterdir()) == {'enclave.eif', 'build-evidence.json'})
    for name in ('enclave.eif', 'build-evidence.json'):
        info = (output / name).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size > 0)
    require((output / 'build-evidence.json').stat().st_size <= 4 * 1024**2)
    value = parse((output / 'build-evidence.json').read_bytes())
    require(value.get('schema') == 'neoos/dual-image-build-evidence/v1')
    require(value.get('git_commit') == source and value.get('reviewed_input_sha256') == input_sha)
    require(value.get('reproducible_verified') is True and value.get('hash_algorithm') == 'SHA384')
    builds = value.get('builds')
    require(isinstance(builds, list) and len(builds) == 2)
    for item in builds:
        require(set(item) == {'image_id', 'eif_sha256', 'pcrs'})
        require(IMAGE.fullmatch(item['image_id']) is not None and HEX64.fullmatch(item['eif_sha256']) is not None)
        require(set(item['pcrs']) == {'PCR0', 'PCR1', 'PCR2'})
        builder.measurements(json.dumps({'Measurements': {'HashAlgorithm': 'SHA384', **item['pcrs']}}))
    require(builds[0]['pcrs'] == builds[1]['pcrs'])
    require(file_sha(output / 'enclave.eif') == builds[0]['eif_sha256'])
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise Refused('validation')


def download(url, record, destination, runner, deadline):
    STATUS.update(tool='download', exit_code=None)
    require(type(record['size']) is int and 0 < record['size'] <= 64 * 1024**2)
    require(HEX64.fullmatch(record['sha256']) is not None)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Explicitly disable proxy discovery and redirects. Only committed public
    # origins assembled in bootstrap are passed here; dispatch supplies no URL.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    digest = hashlib.sha256()
    blob = hashlib.sha1(b'blob ' + str(record['size']).encode() + b'\0')
    total = 0
    with opener.open(url, timeout=30) as response, destination.open('xb') as stream:
        require(response.status == 200)
        while True:
            runner.resources()
            require(time.monotonic() < deadline, 'timeout')
            block = response.read1(65536)
            if not block:
                break
            total += len(block)
            require(total <= record['size'])
            digest.update(block); blob.update(block); stream.write(block)
    require(total == record['size'] and digest.hexdigest() == record['sha256'])
    require('git_blob' not in record or blob.hexdigest() == record['git_blob'])


def owned_tool(runner, image, inputs, work, command, network, timeout):
    require(IMAGE.fullmatch(image) is not None and network in ('bridge', 'none'))
    identity = os.urandom(16).hex()
    name = 'neoos-native-tool-' + identity
    cidfile = runner.root / (identity + '.cid')
    cid = None
    try:
        reply = runner.run([*runner.docker, 'create', '--name', name, '--cidfile', cidfile,
                            '--label', OWNER_LABEL + '=' + identity, '--memory=4g', '--memory-swap=4g', '--cpus=1',
                            '--pids-limit=256', '--restart=no', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                            '--network=' + network, '--user', str(os.getuid()) + ':' + str(os.getgid()),
                            '--mount', 'type=bind,src=' + str(inputs) + ',dst=/inputs,readonly',
                            '--mount', 'type=bind,src=' + str(work) + ',dst=/work', '--workdir=/work/source',
                            '--env=HOME=/work', '--env=CARGO_HOME=/work/cargo', '--env=RUSTUP_HOME=/usr/local/rustup',
                            '--env=CARGO_BUILD_JOBS=1', '--env=CARGO_PROFILE_DEV_DEBUG=0',
                            image, '/bin/sh', '-ec', command], timeout=60).decode().strip()
        require(HEX64.fullmatch(reply) is not None)
        cid = reply
        require(cidfile.read_text().strip() == cid)
        verify_tool(runner.inspect_container(cid), cid, name, image, identity, inputs, work, network)
        runner.run([*runner.docker, 'start', '--attach', cid], timeout=timeout)
        item = runner.inspect_container(cid)
        verify_tool(item, cid, name, image, identity, inputs, work, network)
        require(item.get('State', {}).get('Running') is False and item['State'].get('ExitCode') == 0 and item['State'].get('OOMKilled') is False)
    finally:
        # Lost create reply is reconciled only from this fresh private CID file.
        # No name adoption or broad daemon cleanup is permitted.
        if cid is None and cidfile.exists():
            require(cidfile.is_file() and not cidfile.is_symlink() and cidfile.stat().st_size <= 65)
            cid = cidfile.read_text().strip()
        if cid is not None:
            require(HEX64.fullmatch(cid) is not None)
            verify_tool(runner.inspect_container(cid), cid, name, image, identity, inputs, work, network)
            runner.run([*runner.docker, 'rm', '--force', cid], timeout=60)
            require(cid not in runner.container_ids())


def verify_tool(item, cid, name, image, identity, inputs, work, network):
    require(item.get('Id') == cid and item.get('Name') == '/' + name and item.get('Image') == image)
    require(item.get('Config', {}).get('Labels', {}).get(OWNER_LABEL) == identity)
    require(item['Config'].get('User') == str(os.getuid()) + ':' + str(os.getgid()))
    config = item.get('HostConfig', {})
    require(config.get('Memory') == 4 * 1024**3 and config.get('MemorySwap') == 4 * 1024**3)
    require(config.get('NanoCpus') == 10**9 and config.get('PidsLimit') == 256)
    require(config.get('NetworkMode') == network and config.get('Privileged') is False)
    require(config.get('RestartPolicy', {}).get('Name') == 'no' and config.get('CapDrop') == ['ALL'])
    require(config.get('SecurityOpt') == ['no-new-privileges'])
    mounts = item.get('Mounts', [])
    require(len(mounts) == 2)
    observed = {(mount.get('Type'), mount.get('Source'), mount.get('Destination'), mount.get('RW')) for mount in mounts}
    require(observed == {('bind', str(inputs), '/inputs', False), ('bind', str(work), '/work', True)})


FETCH = 'cargo fetch --locked --target x86_64-unknown-linux-gnu'
COMPILE = r'''test "$(rustc --version | cut -d' ' -f2)" = 1.98.0
mkdir /work/openssl /work/export /work/export/lib
dpkg-deb -x /inputs/libssl-dev.deb /work/openssl
dpkg-deb -x /inputs/libssl3.deb /work/openssl
export OPENSSL_LIB_DIR=/work/openssl/usr/lib/x86_64-linux-gnu
export OPENSSL_INCLUDE_DIR=/work/openssl/usr/include
export OPENSSL_STATIC=0
export CFLAGS=-I/work/openssl/usr/include/x86_64-linux-gnu
export CPPFLAGS=-I/work/openssl/usr/include/x86_64-linux-gnu
export LD_LIBRARY_PATH=/work/openssl/usr/lib/x86_64-linux-gnu
cargo build --locked --offline --jobs 1 --target x86_64-unknown-linux-gnu --bin nitro-cli
cp target/x86_64-unknown-linux-gnu/debug/nitro-cli /work/export/nitro-cli.bin
ldd /work/export/nitro-cli.bin > /work/ldd.txt
! grep -q 'not found' /work/ldd.txt
awk '/=> \// { print $3 } /^[[:space:]]*\// { print $1 }' /work/ldd.txt > /work/libraries
echo /lib64/ld-linux-x86-64.so.2 >> /work/libraries
while IFS= read -r library; do cp -L "$library" /work/export/lib/; done < /work/libraries
'''

LAUNCHER = '''#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
test ! -L "$here/logs"
mkdir -p "$here/logs"
chmod 700 "$here/logs"
test -d "$here/logs" && test -w "$here/logs"
export NITRO_CLI_LOGS_PATH="$here/logs"
exec "$here/native/lib/ld-linux-x86-64.so.2" --inhibit-cache --library-path "$here/native/lib" "$here/native/nitro-cli.bin" "$@"
'''


def validate_elf(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    with path.open('rb') as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b'\x7fELF\x02\x01' and header[18:20] == b'\x3e\x00')


def validate_closure(output, lib):
    # Every resolved dependency must use the exported private closure. The
    # kernel vDSO and the explicitly executed loader are the only exceptions.
    resolved = []
    for line in output.decode().splitlines():
        stripped = line.strip()
        if re.fullmatch(r'linux-vdso\.so\.1 \(0x[0-9a-f]+\)', stripped):
            continue
        match = re.fullmatch(r'\S+ => (/[^ ]+) \(0x[0-9a-f]+\)', stripped)
        if match:
            path = Path(match[1])
            require(path.parent == lib and path.is_file() and not path.is_symlink())
            resolved.append(path.name)
            continue
        # glibc displays the interpreter's original name with its actual path.
        match = re.fullmatch(r'(/[^ ]+) \(0x[0-9a-f]+\)', stripped)
        require(match is not None and Path(match[1]) in (lib / 'ld-linux-x86-64.so.2', Path('/lib64/ld-linux-x86-64.so.2')))
    require(resolved and len(resolved) == len(set(resolved)))
    return sorted(resolved)


def bootstrap(runner, pins):
    phase('public-tools')
    require(pins.get('schema') == 'neoos/hosted-native-tools/v1' and HEX40.fullmatch(pins['aws_commit']))
    require(pins['rust_version'] == '1.98.0' and re.fullmatch(r'rust:1\.98-bookworm@sha256:[0-9a-f]{64}', pins['rust_image']))
    require(IMAGE.fullmatch(pins['rust_child']) and IMAGE.fullmatch(pins['rust_config']))
    require(len(pins['sources']) == 47 and len(pins['blobs']) == 6 and len(pins['openssl']) == 2)
    inputs = runner.root / 'tool-inputs'; inputs.mkdir()
    work = runner.root / 'tool-work'; work.mkdir()
    source = work / 'source'; source.mkdir()
    tools = runner.root / 'tools'; tools.mkdir()
    blobs = tools / 'blobs'; blobs.mkdir()
    deadline = time.monotonic() + 900
    paths = set()
    for kind in ('sources', 'blobs'):
        for record in pins[kind]:
            path = record['path']
            require(re.fullmatch(r'[A-Za-z0-9_./-]+', path) and not path.startswith('/') and not any(part in ('', '.', '..') for part in path.split('/')))
            require(path not in paths); paths.add(path)
            if kind == 'blobs':
                require(path in {'blobs/x86_64/' + name for name in ('bzImage', 'bzImage.config', 'cmdline', 'init', 'nsm.ko', 'linuxkit')})
            destination = source / path if kind == 'sources' else blobs / Path(path).name
            download('https://raw.githubusercontent.com/aws/aws-nitro-enclaves-cli/' + pins['aws_commit'] + '/' + path, record, destination, runner, deadline)
    (blobs / 'linuxkit').chmod(0o755)
    packages = set()
    for record in pins['openssl']:
        require(record['package'] in ('libssl3', 'libssl-dev') and record['package'] not in packages)
        packages.add(record['package'])
        require(record['architecture'] == 'amd64' and record['version'] == '3.0.22-1~deb12u1')
        require(record['url'] == 'https://security.debian.org/debian-security/pool/updates/main/o/openssl/' + record['package'] + '_' + record['version'] + '_amd64.deb')
        download(record['url'], record, inputs / (record['package'] + '.deb'), runner, deadline)
    runner.run([*runner.docker, 'pull', '--platform=linux/amd64', pins['rust_image']], timeout=600)
    details = parse(runner.run([*runner.docker, 'image', 'inspect', pins['rust_image']]))
    require(isinstance(details, list) and len(details) == 1)
    item = details[0]
    require(item.get('Os') == 'linux' and item.get('Architecture') == 'amd64' and item.get('Id') == pins['rust_config'])
    digests = item.get('RepoDigests', [])
    require(isinstance(digests, list) and any(value in ('rust@' + pins['rust_image'].split('@')[1], 'rust@' + pins['rust_child']) for value in digests))
    for name, command, network, timeout in (('tool-fetch', FETCH, 'bridge', 1200), ('tool-compile', COMPILE, 'none', 3600)):
        phase(name)
        owned_tool(runner, item['Id'], inputs, work, command, network, timeout)
        require(not runner.container_ids())
    shutil.copytree(work / 'export', tools / 'native')
    for path in (tools / 'native/lib').iterdir():
        validate_elf(path)
    validate_elf(tools / 'native/nitro-cli.bin')
    launcher = tools / 'nitro-cli'; launcher.write_text(LAUNCHER); launcher.chmod(0o755)
    phase('native-validation')
    lib = tools / 'native/lib'
    closure = validate_closure(runner.run([lib / 'ld-linux-x86-64.so.2', '--inhibit-cache', '--library-path', lib, '--list', tools / 'native/nitro-cli.bin'], tool='loader'), lib)
    require(runner.run([launcher, '--version'], tool='nitro').decode().strip() == 'Nitro CLI 1.5.2')
    hashes = {str(path.relative_to(tools)): file_sha(path) for path in sorted(tools.rglob('*')) if path.is_file()}
    shutil.rmtree(work); shutil.rmtree(inputs)
    runner.resources()
    return launcher, blobs, {'files': hashes, 'closure': closure, 'rust_image_id': item['Id'], 'rust_repo_digests': digests}


def check_host():
    release = Path('/etc/os-release').read_text()
    require(re.search(r'^ID=ubuntu$', release, re.M) is not None)
    require(re.search(r'^VERSION_ID="24\.04"$', release, re.M) is not None)
    memory = re.search(r'^MemTotal:\s+([0-9]+) kB$', Path('/proc/meminfo').read_text(), re.M)
    require(memory is not None and int(memory[1]) * 1024 >= 14 * 1024**3)
    require(stat.S_ISSOCK(Path('/var/run/docker.sock').stat().st_mode))
    return int(memory[1]) * 1024


def checked_artifacts(output):
    expected = {'enclave.eif', 'build-evidence.json', 'hosted-evidence.json', 'SHA256SUMS'}
    require(set(path.name for path in output.iterdir()) == expected)
    for name in expected:
        info = (output / name).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size > 0)
    require((output / 'SHA256SUMS').read_text() == ''.join(file_sha(output / name) + '  ' + name + '\n' for name in sorted(expected - {'SHA256SUMS'})))
    receipt = parse((output / 'hosted-evidence.json').read_bytes())
    require(receipt.get('schema') == 'neoos/hosted-measured-candidate/v1' and receipt.get('operational_admission') is False)
    require(not receipt['final']['containers'] and not receipt['final']['volumes'])


def api_version(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9]{1,2}\.[0-9]{1,2}', value) is not None)
    return tuple(int(part) for part in value.split('.'))


def docker_compatibility(runner):
    # Run the unchanged compatibility gates before downloading/compiling tools.
    # Parse failures expose only fixed enums, never response or exception text.
    phase('docker-api')
    raw = runner.run([*runner.docker, 'version', '--format', '{{json .Server}}'])
    try:
        version = parse(raw)
        minimum = api_version(version.get('MinAPIVersion'))
        maximum = api_version(version.get('ApiVersion'))
    except (ValueError, TypeError, AttributeError):
        raise Refused('docker_api_response') from None
    require(minimum <= (1, 49) <= maximum, 'docker_api_range')
    phase('buildx')
    raw = runner.run([*runner.docker, 'buildx', 'version'])
    try:
        buildx = raw.decode().strip()
    except UnicodeError:
        raise Refused('buildx_response') from None
    require(re.fullmatch(r'github\.com/docker/buildx v[0-9.]+(?:-[A-Za-z0-9.-]+)? [A-Za-z0-9]+', buildx), 'buildx_format')
    return version, buildx


def post_bootstrap_inventory(runner, initial, native):
    phase('post-bootstrap-inventory')
    try:
        baseline = runner.inventory()
    except Refused as error:
        # Preserve command/resource/timeout failures and their primary status.
        if str(error) != 'validation':
            raise
        raise Refused('inventory_response') from None
    except (ValueError, TypeError):
        raise Refused('inventory_response') from None
    require(not baseline['containers'], 'baseline_containers')
    require(not baseline['volumes'], 'baseline_volumes')
    # Tool setup may add only its pinned Rust image, never unexplained objects.
    require(set(baseline['images']) <= set(initial['images']) | {native['rust_image_id']}, 'baseline_images')
    return baseline


def canonical_origin(runner, repo):
    git = ['git', '--no-replace-objects', '-C', repo]
    original = runner.run([*git, 'remote', 'get-url', 'origin'], tool='git').decode().strip()
    require(original in (ORIGIN, ORIGIN.removesuffix('.git')))
    if original != ORIGIN:
        # Pinned checkout uses the suffixless canonical URL. The unchanged
        # business builder requires .git. Change only this local checkout's
        # remote config, after exact-pair validation, then read it back.
        runner.run([*git, 'remote', 'set-url', 'origin', ORIGIN], tool='git')
    require(runner.run([*git, 'remote', 'get-url', 'origin'], tool='git').decode().strip() == ORIGIN)
    return original


def execute(root, env):
    phase('admission')
    source = admission(env)
    files = decode_bundle(env.get('PUBLIC_BUNDLE_BASE64', ''), env['PUBLIC_BUNDLE_SHA256'])
    memory = check_host()
    runner = Runner(root)
    runner.resources()
    info = parse(runner.run([*runner.docker, 'info', '--format', '{{json .}}']))
    docker_root = info.get('DockerRootDir', '')
    require(isinstance(docker_root, str) and docker_root.startswith('/'))
    runner.paths.append(Path(docker_root))
    runner.resources()
    initial = runner.inventory()
    require(not initial['containers'] and not initial['volumes'])
    phase('source')
    git = ['git', '--no-replace-objects', '-C', ROOT]
    require(runner.run([*git, 'rev-parse', 'HEAD'], tool='git').decode().strip() == source)
    require(not runner.run([*git, 'status', '--porcelain', '--untracked-files=all'], tool='git'))
    checkout_origin = canonical_origin(runner, ROOT)
    require(runner.run([*git, 'ls-remote', '--exit-code', ORIGIN, 'refs/heads/main'], tool='git').decode() == source + '\trefs/heads/main\n')
    builder = load_builder(ROOT)
    input_path = stage_bundle(files, root / 'public', source, ROOT, builder)
    docker_install = hosted_docker_install.install(sys.modules[__name__], runner)
    version, buildx = docker_compatibility(runner)
    pins_path = ROOT / 'deploy/nitro/hosted-native-tools.json'
    pins = parse(pins_path.read_bytes())
    launcher, blobs, native = bootstrap(runner, pins)
    baseline = post_bootstrap_inventory(runner, initial, native)
    output = root / 'candidate'
    phase('business-build')
    runner.run([sys.executable, '-B', ROOT / 'deploy/nitro/build-dual-enclave.py', 'build',
                '--repo', ROOT, '--input', input_path, '--input-sha256', file_sha(input_path),
                '--output', output, '--docker', '/usr/bin/docker', '--nitro-cli', launcher,
                '--nitro-blobs', blobs], timeout=11500, tool='python', observe=True, business_diagnostic=True)
    evidence = validate_candidate(output, source, file_sha(input_path), builder)
    phase('final-readback')
    final = final_daemon_check(runner, baseline, evidence['builds'])
    bk = next(item for item in runner.observed.values() if item['kind'] == 'buildkit')
    inspection = parse(runner.run([*runner.docker, 'image', 'inspect', bk['image_id']]))
    require(isinstance(inspection, list) and len(inspection) == 1 and inspection[0].get('Id') == bk['image_id'])
    image = inspection[0]
    require(image.get('Os') == 'linux' and image.get('Architecture') == 'amd64')
    # Actual default identity is recorded, not substituted with an ARM pin or
    # represented as a fully pinned/reproducible BuildKit toolchain.
    labels = image.get('Config', {}).get('Labels') or {}
    version_labels = {key: labels[key] for key in ('org.opencontainers.image.version', 'org.opencontainers.image.revision') if key in labels}
    require(all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9._+/-]{1,128}', value) for value in version_labels.values()))
    repo_digests = image.get('RepoDigests') or []
    require(isinstance(repo_digests, list) and all(isinstance(value, str) and re.fullmatch(r'[a-z0-9./_-]+@sha256:[0-9a-f]{64}', value) for value in repo_digests))
    require(final_daemon_check(runner, baseline, evidence['builds']) == final)
    phase('publication')
    write_json(output / 'hosted-evidence.json', {
        'schema': 'neoos/hosted-measured-candidate/v1', 'source_sha': source,
        'workflow_sha': env['GITHUB_WORKFLOW_SHA'], 'checkout_origin': checkout_origin,
        'run_id': env['GITHUB_RUN_ID'], 'run_attempt': env['GITHUB_RUN_ATTEMPT'],
        'public_bundle_sha256': env['PUBLIC_BUNDLE_SHA256'], 'reviewed_input_sha256': file_sha(input_path),
        'driver_sha256': file_sha(Path(__file__)), 'workflow_sha256': file_sha(ROOT / '.github/workflows/measured-candidate.yml'),
        'tools_manifest_sha256': file_sha(pins_path), 'native': native,
        'docker_install': docker_install, 'docker_sha256': file_sha(Path('/usr/bin/docker')), 'docker_api': {'minimum': version['MinAPIVersion'], 'maximum': version['ApiVersion']},
        'buildx_version': buildx, 'memory_bytes': memory, 'minimum_resources': runner.minimum,
        'initial': initial, 'baseline': baseline, 'containers': list(runner.observed.values()),
        'observed_image_ids': sorted(runner.observed_images), 'final': final,
        'buildkit': {'image_id': bk['image_id'], 'repo_digests': repo_digests, 'version_labels': version_labels,
                     'limitation': 'Unpinned stock-builder default; observation is not a complete reproducibility pin.'},
        'operational_admission': False,
    })
    (output / 'SHA256SUMS').write_text(''.join(file_sha(output / name) + '  ' + name + '\n' for name in ('build-evidence.json', 'enclave.eif', 'hosted-evidence.json')))
    checked_artifacts(output)
    require(final_daemon_check(runner, baseline, evidence['builds']) == final)
    runner.resources()
    return output


def main():
    phase('admission')
    try:
        admission(os.environ)
        parent = Path(os.environ['RUNNER_TEMP'])
        require(parent.is_absolute() and parent.is_dir() and parent.resolve() == parent)
        require(ROOT != parent and ROOT not in parent.parents)
        root = Path(tempfile.mkdtemp(prefix='neoos-hosted-', dir=parent))
        def interrupted(_signal, _frame):
            raise InterruptedError()
        signal.signal(signal.SIGTERM, interrupted)
        output = execute(root, os.environ)
        # No output key exists on failure/cancellation. The upload step also
        # requires Actions success; a Python finally is not daemon cleanup proof.
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write('path=' + str(output) + '\nverified=true\n')
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps(failure_receipt(error, os.environ), sort_keys=True), file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

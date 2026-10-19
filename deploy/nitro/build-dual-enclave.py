#!/usr/bin/env python3
"""Public-only dual-image staging and measured, canonical-source EIF build.

`prepare` writes a reviewable context, never an EIF/release certificate.
`build` additionally requires fresh canonical provenance and two measured builds.
No process environment is configuration. See README.dual-image.md.
"""
import argparse
from contextlib import contextmanager
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import uuid
from urllib.parse import urlsplit

def cross_support():
    # Default packaging remains independently loadable; cross support is opt-in.
    import importlib.util
    spec = importlib.util.spec_from_file_location('dual_cross', Path(__file__).resolve().with_name('dual_cross.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cross_inputs(files, cache):
    return cross_support().cross_inputs(files, cache)


def native_linuxkit_bundle(native, blobs, output):
    return cross_support().native_linuxkit_bundle(native, blobs, output)

NETWORKS = ('mainnet', 'testnet')
ROLES = ('ORACLE_VERIFIER', 'UPDATER', 'RELAYER', 'WORKER', 'NEOX_UPDATER', 'NEOX_VERIFIER')
ORIGIN = 'https://github.com/r3e-network/neo-os-services.git'
EPOCH = 1749859200
LIMIT = 65536
SCHEMA = 'neoos/dual-image-input/v1'
SOURCE_DIRS = ('vendor/', 'crates/', 'workers/neo-signer/', 'workers/nitro-enclave-host/', 'workers/neo-os-relayer/')
PROFILE_FIELDS = ('profile_version vault_id environment networks custody_kms_key_arn root_key_version root_key_commitment snapshot_format_version signer_schema_version coordinator release_policy_version').split()

DIAGNOSTIC_STAGES = frozenset(('admission', 'staging', 'canonical', 'buildkit-create',
    'image-build', 'image-inspect', 'image-export', 'image-verify', 'enclave-build',
    'enclave-describe', 'measurements', 'cleanup', 'publication', 'unknown'))
DIAGNOSTIC = {}


def reset_diagnostics():
    DIAGNOSTIC.clear()
    DIAGNOSTIC.update(stage='admission', attempt=0, primary=None, cleanup_failed=False)


def diagnostic_stage(stage, attempt=None):
    # Static call-site labels only, never argument values or exception text.
    DIAGNOSTIC['stage'] = stage if stage in DIAGNOSTIC_STAGES else 'unknown'
    if attempt is not None:
        DIAGNOSTIC['attempt'] = attempt if type(attempt) is int and attempt in (0, 1, 2) else 0


def record_failure(kind, exit_code=None, captured=b''):
    if DIAGNOSTIC.get('primary') is not None:
        return
    text = captured[-524288:].decode('utf-8', errors='replace')
    codes = sorted(set(re.findall(r'\berror\[(E[0-9]{4})\]', text)))[:16]
    hints = []
    # Hints describe matching output patterns, not verified root causes. Only
    # these fixed tokens can leave the process; no captured text is serialized.
    for name, pattern in (
        ('rust-compile', r'\berror\[E[0-9]{4}\]'),
        ('cargo-resolution', r'failed to select a version|failed to resolve patches'),
        ('disk-full', r'No space left on device'),
        ('memory-exhaustion', r'out of memory|memory allocation of [0-9]+ bytes failed'),
        ('network', r'Could not resolve host|Temporary failure in name resolution|failed to download'),
        ('package-unavailable', r'Unable to locate package|Version [^\r\n]{1,256} for [^\r\n]{1,256} was not found'),
    ):
        if re.search(pattern, text):
            hints.append(name)
    DIAGNOSTIC['primary'] = {
        'stage': DIAGNOSTIC.get('stage', 'unknown'), 'attempt': DIAGNOSTIC.get('attempt', 0),
        'kind': kind if kind in ('validation', 'command_failed', 'timeout', 'os_error', 'interrupted', 'unknown') else 'unknown',
        'exit_code': exit_code if type(exit_code) is int and -128 <= exit_code <= 255 else None,
        'error_codes': codes, 'hints': sorted(hints),
    }


def failure_diagnostic(error):
    kind = ('timeout' if isinstance(error, (subprocess.TimeoutExpired, TimeoutError)) else
            'interrupted' if isinstance(error, (KeyboardInterrupt, InterruptedError)) else
            'os_error' if isinstance(error, OSError) else
            'validation' if isinstance(error, (ValueError, KeyError, TypeError)) else 'unknown')
    record_failure(kind)
    return {'schema': 'neoos/dual-build-failure/v1', 'primary': dict(DIAGNOSTIC['primary']),
            'cleanup_failed': DIAGNOSTIC['cleanup_failed']}


reset_diagnostics()


def require(condition, message):
    if not condition:
        record_failure('validation')
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON field')
        result[key] = value
    return result


def parse(data):
    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: require(False, 'invalid JSON number'))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError('invalid public JSON') from error


def fields(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), 'unexpected or missing public fields')


def regular(path):
    # Reject links anywhere in an input path, not just its final component.
    path = Path(os.path.abspath(path))
    for parent in (path, *path.parents):
        require(not parent.is_symlink(), 'symlink input refused')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= LIMIT, 'public input must be a bounded regular file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(LIMIT + 1)
        require(len(data) <= LIMIT, 'public input exceeds limit')
        return data
    finally:
        os.close(fd)


def token(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', value), 'invalid public identifier')
    return value


def role_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value), 'invalid custody role ID')
    return value


def digest(value, length=64):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{%d}' % length, value) and set(value) != {'0'}, 'invalid digest/identity')
    return value


def public_url(value, origin=False):
    require(isinstance(value, str) and len(value) <= 512, 'invalid public URL')
    u = urlsplit(value)
    host = u.hostname or ''
    require(re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host) and '.' in host, 'public URL requires DNS hostname')
    require(all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.')), 'invalid DNS labels')
    require(not host.replace('.', '').isdigit() and not host.endswith(('.localhost', '.local', '.internal')), 'nonpublic hostname')
    require(value.startswith('https://') and u.scheme == 'https' and u.netloc == host and not u.query and not u.fragment, 'public URL must be canonical HTTPS without credentials, port, query or fragment')
    require(not any(c in value for c in ('%', '\\', '$', '"', "'", '\n', '\r', ' ')), 'ambiguous public URL')
    require(all(s not in ('.', '..') for s in u.path.split('/')) and '//' not in u.path, 'noncanonical public path')
    require(not origin or u.path == '', 'public audience/authority must be an origin')
    return value


def kms(value, region):
    require(isinstance(value, str) and re.fullmatch(r'arn:aws:kms:' + re.escape(region) + r':[0-9]{12}:key/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value), 'explicit KMS key ARN required')
    return value


def public_inputs(path, expected_sha, registry):
    raw = regular(path)
    require(sha(raw) == digest(expected_sha), 'reviewed input SHA mismatch')
    value = parse(raw)
    fields(value, ('schema', 'release', 'source_commit', 'networks'))
    require(value['schema'] == SCHEMA, 'unknown input schema')
    token(value['release'])
    digest(value['source_commit'], 40)
    fields(value['networks'], NETWORKS)
    profiles, overlays = {}, {}
    role_ids = set()
    distinct = {k: set() for k in ('vault_id', 'root_key_commitment', 'audience', 'origin', 'snapshot')}
    for network in NETWORKS:
        spec = value['networks'][network]
        spec_fields = ('profile_file', 'profile_sha256', 'workload_audience', 'roles', 'neo_n3_rpc', 'neo_x_rpc', 'frontier_kms_key_arn', 'aws_region')
        fields(spec, spec_fields + (('enrollment',) if 'enrollment' in spec else ()))
        require(spec['profile_file'] == network + '.json', 'profile file must be its network basename')
        data = regular(Path(path).parent / spec['profile_file'])
        require(sha(data) == digest(spec['profile_sha256']), 'profile file SHA mismatch')
        profile = parse(data)
        fields(profile, PROFILE_FIELDS)
        require(profile['environment'] == network, 'profile network mismatch')
        require(profile['profile_version'] == 1 and profile['snapshot_format_version'] == 2 and profile['signer_schema_version'] == 1, 'profile version mismatch')
        digest(profile['vault_id'], 32)
        digest(profile['root_key_commitment'])
        token(profile['root_key_version']); token(profile['release_policy_version'])
        bindings = profile['networks']
        require(isinstance(bindings, list) and len(bindings) == 2, 'combined image requires both public chain families per vault')
        for binding, family, section, id_key in zip(bindings, ('neo-n3', 'neox'), ('neo_n3', 'neo_x'), ('network_magic', 'chain_id')):
            fields(binding, ('chain_family', 'chain_id', 'genesis_hash'))
            require(binding['chain_family'] == family and type(binding['chain_id']) is int and binding['chain_id'] == registry[network][section][id_key], 'profile chain binding mismatch')
            require(isinstance(binding['genesis_hash'], str) and binding['genesis_hash'].startswith('0x'), 'invalid genesis hash')
            digest(binding['genesis_hash'][2:])
            known_genesis = registry[network][section].get('genesis_hash')
            require(not known_genesis or binding['genesis_hash'] == known_genesis, 'profile differs from reviewed genesis')
        coordinator = profile['coordinator']
        fields(coordinator, ('origin', 'aws_region', 'snapshot_bucket', 'snapshot_prefix', 'receipt_keys'))
        public_url(coordinator['origin'], origin=True)
        region = spec['aws_region']
        require(isinstance(region, str) and re.fullmatch(r'[a-z]{2}-[a-z]+-[1-9]', region) and coordinator['aws_region'] == region, 'AWS region mismatch')
        kms(profile['custody_kms_key_arn'], region); kms(spec['frontier_kms_key_arn'], region)
        require(re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', coordinator['snapshot_bucket']) is not None, 'invalid snapshot bucket')
        prefix = coordinator['snapshot_prefix']
        require(isinstance(prefix, str) and all(re.fullmatch(r'[A-Za-z0-9_-]+', s) for s in prefix.split('/')), 'invalid snapshot namespace')
        receipts = coordinator['receipt_keys']
        require(isinstance(receipts, list) and 1 <= len(receipts) <= 4, 'invalid receipt key set')
        ids = set()
        for receipt in receipts:
            fields(receipt, ('key_id', 'public_key_sec1_hex'))
            require(token(receipt['key_id']) not in ids, 'duplicate receipt key')
            ids.add(receipt['key_id'])
            key = receipt['public_key_sec1_hex']
            require(isinstance(key, str) and re.fullmatch(r'04[0-9a-f]{128}', key), 'invalid receipt public key encoding')
        audience = public_url(spec['workload_audience'], origin=True)
        for key, identity in (('vault_id', profile['vault_id']), ('root_key_commitment', profile['root_key_commitment']), ('audience', audience), ('origin', coordinator['origin']), ('snapshot', coordinator['snapshot_bucket'] + '/' + prefix)):
            require(identity not in distinct[key], 'networks share ' + key)
            distinct[key].add(identity)
        fields(spec['roles'], ROLES)
        role_values = [role_id(spec['roles'][role]) for role in ROLES]
        require(len(set(role_values)) == len(ROLES) and not role_ids.intersection(role_values), 'roles require distinct reviewed key identities')
        role_ids.update(role_values)
        overlay = {
            'MORPHEUS_NETWORK': network,
            'MORPHEUS_CUSTODY_PROFILE_FILE': '/app/config/custody/' + network + '.json',
            'MORPHEUS_CUSTODY_PROFILE_SHA256': sha(data),
            'MORPHEUS_CUSTODY_DATA_DIR': '/var/lib/neoos-custody/' + network,
            'MORPHEUS_CUSTODY_WORKLOAD_AUDIENCE': audience,
            'SIGNER_SERVICE_URL': 'http://127.0.0.1:0/' + network,
            'NEO_RPC_URL': public_url(spec['neo_n3_rpc']),
            'NEOX_RPC_URL': public_url(spec['neo_x_rpc']),
            'NEOX_RPC': spec['neo_x_rpc'],
            'EVM_RPC_URL': spec['neo_x_rpc'],
            'AWS_REGION': region,
            'FRONTIER_KMS_KEY_ARN': spec['frontier_kms_key_arn'],
        }
        if 'enrollment' in spec:
            enrollment = spec['enrollment']
            fields(enrollment, ('mode', 'manifest_file', 'manifest_sha256'))
            require(network == 'testnet' and enrollment['mode'] == 'first-testnet-admin/v1', 'enrollment requires explicit TestNet opt-in')
            require(enrollment['manifest_file'] == 'testnet-enrollment.json', 'enrollment file must use fixed basename')
            manifest = regular(Path(path).parent / enrollment['manifest_file'])
            require(len(manifest) <= 16384, 'enrollment manifest exceeds bound')
            require(sha(manifest) == digest(enrollment['manifest_sha256']) == profile['release_policy_version'], 'enrollment manifest/profile digest mismatch')
            # Authoritative semantic validation is also performed by dual_prepare
            # against these exact staged bytes in both image recipes.
            validate_enrollment(parse(manifest), profile)
            profiles['testnet-enrollment'] = manifest
            overlay.update({
                'MORPHEUS_CUSTODY_ENROLLMENT_MODE': enrollment['mode'],
                'MORPHEUS_CUSTODY_ENROLLMENT_FILE': '/app/config/custody/testnet-enrollment.json',
                'MORPHEUS_CUSTODY_ENROLLMENT_SHA256': sha(manifest),
            })
        overlay.update({'SIGNER_ROLE_' + role + '_KEY_ID': spec['roles'][role] for role in ROLES})
        profiles[network], overlays[network] = data, overlay
    return value, profiles, overlays


def validate_enrollment(manifest, profile):
    destination = ('environment', 'vault_id', 'networks', 'custody_kms_key_arn', 'root_key_version', 'root_key_commitment', 'coordinator')
    fields(manifest, ('schema', 'purpose', 'ceremony_id', 'caller') + destination)
    require(manifest['schema'] == 'neoos/first-admin-enrollment/v1' and manifest['purpose'] == 'first-testnet-admin/v1', 'invalid enrollment contract')
    require(all(manifest[k] == profile[k] for k in destination) and manifest['environment'] == 'testnet', 'enrollment destination mismatch')
    role_id(manifest['ceremony_id'])
    caller = manifest['caller']
    fields(caller, ('id', 'label', 'created_at_unix', 'token_digest', 'auth_mode', 'capabilities', 'key_grant', 'allowed_origins', 'disabled'))
    role_id(caller['id']); digest(caller['token_digest'])
    label = caller['label']
    require(isinstance(label, str) and 0 < len(label.encode()) <= 128 and label.strip() == label and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in label), 'invalid enrollment label')
    require(type(caller['created_at_unix']) is int and 0 < caller['created_at_unix'] <= 2**63-1, 'invalid enrollment time')
    require(caller['auth_mode'] == 'bearer' and caller['capabilities'] == ['admin'] and caller['key_grant'] == 'any' and caller['allowed_origins'] == [] and caller['disabled'] is False, 'enrollment must be enabled bearer Admin only')


OUTPUT_LIMIT = 256 * 1024 * 1024


def diagnostic_tail(stream):
    # Read only a bounded tail from each disk-backed stream, including when a
    # child produced hundreds of MiB. Capture errors must not replace its exit.
    try:
        stream.seek(max(0, os.fstat(stream.fileno()).st_size - 262144))
        return stream.read(262144)
    except (OSError, ValueError):
        return b''


def child_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    for kind, cap in ((resource.RLIMIT_NOFILE, 512), (resource.RLIMIT_FSIZE, 2 * 1024 ** 3)):
        _, hard = resource.getrlimit(kind)
        limit = min(cap, hard) if hard != resource.RLIM_INFINITY else cap
        resource.setrlimit(kind, (limit, limit))


def stop_group(process):
    # Every command owns a new session. Signal the group even if its leader exited.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def run(args, env, cwd=None, timeout=120):
    # Disk-backed bounded capture avoids pipe deadlocks and unbounded RAM use.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen([str(a) for a in args], env=env, cwd=cwd,
                                   stdout=stdout, stderr=stderr, start_new_session=True,
                                   preexec_fn=child_limits)
        deadline = time.monotonic() + timeout
        try:
            while True:
                require(os.fstat(stdout.fileno()).st_size + os.fstat(stderr.fileno()).st_size <= OUTPUT_LIMIT, 'command output limit exceeded')
                if process.poll() is not None:
                    break
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(str(args[0]), timeout)
                time.sleep(0.02)
            if process.returncode != 0:
                record_failure('command_failed', process.returncode,
                               diagnostic_tail(stdout) + diagnostic_tail(stderr))
            require(process.returncode == 0, 'command failed: ' + Path(str(args[0])).name)
            stdout.seek(0)
            return stdout.read(OUTPUT_LIMIT + 1)
        except BaseException as error:
            failure_diagnostic(error)
            raise
        finally:
            stop_group(process)


def safe_env(home):
    return {'PATH': '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(home), 'DOCKER_CONFIG': str(home / 'docker'), 'LANG': 'C', 'LC_ALL': 'C', 'SOURCE_DATE_EPOCH': str(EPOCH), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_GRAFT_FILE': os.devnull}


def git(repo, env, *args):
    return run(['git', '--no-replace-objects', '-C', repo, *args],
               {**env, 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_GRAFT_FILE': os.devnull})


@contextmanager
def object_repository(repo, env):
    # Read only the object store through alternates. Do not inherit refs, grafts,
    # info/attributes, hooks, remotes, replace refs or local URL rewrite config.
    common = Path(git(repo, env, 'rev-parse', '--git-common-dir').decode().strip())
    objects = ((repo / common) if not common.is_absolute() else common).resolve() / 'objects'
    require(objects.is_dir() and '\n' not in str(objects), 'invalid object store')
    with tempfile.TemporaryDirectory(prefix='dual-objects-') as directory:
        isolated = Path(directory).resolve()
        git(isolated, env, 'init', '--bare', '--quiet', '--template=')
        (isolated / 'objects/info/alternates').write_text(str(objects) + '\n')
        yield isolated


def wanted_source(name):
    return name in ('Cargo.toml', 'Cargo.lock', 'config/networks/mainnet.json', 'config/networks/testnet.json', 'deploy/nitro/Dockerfile.dual-enclave', 'deploy/nitro/dual-prepare.rs', 'deploy/nitro/Dockerfile.dual-enclave.cross', 'deploy/nitro/cross-inputs.lock.json', 'deploy/nitro/dual_cross.py') or name.startswith(SOURCE_DIRS)


class Publication:
    """Write through pinned directory descriptors; publish once with no replacement."""
    def __init__(self, repo, output):
        self.output = Path(output).absolute()
        require('..' not in self.output.parts, 'output parent traversal refused')
        require(repo.resolve() not in self.output.parents and repo.resolve() != self.output, 'output must be outside source tree')
        self.parent = self.output.parent
        self.parent_fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in self.parent.parts[1:]:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent_fd)
                os.close(self.parent_fd)
                self.parent_fd = fd
            try:
                os.stat(self.output.name, dir_fd=self.parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise FileExistsError('output already exists')
            self.name = '.dual-publish-' + uuid.uuid4().hex
            os.mkdir(self.name, mode=0o700, dir_fd=self.parent_fd)
            self.fd = os.open(self.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent_fd)
            self.published = False
        except BaseException:
            os.close(self.parent_fd)
            raise

    def write(self, name, blocks):
        parts = PurePosixPath(name).parts
        require(parts and not name.startswith('/') and all(p not in ('.', '..') for p in parts), 'invalid output member')
        parent = os.dup(self.fd)
        try:
            for part in parts[:-1]:
                try:
                    os.mkdir(part, mode=0o755, dir_fd=parent)
                    os.fsync(parent)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = child
            fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
            hasher = hashlib.sha256()
            try:
                for block in blocks:
                    hasher.update(block)
                    remaining = memoryview(block)
                    while remaining:
                        count = os.write(fd, remaining)
                        require(count > 0, 'short publication write')
                        remaining = remaining[count:]
                os.utime(fd, (EPOCH, EPOCH))
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(parent)
            return hasher.hexdigest()
        finally:
            os.close(parent)

    def publish(self):
        # Revalidate the path, while writes and rename use the original handle.
        current = os.stat(self.parent, follow_symlinks=False)
        pinned = os.fstat(self.parent_fd)
        require(stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino), 'output parent changed')
        require(self.parent.resolve() == self.parent, 'output parent alias changed')
        os.fsync(self.fd)
        libc = ctypes.CDLL(None, use_errno=True)
        if hasattr(libc, 'renameat2'):
            rename, flags = libc.renameat2, 1  # Linux RENAME_NOREPLACE
        elif hasattr(libc, 'renameatx_np'):
            rename, flags = libc.renameatx_np, 4  # macOS RENAME_EXCL
        else:
            raise ValueError('atomic no-replace publication unavailable')
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(self.parent_fd, os.fsencode(self.name), self.parent_fd, os.fsencode(self.output.name), flags):
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        self.published = True
        os.fsync(self.parent_fd)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            if not self.published:
                self.remove_contents(self.fd)
                os.rmdir(self.name, dir_fd=self.parent_fd)
        finally:
            os.close(self.fd)
            os.close(self.parent_fd)

    @staticmethod
    def remove_contents(fd):
        for name in os.listdir(fd):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    Publication.remove_contents(child)
                finally:
                    os.close(child)
                os.rmdir(name, dir_fd=fd)
            else:
                os.unlink(name, dir_fd=fd)


def source(repo, commit, env):
    require(git(repo, env, 'rev-parse', 'HEAD').decode().strip() == commit, 'source HEAD differs from reviewed commit')
    require(not git(repo, env, 'status', '--porcelain=v1', '--untracked-files=all'), 'source must be clean, including untracked files')
    with object_repository(repo, env) as isolated:
        archive = git(isolated, env, 'archive', '--format=tar', commit)
        tree = git(isolated, env, 'ls-tree', '-r', '-z', commit)
    expected = {}
    for record in tree.split(b'\0'):
        if not record:
            continue
        metadata, raw_name = record.split(b'\t', 1)
        name = raw_name.decode()
        if wanted_source(name):
            mode, kind, oid = metadata.decode().split()
            require(kind == 'blob' and mode in ('100644', '100755'), 'nonregular source object')
            expected[name] = oid
    selected = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        for entry in stream:
            name = entry.name
            wanted = wanted_source(name)
            if not wanted or entry.isdir():
                continue
            parts = PurePosixPath(name).parts
            require(entry.isfile() and not name.startswith('/') and '..' not in parts, 'nonregular source input')
            require(not any(p.startswith('.env') or p.lower() in ('secrets', '.secrets', 'snapshots', 'keys', '.git', 'target', 'node_modules') for p in parts) and Path(name).suffix.lower() not in ('.pem', '.key', '.p12', '.db', '.sqlite'), 'private/state file in build source')
            data = stream.extractfile(entry).read()
            oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            require(name not in selected and expected.get(name) == oid, 'archive differs from reviewed object tree')
            selected[name] = data
    require(set(selected) == set(expected), 'archive omitted reviewed source')
    for name in ('Cargo.toml', 'Cargo.lock', 'deploy/nitro/Dockerfile.dual-enclave', 'deploy/nitro/dual-prepare.rs'):
        require(name in selected, 'missing build source')
    return selected, sha(archive)


def stage(repo, input_path, input_sha, destination, env, builder_platform="linux/amd64", cross_cache=None):
    with Publication(repo, destination) as publication:
        return stage_into(repo, input_path, input_sha, env, publication, builder_platform, cross_cache)


def stage_into(repo, input_path, input_sha, env, publication, builder_platform="linux/amd64", cross_cache=None):
    require(builder_platform in ("linux/amd64", "linux/arm64"), "unsupported builder platform")
    require(builder_platform == "linux/arm64" or cross_cache is None, "cross cache requires native builder")
    # Read reviewed commit first; duplicate/unrecognized fields are checked below.
    raw = regular(input_path)
    require(sha(raw) == digest(input_sha), 'reviewed input SHA mismatch')
    initial = parse(raw)
    fields(initial, ('schema', 'release', 'source_commit', 'networks'))
    commit = digest(initial['source_commit'], 40)
    files, archive_sha = source(repo, commit, env)
    registry = {n: parse(files['config/networks/' + n + '.json']) for n in NETWORKS}
    spec, profiles, overlays = public_inputs(input_path, input_sha, registry)
    require(spec['source_commit'] == commit, 'input changed during preparation')
    map_bytes = encoded(overlays)
    recipe = 'deploy/nitro/Dockerfile.dual-enclave'
    if builder_platform == 'linux/arm64':
        files.update(cross_inputs(files, cross_cache))
        recipe += '.cross'
    template = files[recipe].decode()
    marker = '# DUAL_NETWORK_ENV'
    require(template.count(marker) == 1, 'dual Dockerfile marker missing/ambiguous')
    # JSON double quoting is Docker ENV escaping; values are ASCII and cannot
    # carry expansion, newlines, comments or build instructions.
    env_line = 'ENV MORPHEUS_NETWORK_PROFILES_JSON=' + json.dumps(map_bytes.decode().strip())
    files['Dockerfile'] = template.replace(marker, env_line).encode()
    files['public/network-profiles.json'] = map_bytes
    for n, data in profiles.items():
        files['public/custody/' + n + '.json'] = data
    # Docker injects /etc/hosts and /etc/hostname into the container nitro-cli
    # flattens, so without a byte-identical copy inside the image every rebuild
    # produces different PCR0/PCR2. These two files are fixed, public and carry
    # no host identity; the runtime mount still replaces them at container start.
    files['public/etc/hosts'] = b'127.0.0.1 localhost\n'
    files['public/etc/hostname'] = b'neoos-enclave\n'
    manifest = {'schema': 'neoos/dual-image-context/v1', 'release': spec['release'], 'git_commit': commit, 'source_archive_sha256': archive_sha, 'reviewed_input_sha256': input_sha, 'map_sha256': sha(map_bytes), 'networks': list(NETWORKS), 'files': {n: sha(b) for n, b in sorted(files.items())}, 'status': 'context-only; authoritative Rust validation and measured builds required'}
    if builder_platform == 'linux/arm64':
        manifest['builder_platform'] = builder_platform
        manifest['cross_lock_sha256'] = sha(files['deploy/nitro/cross-inputs.lock.json'])
    for name, data in files.items():
        publication.write(name, (data,))
    publication.write('context-manifest.json', (encoded(manifest),))
    publication.publish()
    return manifest


def canonical(repo, commit, env):
    require(git(repo, env, 'remote', 'get-url', 'origin').decode().strip() == ORIGIN, 'canonical origin required')
    # A stale or invented tracking ref is not publication evidence.
    with object_repository(repo, env) as isolated:
        lines = git(isolated, env, 'ls-remote', '--exit-code', ORIGIN, 'refs/heads/main').decode().splitlines()
        require(len(lines) == 1 and lines[0].endswith('\trefs/heads/main'), 'canonical main unavailable')
        tip = digest(lines[0].split()[0], 40)
        git(isolated, env, 'merge-base', '--is-ancestor', commit, tip)
    return tip


def measurements(data):
    value = parse(data)
    m = value.get('Measurements', {})
    # nitro-cli 1.4 reports `Sha384 { ... }`; 1.5 renamed the same 48-byte
    # measurement enum to `Sha512_48 { .. }`. These exact labels are accepted
    # from the trusted CLI; validating 96 hex characters checks PCR shape,
    # not cryptographic algorithm identity.
    require(m.get('HashAlgorithm') in ('Sha384 { ... }', 'SHA384', 'Sha512_48 { .. }', 'SHA512_48'), 'unsupported measurement hash')
    # Normalize the CLI's historical Debug name only; never substitute PCRs.
    return {k: digest(m.get(k), 96) for k in ('PCR0', 'PCR1', 'PCR2')}


def build(repo, context, manifest, output, env, docker, nitro, blobs):
    with Publication(repo, output) as publication:
        return build_into(repo, context, manifest, env, docker, nitro, blobs, publication)


CONTAINER_OWNER_LABEL = 'org.neoos.dual-image-owner'


def owned_container(docker_args, env, reservation):
    name, owner, image_id = reservation
    # Listing distinguishes absence from a failed inspect/daemon connection.
    # Docker's name filter can match substrings: inspect must match exactly.
    ids = run([*docker_args, 'container', 'ls', '--all', '--no-trunc',
               '--filter', 'name=' + name, '--format', '{{.ID}}'], env, timeout=30).decode().splitlines()
    if not ids:
        return None
    require(len(ids) == 1 and re.fullmatch('[0-9a-f]{64}', ids[0]), 'ambiguous container identity')
    details = parse(run([*docker_args, 'container', 'inspect', ids[0]], env, timeout=30))
    require(isinstance(details, list) and len(details) == 1 and isinstance(details[0], dict), 'invalid container inspection')
    item = details[0]
    config = item.get('Config')
    require(isinstance(config, dict) and isinstance(config.get('Labels'), dict), 'missing container ownership')
    require(item.get('Id') == ids[0] and item.get('Name') == '/' + name and item.get('Image') == image_id,
            'container identity mismatch')
    require(config['Labels'].get(CONTAINER_OWNER_LABEL) == owner, 'foreign container ownership')
    return ids[0]


def build_into(repo, context, manifest, env, docker, nitro, blobs, publication):
    diagnostic_stage('canonical')
    tip = canonical(repo, manifest['git_commit'], env)
    env = {**env, 'NITRO_CLI_BLOBS': str(blobs), 'NITRO_CLI_ARTIFACTS': str(context.parent / 'nitro-artifacts')}
    Path(env['NITRO_CLI_ARTIFACTS']).mkdir()
    docker_args = [docker, '--host', 'unix:///var/run/docker.sock']
    images, containers, evidence = [], [], []
    builder = 'neoos-dual-' + uuid.uuid4().hex
    config = context.parent / 'buildkit.toml'
    config.write_text('[worker.oci]\n  max-parallelism = 1\n')
    try:
        diagnostic_stage('buildkit-create')
        run([*docker_args, 'buildx', 'create', '--name', builder, '--driver', 'docker-container',
             '--driver-opt', 'memory=4g', '--driver-opt', 'cpu-period=100000', '--driver-opt', 'cpu-quota=100000',
             '--buildkitd-config', config], env)
        for attempt in (1, 2):
            diagnostic_stage('image-build', attempt)
            image = 'neoos-dual-local:' + sha(str(context.parent).encode())[:16] + '-' + str(attempt)
            # Unique tag; no build args, secrets, SSH agent, cache mounts or env passthrough.
            images.append(image)
            run([*docker_args, 'buildx', 'build', '--builder', builder, '--load', '--platform=linux/amd64', '--no-cache', '--network=default', '-t', image, '-f', context / 'Dockerfile', context], env, timeout=3600)
            diagnostic_stage('image-inspect')
            image_id = run([*docker_args, 'image', 'inspect', '--format', '{{.Id}}', image], env).decode().strip()
            require(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id), 'invalid image ID')
            # Reserve identity before the daemon can create anything. A lost
            # reply or SIGTERM must not erase the cleanup inventory. The random
            # owner label prevents a name collision from authorizing deletion.
            reservation = (builder + '-export-' + str(attempt), uuid.uuid4().hex, image_id)
            containers.append(reservation)
            name, owner, _ = reservation
            diagnostic_stage('image-export')
            cid = run([*docker_args, 'create', '--name', name,
                       '--label', CONTAINER_OWNER_LABEL + '=' + owner, image_id], env).decode().strip()
            require(re.fullmatch('[0-9a-f]{64}', cid), 'invalid container ID')
            require(owned_container(docker_args, env, reservation) == cid, 'create reply does not identify owned container')
            exported = context.parent / ('image-config-' + str(attempt))
            run([*docker_args, 'cp', cid + ':/app/config', exported], env)
            diagnostic_stage('image-verify')
            for n in NETWORKS:
                require(sha(regular(exported / 'custody' / (n + '.json'))) == manifest['files']['public/custody/' + n + '.json'], 'image profile digest mismatch')
            enrollment_file = 'public/custody/testnet-enrollment.json'
            if enrollment_file in manifest['files']:
                require(sha(regular(exported / 'custody/testnet-enrollment.json')) == manifest['files'][enrollment_file], 'image enrollment digest mismatch')
            require(sha(regular(exported / 'network-profiles.json')) == manifest['map_sha256'], 'image map digest mismatch')
            image_env = parse(run([*docker_args, 'image', 'inspect', '--format', '{{json .Config.Env}}', image_id], env))
            require(isinstance(image_env, list) and all(isinstance(v, str) and '=' in v for v in image_env), 'invalid image environment')
            env_map = unique([v.split('=', 1) for v in image_env])
            require(env_map.get('NODE_ENV') == 'production' and env_map.get('MORPHEUS_ATTESTED_BOOT') == 'require' and env_map.get('MORPHEUS_ALLOW_EPHEMERAL_KEY') == '0', 'image boot policy mismatch')
            require(encoded(parse(env_map.get('MORPHEUS_NETWORK_PROFILES_JSON', 'null'))) == regular(exported / 'network-profiles.json'), 'image runtime map differs from measured map')
            receipt = parse(regular(exported / 'custody-build-validation.json'))
            require(receipt == {'schema': 'neoos/dual-custody-build/v1', 'networks': list(NETWORKS), 'map_sha256': manifest['map_sha256']}, 'authoritative Rust preparation receipt mismatch')
            eif = context.parent / ('build-' + str(attempt) + '.eif')
            diagnostic_stage('enclave-build')
            pcrs = measurements(run([nitro, 'build-enclave', '--docker-uri', image, '--output-file', eif], env, timeout=1800))
            require(eif.is_file() and eif.stat().st_size > 0, 'EIF output missing')
            diagnostic_stage('enclave-describe')
            observed = measurements(run([nitro, 'describe-eif', '--eif-path', eif], env))
            require(observed == pcrs, 'EIF readback disagrees with build measurements')
            with eif.open('rb') as stream:
                hasher = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    hasher.update(block)
                eif_digest = hasher.hexdigest()
            evidence.append({'image_id': image_id, 'pcrs': pcrs, 'eif_sha256': eif_digest})
        print('BUILD-EVIDENCE ' + json.dumps(evidence, sort_keys=True), file=__import__('sys').stderr)
        diagnostic_stage('measurements')
        require(evidence[0]['pcrs'] == evidence[1]['pcrs'], 'independent builds are not reproducible')
        result = {**manifest, 'schema': 'neoos/dual-image-build-evidence/v1', 'status': 'measured-candidate; independent review and release admission required', 'canonical_main': tip, 'hash_algorithm': 'SHA384', 'reproducible_verified': True, 'builds': evidence}
    except BaseException as error:
        failure_diagnostic(error)
        raise
    finally:
        diagnostic_stage('cleanup')
        # Stopping the owned daemon cancels work that outlives its Docker client.
        # Attempt every cleanup even if one fails; never prune shared resources.
        failed = False
        commands = [[*docker_args, 'buildx', 'stop', builder], [*docker_args, 'buildx', 'rm', '--force', builder]]
        for command in commands:
            try:
                run(command, env, timeout=30)
            except (ValueError, OSError, subprocess.SubprocessError):
                failed = True
        for reservation in containers:
            try:
                cid = owned_container(docker_args, env, reservation)
                if cid is not None:
                    # Remove by inspected immutable ID, never a returned ID or
                    # reusable name that could now belong to a foreign resource.
                    run([*docker_args, 'rm', '-f', cid], env, timeout=30)
            except (ValueError, OSError, subprocess.SubprocessError):
                failed = True
        for image in images:
            try:
                run([*docker_args, 'image', 'rm', image], env, timeout=30)
            except (ValueError, OSError, subprocess.SubprocessError):
                failed = True
        DIAGNOSTIC['cleanup_failed'] = failed
        require(not failed, 'owned build cleanup failed; operator cleanup required')
    # Publish the first measured artifact only after cancellation/cleanup succeeds.
    diagnostic_stage('publication')
    with (context.parent / 'build-1.eif').open('rb') as stream:
        copied = publication.write('enclave.eif', iter(lambda: stream.read(1024 * 1024), b''))
    require(copied == evidence[0]['eif_sha256'], 'EIF changed during publication')
    publication.write('build-evidence.json', (encoded(result),))
    publication.publish()
    return result


def interrupted(_signal, _frame):
    raise InterruptedError('packaging interrupted')


def main():
    reset_diagnostics()
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'build'))
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--input-sha256', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--builder-platform', choices=('linux/amd64', 'linux/arm64'), default='linux/amd64')
    parser.add_argument('--cross-cache', type=Path, help='explicit content-addressed pinned public tool inputs; native builder only')
    parser.add_argument('--linuxkit-mode', choices=('stock', 'native-arm64'), default='stock')
    parser.add_argument('--native-linuxkit', type=Path, help='exact AWS v1.5.2 ARM LinuxKit; requires native-arm64 mode')
    parser.add_argument('--docker', default='/usr/bin/docker', type=Path)
    parser.add_argument('--nitro-cli', default='/usr/bin/nitro-cli', type=Path)
    parser.add_argument('--nitro-blobs', default='/usr/share/nitro_enclaves/blobs', type=Path)
    args = parser.parse_args()
    require((args.linuxkit_mode == "native-arm64") == (args.native_linuxkit is not None), "explicit native LinuxKit mode and path must be paired")
    require(args.mode == "build" or args.linuxkit_mode == "stock", "LinuxKit selection is build-only")
    with tempfile.TemporaryDirectory(prefix='neoos-dual-') as tmp:
        tmp = Path(tmp).resolve()
        env = safe_env(tmp / 'home')
        Path(env['HOME']).mkdir()
        repo = args.repo.resolve()
        output = args.output.absolute()
        require(repo not in output.parents and repo != output, 'output must be outside source tree')
        destination = output if args.mode == 'prepare' else tmp / 'context'
        diagnostic_stage('staging')
        manifest = stage(repo, args.input, args.input_sha256, destination, env, args.builder_platform, args.cross_cache)
        if args.mode == 'build':
            blobs = args.nitro_blobs
            if args.linuxkit_mode == 'native-arm64':
                blobs = native_linuxkit_bundle(args.native_linuxkit, blobs, tmp/'native-linuxkit-blobs')
                manifest['linuxkit_mode'] = 'native-arm64'
                manifest['linuxkit_adapter_sha256'] = sha((blobs/'linuxkit').read_bytes())
                manifest['linuxkit_native_sha256'] = sha((blobs/'linuxkit.native').read_bytes())
            build(repo, destination, manifest, output, env, args.docker, args.nitro_cli, blobs)
        print(json.dumps({'ok': True, 'mode': args.mode, 'source_commit': manifest['git_commit'], 'output': str(output)}))


def cli():
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError) as error:
        # Configuration values/child stderr can contain accidental secrets.
        print('dual-image: refused (' + type(error).__name__ + ')', file=__import__('sys').stderr)
        print('DUAL-BUILD-FAILURE ' + json.dumps(failure_diagnostic(error), sort_keys=True), file=__import__('sys').stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    cli()

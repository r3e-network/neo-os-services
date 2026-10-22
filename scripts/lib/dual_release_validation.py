"""Strict dual-release source/evidence validation. No network, builds or admission writes.

These functions bind recorded evidence to bytes; they do not establish that a
builder ran, authorize publication, or satisfy independent KMS/policy gates.
"""
import hashlib
import json
import re
from pathlib import PurePosixPath
from urllib.parse import urlsplit

NETWORKS = ['mainnet', 'testnet']
APPS = ['morpheus-oracle', 'morpheus-custody']
BUNDLE = ('public-input.json', 'mainnet.json', 'testnet.json', 'network-profiles.json',
          'context-manifest.json', 'candidate-publication.json', 'candidate-build-evidence.json')
ENROLLMENT_FILE = 'testnet-enrollment.json'
SOURCE_FILES = ('Cargo.toml', 'Cargo.lock', 'config/networks/mainnet.json',
                'config/networks/testnet.json', 'deploy/nitro/Dockerfile.dual-enclave',
                'deploy/nitro/dual-prepare.rs', 'deploy/nitro/Dockerfile.dual-enclave.cross',
                'deploy/nitro/cross-inputs.lock.json', 'deploy/nitro/dual_cross.py')
SOURCE_DIRS = ('vendor/', 'crates/', 'workers/neo-signer/',
               'workers/nitro-enclave-host/', 'workers/neo-os-relayer/')
RECIPE_FILES = ('deploy/nitro/build-dual-enclave.py',)
MAX_JSON = 4 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def parse(data):
    require(isinstance(data, bytes) and len(data) <= MAX_JSON, 'JSON byte limit')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs,
                          parse_constant=lambda _: require(False, 'nonfinite JSON number'))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError('invalid JSON') from exc


def fields(value, names):
    require(type(value) is dict and set(value) == set(names.split()), 'unknown or missing fields')


def digest(value, size=64):
    require(type(value) is str and re.fullmatch('[0-9a-f]{%d}' % size, value)
            and value != '0' * size, 'invalid digest')
    return value


def identifier(value):
    require(type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', value), 'invalid identifier')
    return value


def path(value):
    require(type(value) is str and len(value) <= 512 and
            re.fullmatch(r'[A-Za-z0-9._/-]+', value) and
            all(p not in ('', '.', '..') for p in value.split('/')), 'invalid relative path')
    return value


def selected(name):
    return name in SOURCE_FILES or name.startswith(SOURCE_DIRS)


def affected(name):
    return selected(name) or name in RECIPE_FILES


def inventory(files):
    """files is an exact captured path -> (Git mode, bytes) mapping, never a scan."""
    result = []
    for name, (mode, data) in sorted(files.items()):
        if not affected(name):
            continue
        path(name)
        require(mode in ('100644', '100755') and type(data) is bytes, 'nonregular selected input')
        require(not any(p.startswith('.env') or p.lower() in
                        ('secrets', '.secrets', 'snapshots', 'keys', '.git', 'target', 'node_modules')
                        for p in name.split('/')), 'private/state selected input')
        require(not name.lower().endswith(('.pem', '.key', '.p12', '.db', '.sqlite')), 'private selected input')
        result.append({'path': name, 'mode': mode, 'size': len(data), 'sha256': sha(data)})
    return result


def validate_manifest(m):
    fields(m, '''schema release git_commit source_tree base_main_commit candidate_ref
        candidate_publication_sha256 build_evidence_path build_evidence_sha256 public_bundle_files
        reviewed_input_sha256 source_archive_sha256 context_manifest_sha256 hash_algorithm
        pcr0 pcr1 pcr2 eif_sha256 eif_size_bytes built_at reproducible_verified topology app_ids
        networks contexts authority_admission supersedes selected_source_manifest_sha256 tool_bundle_sha256''')
    require(m['schema'] == 'neoos/dual-enclave-release/v1', 'dual manifest schema')
    release = identifier(m['release'])
    for key in ('git_commit', 'source_tree', 'base_main_commit'):
        digest(m[key], 40)
    require(m['candidate_ref'] == 'refs/tags/neoos-dual-candidate/' + m['git_commit'], 'candidate ref binding')
    for key in ('candidate_publication_sha256', 'build_evidence_sha256', 'reviewed_input_sha256',
                'source_archive_sha256', 'context_manifest_sha256', 'eif_sha256',
                'selected_source_manifest_sha256', 'tool_bundle_sha256'):
        digest(m[key])
    for key in ('pcr0', 'pcr1', 'pcr2'):
        digest(m[key], 96)
    require(m['hash_algorithm'] == 'SHA384' and m['reproducible_verified'] is True, 'measurement policy')
    require(type(m['eif_size_bytes']) is int and 0 < m['eif_size_bytes'] <= 2**31, 'EIF size')
    from datetime import datetime
    require(type(m['built_at']) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', m['built_at']), 'build timestamp')
    datetime.strptime(m['built_at'], '%Y-%m-%dT%H:%M:%SZ')
    require(m['networks'] == NETWORKS and m['app_ids'] == APPS, 'image membership')
    require(m['authority_admission'] == 'separate-required', 'authority separation')
    fields(m['topology'], 'enclave_images business_process custody signer_listener')
    require(type(m['topology']['enclave_images']) is int and m['topology']['signer_listener'] is False, 'topology types')
    require(m['topology'] == {'enclave_images': 1, 'business_process': 'enclave_host',
                            'custody': 'embedded', 'signer_listener': False}, 'dual topology')
    require(type(m['supersedes']) is list and len(m['supersedes']) <= 1024, 'supersedes list')
    ids = [identifier(x) for x in m['supersedes']]
    require(len(set(ids)) == len(ids) and release not in ids, 'invalid supersession IDs')
    prefix = 'deploy/nitro/releases/' + release + '/'
    required_bundle = {prefix + x for x in BUNDLE}
    require(type(m['public_bundle_files']) is dict and
            set(m['public_bundle_files']) in (required_bundle, required_bundle | {prefix + ENROLLMENT_FILE}),
            'exact base bundle with optional TestNet enrollment')
    for name, value in m['public_bundle_files'].items():
        path(name); digest(value)
    require(m['build_evidence_path'] == prefix + 'candidate-build-evidence.json', 'evidence path')
    require(m['public_bundle_files'][m['build_evidence_path']] == m['build_evidence_sha256'], 'evidence digest alias')
    fields(m['contexts'], 'mainnet testnet')
    for network in NETWORKS:
        fields(m['contexts'][network], 'profile_path profile_sha256')
        require(m['contexts'][network]['profile_path'] == prefix + network + '.json', 'profile path')
        require(m['contexts'][network]['profile_sha256'] == m['public_bundle_files'][prefix + network + '.json'], 'profile digest')
    return m


def validate_build_evidence(e, m, context, current_inventory):
    fields(e, '''schema release git_commit source_tree candidate_ref candidate_publication_sha256
        reviewed_input_sha256 source_archive_sha256 context_manifest_sha256 files map_sha256 networks
        builds published_build_index hash_algorithm reproducible_verified built_at status
        tool_bundle_sha256 selected_source_manifest_sha256 selected_source_manifest''')
    require(e['schema'] == 'neoos/dual-image-candidate-evidence/v1' and
            e['status'] == 'measured-candidate-not-admitted', 'candidate evidence schema/status')
    for key in ('release', 'git_commit', 'source_tree', 'candidate_ref', 'candidate_publication_sha256',
                'reviewed_input_sha256', 'source_archive_sha256', 'context_manifest_sha256', 'networks',
                'hash_algorithm', 'reproducible_verified', 'built_at', 'tool_bundle_sha256',
                'selected_source_manifest_sha256'):
        require(e[key] == m[key], 'evidence manifest binding: ' + key)
    require(e['selected_source_manifest'] == current_inventory, 'selected source closure/mode/bytes')
    require(sha(encoded(e['selected_source_manifest'])) == m['selected_source_manifest_sha256'], 'selected source manifest digest')
    require(e['files'] == context['files'] and e['map_sha256'] == context['map_sha256'], 'context evidence binding')
    require(type(e['published_build_index']) is int and e['published_build_index'] == 0, 'retain first build')
    require(type(e['builds']) is list and len(e['builds']) == 2, 'two builds required')
    triple = {k.upper(): m[k] for k in ('pcr0', 'pcr1', 'pcr2')}
    for build in e['builds']:
        fields(build, '''image_id eif_sha256 eif_size_bytes pcrs describe_pcrs profile_sha256
            map_sha256 environment environment_sha256 rust_preparation toolchain_sha256 nitro_blobs_sha256 base_images''')
        require(type(build['image_id']) is str and build['image_id'].startswith('sha256:'), 'image ID')
        digest(build['image_id'][7:]); digest(build['eif_sha256'])
        require(type(build['eif_size_bytes']) is int and 0 < build['eif_size_bytes'] <= 2**31, 'build EIF size')
        require(build['pcrs'] == triple and build['describe_pcrs'] == triple, 'build/describe/cross-build PCR agreement')
        require(build['profile_sha256'] == {n: m['contexts'][n]['profile_sha256'] for n in NETWORKS}, 'image profile readback')
        require(build['map_sha256'] == e['map_sha256'], 'image map readback')
        fields(build['environment'], 'NODE_ENV MORPHEUS_ATTESTED_BOOT MORPHEUS_ALLOW_EPHEMERAL_KEY MORPHEUS_NETWORK_PROFILES_JSON')
        require(build['environment']['NODE_ENV'] == 'production' and
                build['environment']['MORPHEUS_ATTESTED_BOOT'] == 'require' and
                build['environment']['MORPHEUS_ALLOW_EPHEMERAL_KEY'] == '0', 'image boot policy readback')
        require(sha(encoded(parse(build['environment']['MORPHEUS_NETWORK_PROFILES_JSON'].encode()))) ==
                e['map_sha256'], 'image ENV map readback')
        require(sha(encoded(build['environment'])) == build['environment_sha256'], 'environment digest')
        for key in ('environment_sha256', 'toolchain_sha256', 'nitro_blobs_sha256'):
            digest(build[key])
        require(type(build['base_images']) is list and len(build['base_images']) > 0, 'base image identities')
        for image in build['base_images']:
            digest(image)
        require(build['rust_preparation'] == {'schema': 'neoos/dual-custody-build/v1',
                'networks': NETWORKS, 'map_sha256': e['map_sha256']}, 'Rust preparation readback')
    require(e['builds'][0]['eif_sha256'] == m['eif_sha256'] and
            e['builds'][0]['eif_size_bytes'] == m['eif_size_bytes'], 'retained first artifact binding')


# Structural public-input parity with the reviewed builder. This does not
# authenticate owners or replace authoritative Rust VaultProfile validation.
ROLES = ('ORACLE_VERIFIER', 'UPDATER', 'RELAYER', 'WORKER', 'NEOX_UPDATER', 'NEOX_VERIFIER')
PROFILE_FIELDS = ('profile_version vault_id environment networks custody_kms_key_arn root_key_version root_key_commitment snapshot_format_version signer_schema_version coordinator release_policy_version').split()
SCHEMA = 'neoos/dual-image-input/v1'


def public_fields(value, names):
    fields(value, ' '.join(names))


def role_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value), 'invalid custody role ID')
    return value


def public_url(value, origin=False):
    require(isinstance(value, str) and len(value) <= 512 and not re.search(r'[\x00-\x20\x7f]', value), 'invalid public URL')
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


def validate_enrollment(manifest, profile):
    # Structural parity with the builder; authoritative Rust validation remains required.
    destination = ('environment', 'vault_id', 'networks', 'custody_kms_key_arn',
                   'root_key_version', 'root_key_commitment', 'coordinator')
    public_fields(manifest, ('schema', 'purpose', 'ceremony_id', 'caller') + destination)
    require(manifest['schema'] == 'neoos/first-admin-enrollment/v1' and
            manifest['purpose'] == 'first-testnet-admin/v1', 'invalid enrollment contract')
    require(all(manifest[k] == profile[k] for k in destination) and
            manifest['environment'] == 'testnet', 'enrollment destination mismatch')
    role_id(manifest['ceremony_id'])
    caller = manifest['caller']
    public_fields(caller, ('id', 'label', 'created_at_unix', 'token_digest', 'auth_mode',
                          'capabilities', 'key_grant', 'allowed_origins', 'disabled'))
    role_id(caller['id']); digest(caller['token_digest'])
    label = caller['label']
    require(isinstance(label, str) and 0 < len(label.encode()) <= 128 and label.strip() == label and
            not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in label), 'invalid enrollment label')
    require(type(caller['created_at_unix']) is int and 0 < caller['created_at_unix'] <= 2**63-1,
            'invalid enrollment time')
    require(caller['auth_mode'] == 'bearer' and caller['capabilities'] == ['admin'] and
            caller['key_grant'] == 'any' and caller['allowed_origins'] == [] and
            caller['disabled'] is False, 'enrollment must be enabled bearer Admin only')


def validate_public_inputs(docs, source_files):
    value = docs['public-input.json']
    registry = {n: parse(source_files['config/networks/' + n + '.json'][1]) for n in NETWORKS}
    public_fields(value, ('schema', 'release', 'source_commit', 'networks'))
    require(value['schema'] == SCHEMA, 'unknown input schema')
    identifier(value['release'])
    digest(value['source_commit'], 40)
    public_fields(value['networks'], NETWORKS)
    overlays = {}
    enrollment_files = {}
    role_ids = set()
    distinct = {k: set() for k in ('vault_id', 'root_key_commitment', 'audience', 'origin', 'snapshot')}
    for network in NETWORKS:
        spec = value['networks'][network]
        spec_fields = ('profile_file', 'profile_sha256', 'workload_audience', 'roles', 'neo_n3_rpc', 'neo_x_rpc', 'frontier_kms_key_arn', 'aws_region')
        public_fields(spec, spec_fields + tuple(k for k in ('enrollment', 'feed_price_plane')
                                               if type(spec) is dict and k in spec))
        if 'feed_price_plane' in spec:
            require(type(spec['feed_price_plane']) is str and
                    spec['feed_price_plane'] in ('twelvedata', 'public-quorum'),
                    'feed price plane must be twelvedata or public-quorum')
        require(spec['profile_file'] == network + '.json', 'profile file must be its network basename')
        profile = docs[network + '.json']
        digest(spec['profile_sha256'])
        public_fields(profile, PROFILE_FIELDS)
        require(profile['environment'] == network, 'profile network mismatch')
        require(all(type(profile[k]) is int for k in ('profile_version', 'snapshot_format_version', 'signer_schema_version')) and profile['profile_version'] == 1 and profile['snapshot_format_version'] == 2 and profile['signer_schema_version'] == 1, 'profile version mismatch')
        digest(profile['vault_id'], 32)
        digest(profile['root_key_commitment'])
        identifier(profile['root_key_version']); identifier(profile['release_policy_version'])
        bindings = profile['networks']
        require(isinstance(bindings, list) and len(bindings) == 2, 'combined image requires both public chain families per vault')
        for binding, family, section, id_key in zip(bindings, ('neo-n3', 'neox'), ('neo_n3', 'neo_x'), ('network_magic', 'chain_id')):
            public_fields(binding, ('chain_family', 'chain_id', 'genesis_hash'))
            require(binding['chain_family'] == family and type(binding['chain_id']) is int and binding['chain_id'] == registry[network][section][id_key], 'profile chain binding mismatch')
            require(isinstance(binding['genesis_hash'], str) and binding['genesis_hash'].startswith('0x'), 'invalid genesis hash')
            digest(binding['genesis_hash'][2:])
            known_genesis = registry[network][section].get('genesis_hash')
            require(not known_genesis or binding['genesis_hash'] == known_genesis, 'profile differs from reviewed genesis')
        coordinator = profile['coordinator']
        public_fields(coordinator, ('origin', 'aws_region', 'snapshot_bucket', 'snapshot_prefix', 'receipt_keys'))
        public_url(coordinator['origin'], origin=True)
        region = spec['aws_region']
        require(isinstance(region, str) and re.fullmatch(r'[a-z]{2}-[a-z]+-[1-9]', region) and coordinator['aws_region'] == region, 'AWS region mismatch')
        kms(profile['custody_kms_key_arn'], region); kms(spec['frontier_kms_key_arn'], region)
        require(isinstance(coordinator['snapshot_bucket'], str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', coordinator['snapshot_bucket']) is not None, 'invalid snapshot bucket')
        prefix = coordinator['snapshot_prefix']
        require(isinstance(prefix, str) and len(prefix) <= 512 and all(re.fullmatch(r'[A-Za-z0-9_-]+', s) for s in prefix.split('/')), 'invalid snapshot namespace')
        receipts = coordinator['receipt_keys']
        require(isinstance(receipts, list) and 1 <= len(receipts) <= 4, 'invalid receipt key set')
        ids = set()
        for receipt in receipts:
            public_fields(receipt, ('key_id', 'public_key_sec1_hex'))
            require(identifier(receipt['key_id']) not in ids, 'duplicate receipt key')
            ids.add(receipt['key_id'])
            key = receipt['public_key_sec1_hex']
            require(isinstance(key, str) and re.fullmatch(r'04[0-9a-f]{128}', key) and key[2:] != '0'*128, 'invalid receipt public key encoding')
        audience = public_url(spec['workload_audience'], origin=True)
        for key, identity in (('vault_id', profile['vault_id']), ('root_key_commitment', profile['root_key_commitment']), ('audience', audience), ('origin', coordinator['origin']), ('snapshot', coordinator['snapshot_bucket'] + '/' + prefix)):
            require(identity not in distinct[key], 'networks share ' + key)
            distinct[key].add(identity)
        public_fields(spec['roles'], ROLES)
        role_values = [role_id(spec['roles'][role]) for role in ROLES]
        require(len(set(role_values)) == len(ROLES) and not role_ids.intersection(role_values), 'roles require distinct reviewed key identities')
        role_ids.update(role_values)
        overlay = {
            'MORPHEUS_NETWORK': network,
            'MORPHEUS_CUSTODY_PROFILE_FILE': '/app/config/custody/' + network + '.json',
            'MORPHEUS_CUSTODY_PROFILE_SHA256': spec['profile_sha256'],
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
        if 'feed_price_plane' in spec:
            overlay['FEED_PRICE_PLANE'] = spec['feed_price_plane']
        if 'enrollment' in spec:
            enrollment = spec['enrollment']
            public_fields(enrollment, ('mode', 'manifest_file', 'manifest_sha256'))
            require(network == 'testnet' and enrollment['mode'] == 'first-testnet-admin/v1',
                    'enrollment requires explicit TestNet opt-in')
            require(enrollment['manifest_file'] == ENROLLMENT_FILE, 'enrollment file must use fixed basename')
            enrollment_sha = digest(enrollment['manifest_sha256'])
            require(enrollment_sha == profile['release_policy_version'], 'enrollment profile digest mismatch')
            require(ENROLLMENT_FILE in docs, 'missing enrollment manifest')
            validate_enrollment(docs[ENROLLMENT_FILE], profile)
            enrollment_files[ENROLLMENT_FILE] = enrollment_sha
            overlay.update({
                'MORPHEUS_CUSTODY_ENROLLMENT_MODE': enrollment['mode'],
                'MORPHEUS_CUSTODY_ENROLLMENT_FILE': '/app/config/custody/' + ENROLLMENT_FILE,
                'MORPHEUS_CUSTODY_ENROLLMENT_SHA256': enrollment_sha,
            })
        overlay.update({'SIGNER_ROLE_' + role + '_KEY_ID': spec['roles'][role] for role in ROLES})
        overlays[network] = overlay
    require(docs['network-profiles.json'] == overlays, 'exact generated network map')
    return enrollment_files


def cross_context_files(context, source_files):
    """Reconstruct digests from the captured source lock, never from a host cache."""
    require(context['builder_platform'] == 'linux/arm64', 'unsupported context builder platform')
    data = source_files['deploy/nitro/cross-inputs.lock.json'][1]
    require(context['cross_lock_sha256'] == sha(data), 'cross lock digest')
    pins = parse(data)
    fields(pins, 'schema rust_version target builder_image objects')
    require(pins['schema'] == 'neoos/dual-cross-inputs/v1' and
            pins['target'] == 'x86_64-unknown-linux-gnu', 'cross lock identity')
    require(type(pins['rust_version']) is str and 0 < len(pins['rust_version']) <= 128 and
            type(pins['builder_image']) is str and 0 < len(pins['builder_image']) <= 256,
            'cross lock tool identity')
    require(type(pins['objects']) is list and 0 < len(pins['objects']) <= 4096, 'cross lock objects')
    output, sums = {}, []
    for entry in pins['objects']:
        required_fields = {'path', 'sha256', 'size'}
        package_fields = {'package', 'version', 'architecture'}
        require(type(entry) is dict and set(entry) in (required_fields, required_fields | package_fields),
                'cross object fields')
        if 'package' in entry:
            require(all(type(entry[k]) is str and 0 < len(entry[k]) <= 256 and
                        not any(ord(c) < 32 or ord(c) == 127 for c in entry[k]) for k in package_fields),
                    'cross package metadata')
        name = entry['path']
        require(type(name) is str and len(name) <= 512 and
                re.fullmatch(r'[A-Za-z0-9_+./%:=-]+', name), 'invalid cross input path')
        parts = PurePosixPath(name).parts
        require(name not in output and not name.startswith('/') and '..' not in parts and
                str(PurePosixPath(name)) == name and len(parts) >= 3 and
                parts[0] == 'cross-inputs' and parts[1] in ('debs', 'rustlib'),
                'invalid or duplicate cross input path')
        require(type(entry['size']) is int and entry['size'] > 0, 'cross object size')
        output[name] = digest(entry['sha256'])
        sums.append(entry['sha256'] + '  ' + '/'.join(parts[1:]))
    output['cross-inputs/SHA256SUMS'] = sha(('\n'.join(sums) + '\n').encode())
    return output


def validate_bundle(manifest_bytes, files, source_files):
    """Validate exact captured bytes. No filesystem/network discovery or acceptance flag."""
    m = validate_manifest(parse(manifest_bytes))
    docs = {}
    for name, expected in m['public_bundle_files'].items():
        require(name in files, 'missing public file')
        mode, data = files[name]
        require(mode == '100644', 'public file must be regular non-executable')
        require(sha(data) == expected, 'public file digest')
        docs[name.rsplit('/', 1)[-1]] = parse(data)
    prefix = 'deploy/nitro/releases/' + m['release'] + '/'
    require({name for name in files if name.startswith(prefix)} == set(m['public_bundle_files']),
            'unlisted release bundle file')
    spec = docs['public-input.json']
    enrollment_files = validate_public_inputs(docs, source_files)
    require(set(docs) == set(BUNDLE) | set(enrollment_files), 'bundle enrollment opt-in mismatch')
    for name, expected_sha in enrollment_files.items():
        data = files[prefix + name][1]
        require(len(data) <= 16384, 'enrollment manifest exceeds bound')
        require(sha(data) == expected_sha, 'enrollment manifest digest mismatch')
    for filename, key in [('public-input.json', 'reviewed_input_sha256'),
                          ('context-manifest.json', 'context_manifest_sha256'),
                          ('candidate-publication.json', 'candidate_publication_sha256')]:
        require(m['public_bundle_files'][prefix + filename] == m[key], 'bundle digest alias')
    context = docs['context-manifest.json']
    cross = type(context) is dict and 'builder_platform' in context
    fields(context, 'schema release git_commit source_archive_sha256 reviewed_input_sha256 map_sha256 networks files status' +
           (' builder_platform cross_lock_sha256' if cross else ''))
    require(context['schema'] == 'neoos/dual-image-context/v1', 'context schema')
    for key in ('release', 'git_commit', 'source_archive_sha256', 'reviewed_input_sha256', 'networks'):
        require(context[key] == m[key], 'context identity')
    require(type(context['status']) is str and len(context['status']) <= 256, 'context status')
    require(type(context['files']) is dict, 'context files')
    expected = {name: sha(data) for name, (_, data) in source_files.items() if selected(name)}
    for network in NETWORKS:
        expected['public/custody/' + network + '.json'] = m['contexts'][network]['profile_sha256']
    expected.update({'public/custody/' + name: value for name, value in enrollment_files.items()})
    expected['public/etc/hosts'] = sha(b'127.0.0.1 localhost\n')
    expected['public/etc/hostname'] = sha(b'neoos-enclave\n')
    map_bytes = files[prefix + 'network-profiles.json'][1]
    expected['public/network-profiles.json'] = sha(map_bytes)
    require(context['map_sha256'] == sha(map_bytes), 'map digest')
    recipe = 'deploy/nitro/Dockerfile.dual-enclave'
    if cross:
        expected.update(cross_context_files(context, source_files))
        recipe += '.cross'
    template = source_files[recipe][1].decode()
    require(template.count('# DUAL_NETWORK_ENV') == 1, 'Docker marker')
    # Exact encoding used by the reviewed Python builder, including JSON escaping.
    env_line = 'ENV MORPHEUS_NETWORK_PROFILES_JSON=' + json.dumps(map_bytes.decode().strip())
    expected['Dockerfile'] = sha(template.replace('# DUAL_NETWORK_ENV', env_line).encode())
    require(context['files'] == expected, 'generated selected context closure')
    fields(spec, 'schema release source_commit networks')
    require(spec['release'] == m['release'] and spec['source_commit'] == m['git_commit'], 'public input identity')
    fields(spec['networks'], 'mainnet testnet')
    for n in NETWORKS:
        require(spec['networks'][n]['profile_sha256'] == m['contexts'][n]['profile_sha256'], 'public input profile binding')
    validate_build_evidence(docs['candidate-build-evidence.json'], m, context, inventory(source_files))
    # Full authoritative profile/publication validation is a separate required
    # check. Return bound data, never an admission or publication decision.
    return m

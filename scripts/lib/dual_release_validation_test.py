"""Unit fixtures only. No fixture is written under the production measurement registry."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import dual_release_validation as v
import check_dual_release as gate
from dual_release_provenance import Capture

ROOT = Path(__file__).resolve().parents[2]


ROLES = ('ORACLE_VERIFIER', 'UPDATER', 'RELAYER', 'WORKER', 'NEOX_UPDATER', 'NEOX_VERIFIER')


def public_fixture(source):
    # Synthetic schema fixtures only; never production inputs or admission evidence.
    profiles, specs, overlays = {}, {}, {}
    for i, n in enumerate(v.NETWORKS, 1):
        registry = v.parse((ROOT / ('config/networks/' + n + '.json')).read_bytes())
        source['config/networks/' + n + '.json'] = ('100644', v.encoded(registry))
        profile = {'profile_version': 1, 'vault_id': str(i)*32, 'environment': n,
            'networks': [{'chain_family': family, 'chain_id': registry[section][key],
                'genesis_hash': registry[section].get('genesis_hash', '0x'+str(i)*64)}
                for family,section,key in [('neo-n3','neo_n3','network_magic'),('neox','neo_x','chain_id')]],
            'custody_kms_key_arn': 'arn:aws:kms:us-east-1:000000000000:key/11111111-1111-1111-1111-111111111111',
            'root_key_version': 'unit-only', 'root_key_commitment': str(i)*64,
            'snapshot_format_version': 2, 'signer_schema_version': 1, 'release_policy_version': 'unit-only',
            'coordinator': {'origin': 'https://'+n+'.example.invalid', 'aws_region': 'us-east-1',
                'snapshot_bucket': 'unit-only-'+n, 'snapshot_prefix': 'unit/'+n,
                'receipt_keys': [{'key_id': 'unit-only', 'public_key_sec1_hex': '04'+'1'*128}]}}
        profiles[n] = v.encoded(profile)
        spec = {'profile_file': n+'.json', 'profile_sha256': v.sha(profiles[n]),
            'workload_audience': 'https://audience-'+n+'.example.invalid',
            'roles': {r: n+'-unit-'+r for r in ROLES}, 'neo_n3_rpc': 'https://n3.example.invalid/'+n,
            'neo_x_rpc': 'https://x.example.invalid/'+n, 'frontier_kms_key_arn': profile['custody_kms_key_arn'],
            'aws_region': 'us-east-1'}
        specs[n] = spec
        overlays[n] = {'MORPHEUS_NETWORK': n, 'MORPHEUS_CUSTODY_PROFILE_FILE': '/app/config/custody/'+n+'.json',
            'MORPHEUS_CUSTODY_PROFILE_SHA256': spec['profile_sha256'], 'MORPHEUS_CUSTODY_DATA_DIR': '/var/lib/neoos-custody/'+n,
            'MORPHEUS_CUSTODY_WORKLOAD_AUDIENCE': spec['workload_audience'], 'SIGNER_SERVICE_URL': 'http://127.0.0.1:0/'+n,
            'NEO_RPC_URL': spec['neo_n3_rpc'], 'NEO_RPC_URLS_' + n.upper(): spec['neo_n3_rpc'],
            'NEOX_RPC_URL': spec['neo_x_rpc'], 'NEOX_RPC': spec['neo_x_rpc'],
            'EVM_RPC_URL': spec['neo_x_rpc'], 'AWS_REGION': spec['aws_region'], 'FRONTIER_KMS_KEY_ARN': spec['frontier_kms_key_arn'],
            **{'SIGNER_ROLE_'+r+'_KEY_ID': spec['roles'][r] for r in ROLES}}
    return profiles, specs, overlays


def packaging_module():
    spec = importlib.util.spec_from_file_location(
        'dual_packaging', ROOT / 'deploy/nitro/build-dual-enclave.py')
    packaging = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(packaging)
    return packaging


def fixture(mutate_public=None, enrollment=False, mutate_enrollment=None,
            enrollment_encoder=v.encoded, cross=False, price_planes=None, relayer=False):
    # Reuse recorded public PCRs, never invent or register production measurements.
    old = v.parse((ROOT / 'deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.10.json').read_bytes())
    source = {p: ('100644', b'unit fixture only\n') for p in (*v.SOURCE_FILES, *v.RECIPE_FILES)}
    source['deploy/nitro/Dockerfile.dual-enclave'] = ('100644', b'FROM fixture\n# DUAL_NETWORK_ENV\n')
    cross_objects = {'cross-inputs/debs/unit_1%3a1_arm64.deb': b'unit-only deb',
                     'cross-inputs/rustlib/unit.rlib': b'unit-only rustlib'}
    if cross:
        source['deploy/nitro/Dockerfile.dual-enclave.cross'] = (
            '100644', b'FROM cross-fixture\n# DUAL_NETWORK_ENV\n')
        source['deploy/nitro/cross-inputs.lock.json'] = ('100644', v.encoded({
            'schema': 'neoos/dual-cross-inputs/v1', 'target': 'x86_64-unknown-linux-gnu',
            'rust_version': 'unit-only', 'builder_image': 'unit-only',
            'objects': [{'path': name, 'sha256': v.sha(data), 'size': len(data)}
                        for name, data in cross_objects.items()]}))
    release = 'unit-fixture-not-admitted'
    prefix = 'deploy/nitro/releases/' + release + '/'
    profiles, specs, overlays = public_fixture(source)
    spec = {'schema': 'neoos/dual-image-input/v1', 'release': release, 'source_commit': 'a'*40, 'networks': specs}
    for network, plane in (price_planes or {}).items():
        specs[network]['feed_price_plane'] = plane
        overlays[network]['FEED_PRICE_PLANE'] = plane
    if relayer:
        for n in v.NETWORKS:
            relay = {'state_file': '/var/lib/neoos-relayer/' + n + '/state.json',
                'instance_id': n + '-instance', 'caller_id': n + '-caller',
                'store_url': 'https://store.example.invalid',
                'store_api_key': 'sb_publishable_' + 'a' * 40,
                'issuer': 'https://issuer.example.invalid/auth/v1', 'mode': 'combined',
                'active_chains': ['neo_n3', 'neox'], 'feed_sync_enabled': True}
            specs[n]['relayer'] = relay
            overlays[n].update({
                'MORPHEUS_RELAYER_STATE_FILE': relay['state_file'],
                'MORPHEUS_RELAYER_INSTANCE_ID': relay['instance_id'],
                'MORPHEUS_RELAYER_CALLER_ID': relay['caller_id'],
                'MORPHEUS_RELAYER_STORE_URL': relay['store_url'],
                'MORPHEUS_RELAYER_STORE_API_KEY': relay['store_api_key'],
                'MORPHEUS_RELAYER_JWT_ISSUER': relay['issuer'],
                'MORPHEUS_RELAYER_MODE': relay['mode'],
                'MORPHEUS_ACTIVE_CHAINS': 'neo_n3,neox',
                'MORPHEUS_FEED_SYNC_ENABLED': 'true', 'MORPHEUS_DELIVERY_PROTOCOL': 'v2',
                'MORPHEUS_RELAYER_CONCURRENCY': '1', 'MORPHEUS_AUTOMATION_ENABLED': 'false'})
    enrollment_docs = {}
    if enrollment:
        profile = v.parse(profiles['testnet'])
        manifest = {key: copy.deepcopy(profile[key]) for key in (
            'environment', 'vault_id', 'networks', 'custody_kms_key_arn',
            'root_key_version', 'root_key_commitment', 'coordinator')}
        manifest.update(schema='neoos/first-admin-enrollment/v1',
            purpose='first-testnet-admin/v1', ceremony_id='unit-only-ceremony',
            caller={'id': 'unit-admin', 'label': 'Unit fixture only',
                'created_at_unix': 1, 'token_digest': v.sha(b'not a credential'),
                'auth_mode': 'bearer', 'capabilities': ['admin'], 'key_grant': 'any',
                'allowed_origins': [], 'disabled': False})
        if mutate_enrollment:
            mutate_enrollment(manifest)
        enrollment_docs['testnet-enrollment.json'] = enrollment_encoder(manifest)
        digest = v.sha(enrollment_docs['testnet-enrollment.json'])
        profile['release_policy_version'] = digest
        profiles['testnet'] = v.encoded(profile)
        specs['testnet']['profile_sha256'] = v.sha(profiles['testnet'])
        specs['testnet']['enrollment'] = {'mode': 'first-testnet-admin/v1',
            'manifest_file': 'testnet-enrollment.json', 'manifest_sha256': digest}
        overlays['testnet']['MORPHEUS_CUSTODY_PROFILE_SHA256'] = v.sha(profiles['testnet'])
        overlays['testnet'].update(MORPHEUS_CUSTODY_ENROLLMENT_MODE='first-testnet-admin/v1',
            MORPHEUS_CUSTODY_ENROLLMENT_FILE='/app/config/custody/testnet-enrollment.json',
            MORPHEUS_CUSTODY_ENROLLMENT_SHA256=digest)
    if mutate_public:
        parsed = {n: v.parse(profiles[n]) for n in v.NETWORKS}
        mutate_public(spec, parsed, overlays, source)
        profiles = {n: v.encoded(parsed[n]) for n in v.NETWORKS}
        for n in v.NETWORKS:
            spec['networks'][n]['profile_sha256'] = v.sha(profiles[n])
            overlays[n]['MORPHEUS_CUSTODY_PROFILE_SHA256'] = v.sha(profiles[n])
    map_bytes = v.encoded(overlays)
    files = {name: v.sha(data) for name, (_, data) in source.items() if v.selected(name)}
    files.update({'public/custody/'+n+'.json':v.sha(profiles[n]) for n in v.NETWORKS})
    files.update({'public/custody/'+n:v.sha(data) for n,data in enrollment_docs.items()})
    files['public/network-profiles.json'] = v.sha(map_bytes)
    files['public/etc/hosts'] = v.sha(b'127.0.0.1 localhost\n')
    files['public/etc/hostname'] = v.sha(b'neoos-enclave\n')
    recipe = 'deploy/nitro/Dockerfile.dual-enclave'
    if cross:
        recipe += '.cross'
        files.update({name: v.sha(data) for name, data in cross_objects.items()})
        sums = ''.join(v.sha(data) + '  ' + name.split('/', 1)[1] + '\n'
                       for name, data in cross_objects.items()).encode()
        files['cross-inputs/SHA256SUMS'] = v.sha(sums)
    files['Dockerfile'] = v.sha(source[recipe][1].decode().replace(
        '# DUAL_NETWORK_ENV', 'ENV MORPHEUS_NETWORK_PROFILES_JSON='+json.dumps(map_bytes.decode().strip()) +
        ' MORPHEUS_EMBEDDED_RELAYER=' + str(relayer).lower()).encode())
    context = {'schema': 'neoos/dual-image-context/v1', 'release': release, 'git_commit':'a'*40,
        'source_archive_sha256':v.sha(b'unit-only archive'),'reviewed_input_sha256':v.sha(v.encoded(spec)),
        'map_sha256':v.sha(map_bytes),'networks':v.NETWORKS,'files':files,'status':'fixture only, not admission'}
    if cross:
        context.update(builder_platform='linux/arm64',
            cross_lock_sha256=v.sha(source['deploy/nitro/cross-inputs.lock.json'][1]))
    docs = {'public-input.json':v.encoded(spec), **{n+'.json':profiles[n] for n in v.NETWORKS},
            'network-profiles.json':map_bytes,'context-manifest.json':v.encoded(context),
            'candidate-publication.json':v.encoded({'fixture':'not publication evidence'}),
            **enrollment_docs}
    m = {'schema':'neoos/dual-enclave-release/v1','release':release,'git_commit':'a'*40,
         'source_tree':'b'*40,'base_main_commit':'c'*40,'candidate_ref':'refs/tags/neoos-dual-candidate/'+'a'*40,
         'candidate_publication_sha256':v.sha(docs['candidate-publication.json']),
         'build_evidence_path':prefix+'candidate-build-evidence.json','build_evidence_sha256':'d'*64,
         'public_bundle_files':{},'reviewed_input_sha256':v.sha(docs['public-input.json']),
         'source_archive_sha256':context['source_archive_sha256'],'context_manifest_sha256':v.sha(docs['context-manifest.json']),
         'hash_algorithm':'SHA384',**{p:old[p] for p in ('pcr0','pcr1','pcr2')},
         'eif_sha256':v.sha(b'fixture bytes, NOT EIF'),'eif_size_bytes':len(b'fixture bytes, NOT EIF'),
         'built_at':'2026-10-17T00:00:00Z','reproducible_verified':True,
         'topology':{'enclave_images':1,'business_process':'enclave_host','custody':'embedded','signer_listener':False},
         'app_ids':v.APPS,'networks':v.NETWORKS,'contexts':{n:{'profile_path':prefix+n+'.json','profile_sha256':v.sha(profiles[n])} for n in v.NETWORKS},
         'authority_admission':'separate-required','supersedes':[],
         'selected_source_manifest_sha256':v.sha(v.encoded(v.inventory(source))),'tool_bundle_sha256':'e'*64}
    e = {k:m[k] for k in ('release','git_commit','source_tree','candidate_ref','candidate_publication_sha256',
         'reviewed_input_sha256','source_archive_sha256','context_manifest_sha256','networks','hash_algorithm',
         'reproducible_verified','built_at','tool_bundle_sha256','selected_source_manifest_sha256')}
    build={'image_id':'sha256:'+'f'*64,'eif_sha256':m['eif_sha256'],'eif_size_bytes':m['eif_size_bytes'],
           'pcrs':{p.upper():m[p] for p in ('pcr0','pcr1','pcr2')},
           'describe_pcrs':{p.upper():m[p] for p in ('pcr0','pcr1','pcr2')},
           'profile_sha256':{n:m['contexts'][n]['profile_sha256'] for n in v.NETWORKS},
           'map_sha256':context['map_sha256'],
           'environment':{'NODE_ENV':'production','MORPHEUS_ATTESTED_BOOT':'require',
            'MORPHEUS_ALLOW_EPHEMERAL_KEY':'0','MORPHEUS_NETWORK_PROFILES_JSON':map_bytes.decode(),
            'MORPHEUS_EMBEDDED_RELAYER':str(relayer).lower()},
           'environment_sha256':'1'*64,
           'rust_preparation':{'schema':'neoos/dual-custody-build/v1','networks':v.NETWORKS,'map_sha256':context['map_sha256']},
           'toolchain_sha256':'2'*64,'nitro_blobs_sha256':'3'*64,'base_images':['4'*64]}
    build['environment_sha256']=v.sha(v.encoded(build['environment']))
    e.update(schema='neoos/dual-image-candidate-evidence/v1',status='measured-candidate-not-admitted',
             files=files,map_sha256=context['map_sha256'],builds=[copy.deepcopy(build),copy.deepcopy(build)],
             published_build_index=0,selected_source_manifest=v.inventory(source))
    docs['candidate-build-evidence.json']=v.encoded(e)
    m['build_evidence_sha256']=v.sha(docs['candidate-build-evidence.json'])
    m['public_bundle_files']={prefix+n:v.sha(b) for n,b in docs.items()}
    return m, {prefix+n:('100644',b) for n,b in docs.items()}, source, e, context


def rebind_context(m, files, evidence, context):
    """Rehash synthetic outer wrappers so tests reach context semantics."""
    prefix = 'deploy/nitro/releases/' + m['release'] + '/'
    raw = v.encoded(context)
    files[prefix + 'context-manifest.json'] = ('100644', raw)
    m['context_manifest_sha256'] = v.sha(raw)
    m['public_bundle_files'][prefix + 'context-manifest.json'] = v.sha(raw)
    evidence['context_manifest_sha256'] = v.sha(raw)
    evidence['files'] = copy.deepcopy(context['files'])
    raw = v.encoded(evidence)
    files[m['build_evidence_path']] = ('100644', raw)
    m['build_evidence_sha256'] = v.sha(raw)
    m['public_bundle_files'][m['build_evidence_path']] = v.sha(raw)


class Validation(unittest.TestCase):
    def test_actual_staging_contexts_with_and_without_enrollment(self):
        # Real stage_into/public_inputs/cross_inputs; only Git source acquisition
        # is substituted with a small synthetic snapshot. No build or network.
        class Publication:
            def __init__(self): self.files = {}; self.published = False
            def write(self, name, chunks):
                assert name not in self.files
                self.files[name] = b''.join(chunks)
            def publish(self): self.published = True
        for cross in (False, True):
            for enrollment, price_planes in ((enrollment, planes)
                    for enrollment in (False, True)
                    for planes in ({}, {'mainnet': 'public-quorum'}, {'testnet': 'public-quorum'},
                                   {'mainnet': 'twelvedata', 'testnet': 'public-quorum'},
                                   {'mainnet': 'public-quorum', 'testnet': 'public-quorum'})):
                with self.subTest(cross=cross, enrollment=enrollment, price_planes=price_planes):
                    m, files, source, evidence, context = fixture(enrollment=enrollment,
                        cross=cross, price_planes=price_planes)
                    packaging = packaging_module()
                    publication = Publication()
                    with tempfile.TemporaryDirectory() as directory:
                        root = Path(directory).resolve()
                        for name, (_, data) in files.items():
                            (root / name.rsplit('/', 1)[-1]).write_bytes(data)
                        if cross:
                            objects = root / 'objects/sha256'
                            objects.mkdir(parents=True)
                            for data in (b'unit-only deb', b'unit-only rustlib'):
                                (objects / v.sha(data)).write_bytes(data)
                        captured = {name: data for name, (_, data) in source.items() if v.selected(name)}
                        with patch.object(packaging, 'source', return_value=(captured, m['source_archive_sha256'])) as acquisition:
                            actual = packaging.stage_into(root, root / 'public-input.json',
                                m['reviewed_input_sha256'], {}, publication,
                                builder_platform='linux/arm64' if cross else 'linux/amd64',
                                cross_cache=root if cross else None)
                        acquisition.assert_called_once()
                    self.assertTrue(publication.published)
                    self.assertEqual(actual['files'], context['files'])
                    self.assertEqual(actual['files'], {name: v.sha(data) for name, data in publication.files.items()
                        if name != 'context-manifest.json'})
                    rebind_context(m, files, evidence, actual)
                    self.assertEqual(v.validate_bundle(v.encoded(m), files, source), m)
                    self.assertEqual(len(m['public_bundle_files']), 8 if enrollment else 7)

    def test_relayer_builder_and_independent_validator_join(self):
        for enabled in (False, True):
            m, files, source, _, context = fixture(relayer=enabled)
            packaging = packaging_module()
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                for name, (_, data) in files.items():
                    (root / name.rsplit('/', 1)[-1]).write_bytes(data)
                registry = {n: v.parse(source['config/networks/' + n + '.json'][1]) for n in v.NETWORKS}
                _, _, overlays = packaging.public_inputs(root / 'public-input.json', m['reviewed_input_sha256'], registry)
                expected = next(data for name, (_, data) in files.items() if name.endswith('/network-profiles.json'))
                self.assertEqual(packaging.encoded(overlays), expected)
                class Publication:
                    def __init__(self): self.files = {}; self.published = False
                    def write(self, name, chunks): self.files[name] = b''.join(chunks)
                    def publish(self): self.published = True
                publication = Publication()
                captured = {name: data for name, (_, data) in source.items() if v.selected(name)}
                with patch.object(packaging, 'source', return_value=(captured, m['source_archive_sha256'])):
                    actual = packaging.stage_into(root, root / 'public-input.json',
                        m['reviewed_input_sha256'], {}, publication)
                self.assertTrue(publication.published)
                self.assertEqual(actual['files'], context['files'])
            with self.subTest(enabled=enabled):
                self.assertEqual(v.validate_bundle(v.encoded(m), files, source), m)

    def test_relayer_positive_modes_and_public_anon_keys(self):
        anon = 'e30.' + base64.urlsafe_b64encode(b'{"role":"anon"}').decode().rstrip('=') + '.sig'
        for mode, feed in [('combined', True), ('feed_only', True), ('requests_only', False)]:
            for key in ['sb_publishable_' + 'a' * 40, anon]:
                def mutate(spec, profiles, overlays, source):
                    for n in v.NETWORKS:
                        spec['networks'][n]['relayer'].update(mode=mode, feed_sync_enabled=feed, store_api_key=key)
                        overlays[n].update(MORPHEUS_RELAYER_MODE=mode,
                            MORPHEUS_FEED_SYNC_ENABLED=str(feed).lower(), MORPHEUS_RELAYER_STORE_API_KEY=key)
                m, files, source, _, _ = fixture(relayer=True, mutate_public=mutate)
                with self.subTest(mode=mode, feed=feed, key_kind=key.split('.')[0]):
                    self.assertEqual(v.validate_bundle(v.encoded(m), files, source), m)

    def test_relayer_public_boundaries_refuse_rehashed_inputs(self):
        cases = [
            ('state_file', '/var/lib/neoos-relayer/testnet/state.json'),
            ('state_file', '/var/lib/neoos-relayer/mainnet/../state.json'),
            ('instance_id', 'testnet-instance'), ('caller_id', 'testnet-caller'),
            ('store_url', 'https://user:pass@store.example.invalid'),
            ('store_url', 'https://store.example.invalid?key=secret'),
            ('store_api_key', 'sb_secret_' + 'a' * 40),
            ('store_api_key', 'sb_publishable_short'),
            ('issuer', ''), ('issuer', 'issuer\nsecret'), ('issuer', 'x' * 2049),
            ('mode', 'unknown'), ('mode', False),
            ('active_chains', ['neox', 'neo_n3']), ('active_chains', ['neo_n3']),
            ('active_chains', 'neo_n3,neox'),
            ('feed_sync_enabled', False), ('feed_sync_enabled', 'true'),
            ('extra', True),
        ]
        service_payload = base64.urlsafe_b64encode(b'{"role":"service_role"}').decode().rstrip('=')
        cases.append(('store_api_key', 'e30.' + service_payload + '.sig'))
        for field, value in cases:
            def mutate(spec, profiles, overlays, source):
                spec['networks']['mainnet']['relayer'][field] = value
                # Keep generated bytes coherent even for the invalid spec, so
                # semantic guards cannot be masked by an unrelated map mismatch.
                mapped = {'state_file': 'STATE_FILE', 'instance_id': 'INSTANCE_ID',
                    'caller_id': 'CALLER_ID', 'store_url': 'STORE_URL',
                    'store_api_key': 'STORE_API_KEY', 'issuer': 'JWT_ISSUER', 'mode': 'MODE'}
                if field in mapped:
                    overlays['mainnet']['MORPHEUS_RELAYER_' + mapped[field]] = value
                elif field == 'feed_sync_enabled':
                    overlays['mainnet']['MORPHEUS_FEED_SYNC_ENABLED'] = str(value).lower()
            m, files, source, _, _ = fixture(relayer=True, mutate_public=mutate)
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                v.validate_bundle(v.encoded(m), files, source)
        for network in v.NETWORKS:
            for value in (None, False, [], {}):
                def mutate(spec, profiles, overlays, source):
                    spec['networks'][network]['relayer'] = value
                m, files, source, _, _ = fixture(relayer=True, mutate_public=mutate)
                with self.subTest(network=network, value=value), self.assertRaises(ValueError):
                    v.validate_bundle(v.encoded(m), files, source)
            def mutate(spec, profiles, overlays, source):
                del spec['networks'][network]['relayer']
            m, files, source, _, _ = fixture(relayer=True, mutate_public=mutate)
            with self.subTest(network=network), self.assertRaises(ValueError):
                v.validate_bundle(v.encoded(m), files, source)

    def test_relayer_generated_map_is_exact(self):
        for action in ('missing', 'wrong', 'extra', 'gate-field'):
            def mutate(spec, profiles, overlays, source):
                if action == 'missing': del overlays['mainnet']['MORPHEUS_RELAYER_STATE_FILE']
                elif action == 'wrong': overlays['mainnet']['MORPHEUS_RELAYER_CALLER_ID'] = 'other'
                elif action == 'extra': overlays['mainnet']['UNREVIEWED'] = 'true'
                else: overlays['mainnet']['MORPHEUS_EMBEDDED_RELAYER'] = 'true'
            m, files, source, _, _ = fixture(relayer=True, mutate_public=mutate)
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'exact generated network map'):
                v.validate_bundle(v.encoded(m), files, source)

    def test_image_relayer_gate_is_exact_and_rehashed(self):
        for enabled in (False, True):
            m, files, source, evidence, context = fixture(relayer=enabled)
            v.validate_build_evidence(evidence, m, context, v.inventory(source))
            for value in (None, '', True, False, 'TRUE', str(not enabled).lower()):
                altered = copy.deepcopy(evidence)
                if value is None: del altered['builds'][0]['environment']['MORPHEUS_EMBEDDED_RELAYER']
                else: altered['builds'][0]['environment']['MORPHEUS_EMBEDDED_RELAYER'] = value
                altered['builds'][0]['environment_sha256'] = v.sha(v.encoded(altered['builds'][0]['environment']))
                with self.subTest(enabled=enabled, value=value), self.assertRaises(ValueError):
                    v.validate_build_evidence(altered, m, context, v.inventory(source))
            for malformed in (None, False, 0, [], {}):
                altered = copy.deepcopy(evidence)
                altered['builds'][0]['environment']['MORPHEUS_NETWORK_PROFILES_JSON'] = malformed
                altered['builds'][0]['environment_sha256'] = v.sha(v.encoded(altered['builds'][0]['environment']))
                with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                    v.validate_build_evidence(altered, m, context, v.inventory(source))
            altered = copy.deepcopy(evidence)
            altered['builds'][0]['environment']['UNREVIEWED'] = 'false'
            altered['builds'][0]['environment_sha256'] = v.sha(v.encoded(altered['builds'][0]['environment']))
            with self.assertRaises(ValueError):
                v.validate_build_evidence(altered, m, context, v.inventory(source))

    def test_price_plane_independent_validator_accepts_explicit_network_choices(self):
        for selected in ({}, {'mainnet': 'public-quorum'}, {'testnet': 'public-quorum'},
                         {'mainnet': 'twelvedata', 'testnet': 'public-quorum'},
                         {'mainnet': 'public-quorum', 'testnet': 'public-quorum'}):
            m, files, source, _, _ = fixture(price_planes=selected)
            with self.subTest(selected=selected):
                self.assertEqual(v.validate_bundle(v.encoded(m), files, source), m)

    def test_price_plane_independent_validator_refuses_present_invalid_values(self):
        for network in v.NETWORKS:
            for value in (None, False, True, 0, 1, [], {}, '', ' ', 'PUBLIC-QUORUM',
                          ' public-quorum', 'public-quorum ', 'public_quorum', 'unknown'):
                m, files, source, _, _ = fixture(price_planes={network: value})
                with self.subTest(network=network, value=value), self.assertRaises(ValueError):
                    v.validate_bundle(v.encoded(m), files, source)

    def test_price_plane_map_substitution_refuses_after_every_outer_hash_is_updated(self):
        for action in ('missing', 'wrong', 'swapped', 'ambient'):
            def mutate(s, p, overlays, source):
                if action == 'missing': del overlays['mainnet']['FEED_PRICE_PLANE']
                elif action == 'wrong': overlays['mainnet']['FEED_PRICE_PLANE'] = 'twelvedata'
                elif action == 'swapped':
                    overlays['mainnet']['FEED_PRICE_PLANE'], overlays['testnet']['FEED_PRICE_PLANE'] = (
                        overlays['testnet']['FEED_PRICE_PLANE'], overlays['mainnet']['FEED_PRICE_PLANE'])
                else: overlays['mainnet']['FEED_PRICE_PLANE'] = 'ambient-must-not-inherit'
            m, files, source, _, _ = fixture(mutate_public=mutate,
                price_planes={'mainnet': 'public-quorum', 'testnet': 'twelvedata'})
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'exact generated network map'):
                v.validate_bundle(v.encoded(m), files, source)

    def test_selected_rpc_alias_is_explicit_in_the_independent_public_fixture(self):
        _, files, _, _, _ = fixture()
        mapping = v.parse(next(data for name, (_, data) in files.items()
                               if name.endswith('/network-profiles.json')))
        for network in v.NETWORKS:
            key = 'NEO_RPC_URLS_' + network.upper()
            self.assertEqual(mapping[network][key], 'https://n3.example.invalid/' + network)
            other = 'testnet' if network == 'mainnet' else 'mainnet'
            self.assertNotIn('NEO_RPC_URLS_' + other.upper(), mapping[network])

    def test_selected_rpc_alias_substitution_refuses_after_outer_hashes_are_updated(self):
        for action in ('missing', 'wrong', 'other-network'):
            def mutate(spec, profiles, overlays, source):
                key = 'NEO_RPC_URLS_MAINNET'
                if action == 'missing': del overlays['mainnet'][key]
                elif action == 'wrong': overlays['mainnet'][key] = 'https://foreign.example.invalid'
                else:
                    del overlays['mainnet'][key]
                    overlays['mainnet']['NEO_RPC_URLS_TESTNET'] = spec['networks']['testnet']['neo_n3_rpc']
            m, files, source, _, _ = fixture(mutate_public=mutate)
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'exact generated network map'):
                v.validate_bundle(v.encoded(m), files, source)

    def test_enrollment_bundle_matches_actual_builder_public_outputs(self):
        m, files, source, _, context = fixture(enrollment=True)
        docs = {name.rsplit('/', 1)[-1]: data for name, (_, data) in files.items()}
        packaging = packaging_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ('public-input.json', 'mainnet.json', 'testnet.json', 'testnet-enrollment.json'):
                (root / name).write_bytes(docs[name])
            registry = {n: v.parse(source['config/networks/' + n + '.json'][1]) for n in v.NETWORKS}
            _, profiles, overlays = packaging.public_inputs(
                root / 'public-input.json', m['reviewed_input_sha256'], registry)
        self.assertEqual(packaging.encoded(overlays), docs['network-profiles.json'])
        self.assertEqual(set(profiles), {'mainnet', 'testnet', 'testnet-enrollment'})
        for name, data in profiles.items():
            self.assertEqual(data, docs[name + '.json'])
            self.assertEqual(v.sha(data), context['files']['public/custody/' + name + '.json'])
        self.assertEqual(v.validate_bundle(v.encoded(m), files, source), m)
        self.assertEqual(m['authority_admission'], 'separate-required')

    def reject_enrollment(self, mutation, message='enrollment'):
        m, files, source, _, _ = fixture(enrollment=True, mutate_enrollment=mutation)
        with self.assertRaisesRegex(ValueError, message):
            v.validate_bundle(v.encoded(m), files, source)

    def test_enrollment_semantics_rehashed_not_merely_stale_digests(self):
        for key, value in [('schema', 'wrong'), ('purpose', 'transport-token/v1'),
                           ('ceremony_id', '../wrong'), ('ceremony_id', '')]:
            with self.subTest(key=key, value=value):
                self.reject_enrollment(lambda m: m.__setitem__(key, value),
                    'invalid custody role ID' if key == 'ceremony_id' else 'invalid enrollment contract')
        profile = v.parse(public_fixture({})[0]['mainnet'])
        for key in ('environment', 'vault_id', 'networks', 'root_key_commitment', 'coordinator'):
            with self.subTest(destination=key):
                self.reject_enrollment(lambda m: m.__setitem__(key, profile[key]), 'enrollment destination mismatch')
        for key in ('custody_kms_key_arn', 'root_key_version'):
            self.reject_enrollment(lambda m: m.__setitem__(key, 'wrong'), 'enrollment destination mismatch')
        for key, value in [('id', '../wrong'), ('token_digest', '0'*64), ('label', ' spaced '),
                ('label', '\x7f'), ('label', 'x'*129), ('created_at_unix', True),
                ('created_at_unix', 0), ('created_at_unix', 2**63), ('auth_mode', 'none'),
                ('capabilities', []), ('capabilities', ['admin', 'sign']), ('key_grant', 'none'),
                ('allowed_origins', ['https://unit.example.invalid']), ('disabled', True), ('disabled', 0)]:
            with self.subTest(caller=key, value=value):
                self.reject_enrollment(lambda m: m['caller'].__setitem__(key, value),
                    'invalid custody role ID' if key == 'id' else 'invalid digest' if key == 'token_digest' else 'enrollment')

    def test_enrollment_containers_and_exact_field_sets(self):
        for value in (None, True, 1, 'wrong', []):
            with self.subTest(value=value):
                self.reject_enrollment(lambda m: m.__setitem__('caller', value), 'unknown or missing fields')
                m, files, source, _, _ = fixture(enrollment=True, mutate_public=
                    lambda s,p,o,src: s['networks']['testnet'].__setitem__('enrollment', value))
                with self.assertRaisesRegex(ValueError, 'unknown or missing fields'):
                    v.validate_bundle(v.encoded(m), files, source)
        for target in ('manifest', 'caller'):
            _, files, _, _, _ = fixture(enrollment=True)
            doc = v.parse(next(data for name, (_, data) in files.items() if name.endswith('/testnet-enrollment.json')))
            keys = doc if target == 'manifest' else doc['caller']
            for key in (*keys, 'unexpected'):
                def mutate(m):
                    node = m if target == 'manifest' else m['caller']
                    if key == 'unexpected': node[key] = True
                    else: del node[key]
                with self.subTest(target=target, key=key):
                    self.reject_enrollment(mutate, 'unknown or missing fields')
        for key in ('mode', 'manifest_file', 'manifest_sha256', 'unexpected'):
            def mutate(s,p,o,src):
                node = s['networks']['testnet']['enrollment']
                if key == 'unexpected': node[key] = True
                else: del node[key]
            m, files, source, _, _ = fixture(enrollment=True, mutate_public=mutate)
            with self.subTest(spec=key), self.assertRaisesRegex(ValueError, 'unknown or missing fields'):
                v.validate_bundle(v.encoded(m), files, source)

    def test_enrollment_opt_in_network_mode_filename_and_profile_digest(self):
        changes = [
            (lambda s,p,o,src: s['networks']['mainnet'].__setitem__('enrollment', s['networks']['testnet']['enrollment']), 'explicit TestNet'),
            (lambda s,p,o,src: (s['networks']['testnet']['enrollment'].__setitem__('mode', 'restore'),
                o['testnet'].__setitem__('MORPHEUS_CUSTODY_ENROLLMENT_MODE', 'restore')), 'explicit TestNet'),
            (lambda s,p,o,src: p['testnet'].__setitem__('release_policy_version', 'wrong'), 'enrollment profile digest'),
            (lambda s,p,o,src: s['networks']['testnet']['enrollment'].__setitem__('manifest_sha256', '0'*64), 'invalid digest')]
        for filename in ('mainnet-enrollment.json', '../testnet-enrollment.json', '/testnet-enrollment.json',
                         'sub/testnet-enrollment.json', 'testnet-enrollment.json/..'):
            changes.append((lambda s,p,o,src, name=filename: s['networks']['testnet']['enrollment'].__setitem__('manifest_file', name), 'fixed basename'))
        for mutate, message in changes:
            m, files, source, _, _ = fixture(enrollment=True, mutate_public=mutate)
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                v.validate_bundle(v.encoded(m), files, source)
        def remove_opt_in(s,p,o,src):
            del s['networks']['testnet']['enrollment']
            for k in list(o['testnet']):
                if k.startswith('MORPHEUS_CUSTODY_ENROLLMENT_'): del o['testnet'][k]
        m, files, source, _, _ = fixture(enrollment=True, mutate_public=remove_opt_in)
        with self.assertRaisesRegex(ValueError, 'bundle enrollment opt-in mismatch'):
            v.validate_bundle(v.encoded(m), files, source)

    def test_enrollment_overlay_is_exact_and_testnet_only(self):
        for key in ('MORPHEUS_CUSTODY_ENROLLMENT_MODE', 'MORPHEUS_CUSTODY_ENROLLMENT_FILE', 'MORPHEUS_CUSTODY_ENROLLMENT_SHA256'):
            for action in ('remove', 'wrong', 'mainnet'):
                def mutate(s,p,o,src):
                    if action == 'remove': del o['testnet'][key]
                    elif action == 'wrong': o['testnet'][key] = 'wrong'
                    else: o['mainnet'][key] = o['testnet'][key]
                m, files, source, _, _ = fixture(enrollment=True, mutate_public=mutate)
                with self.subTest(key=key, action=action), self.assertRaisesRegex(ValueError, 'exact generated network map'):
                    v.validate_bundle(v.encoded(m), files, source)

    def test_enrollment_raw_byte_digest_size_and_json_boundaries(self):
        for size in (16384, 16385):
            m, files, source, _, _ = fixture(enrollment=True,
                enrollment_encoder=lambda value: v.encoded(value).ljust(size, b' '))
            with self.subTest(size=size):
                if size == 16384: self.assertEqual(v.validate_bundle(v.encoded(m), files, source), m)
                else:
                    with self.assertRaisesRegex(ValueError, 'enrollment manifest exceeds bound'):
                        v.validate_bundle(v.encoded(m), files, source)
        m, files, source, _, _ = fixture(enrollment=True)
        name = next(n for n in files if n.endswith('/testnet-enrollment.json'))
        files[name] = ('100644', files[name][1] + b' ')
        # Outer file hash is refreshed, but reviewed input/profile pin the old bytes.
        m['public_bundle_files'][name] = v.sha(files[name][1])
        with self.assertRaisesRegex(ValueError, 'enrollment manifest digest mismatch'):
            v.validate_bundle(v.encoded(m), files, source)
        for raw in (b'{}', b'null', b'[]', b'{"schema":1,"schema":2}', b'{"x":NaN}'):
            m, files, source, _, _ = fixture(enrollment=True, enrollment_encoder=lambda _: raw)
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                v.validate_bundle(v.encoded(m), files, source)

    def test_enrollment_missing_extra_traversal_modes_and_unlisted_files(self):
        for enrollment in (False, True):
            for extra in ('mainnet-enrollment.json', 'extra.json', '../escape.json', 'sub/testnet-enrollment.json'):
                for listed in (False, True):
                    m, files, source, _, _ = fixture(enrollment=enrollment)
                    name = 'deploy/nitro/releases/' + m['release'] + '/' + extra
                    files[name] = ('100644', b'{}')
                    if listed: m['public_bundle_files'][name] = v.sha(b'{}')
                    with self.subTest(enrollment=enrollment, extra=extra, listed=listed), self.assertRaises(ValueError):
                        v.validate_bundle(v.encoded(m), files, source)
        for action in ('physical-missing', 'unlisted', 'undeclared-and-missing', 'symlink', 'executable', 'tamper'):
            m, files, source, _, _ = fixture(enrollment=True)
            name = next(n for n in files if n.endswith('/testnet-enrollment.json'))
            if action in ('physical-missing', 'undeclared-and-missing'): del files[name]
            if action in ('unlisted', 'undeclared-and-missing'): del m['public_bundle_files'][name]
            if action in ('symlink', 'executable'): files[name] = ('120000' if action == 'symlink' else '100755', files[name][1])
            if action == 'tamper': files[name] = ('100644', files[name][1] + b' ')
            with self.subTest(action=action), self.assertRaises(ValueError):
                v.validate_bundle(v.encoded(m), files, source)

    def test_context_generated_enrollment_and_fixed_files_are_bound(self):
        for name in ('public/custody/testnet-enrollment.json', 'public/etc/hosts', 'public/etc/hostname'):
            for action in ('remove', 'digest', 'rename'):
                m, files, source, evidence, context = fixture(enrollment=True)
                if action == 'remove': del context['files'][name]
                elif action == 'digest': context['files'][name] = 'f'*64
                else: context['files']['public/custody/../escape.json'] = context['files'].pop(name)
                rebind_context(m, files, evidence, context)
                with self.subTest(name=name, action=action), self.assertRaisesRegex(ValueError, 'generated selected context closure'):
                    v.validate_bundle(v.encoded(m), files, source)

    def test_cross_context_requires_exact_lock_objects_checksums_and_recipe(self):
        for key, value in [('builder_platform', 'linux/amd64'), ('builder_platform', 'linux/ARM64'),
                           ('builder_platform', None), ('cross_lock_sha256', 'f'*64), ('extra', True)]:
            m, files, source, evidence, context = fixture(enrollment=True, cross=True)
            context[key] = value
            rebind_context(m, files, evidence, context)
            with self.subTest(key=key), self.assertRaises(ValueError):
                v.validate_bundle(v.encoded(m), files, source)
        for name in ('cross-inputs/debs/unit_1%3a1_arm64.deb', 'cross-inputs/rustlib/unit.rlib', 'cross-inputs/SHA256SUMS', 'Dockerfile'):
            for action in ('remove', 'digest', 'extra'):
                m, files, source, evidence, context = fixture(enrollment=True, cross=True)
                if action == 'remove': del context['files'][name]
                elif action == 'digest': context['files'][name] = 'f'*64
                else: context['files']['cross-inputs/debs/extra.deb'] = 'f'*64
                rebind_context(m, files, evidence, context)
                with self.subTest(name=name, action=action), self.assertRaisesRegex(ValueError, 'generated selected context closure'):
                    v.validate_bundle(v.encoded(m), files, source)
        for missing in ('builder_platform', 'cross_lock_sha256'):
            m, files, source, evidence, context = fixture(enrollment=True, cross=True)
            del context[missing]
            rebind_context(m, files, evidence, context)
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, 'unknown or missing fields'):
                v.validate_bundle(v.encoded(m), files, source)
        # A fully rehashed default recipe cannot masquerade as cross staging.
        m, files, source, evidence, context = fixture(enrollment=True, cross=True)
        map_bytes = v.encoded(v.parse(files[next(n for n in files if n.endswith('/network-profiles.json'))][1]))
        context['files']['Dockerfile'] = v.sha(source['deploy/nitro/Dockerfile.dual-enclave'][1].decode().replace(
            '# DUAL_NETWORK_ENV', 'ENV MORPHEUS_NETWORK_PROFILES_JSON=' + json.dumps(map_bytes.decode().strip())).encode())
        rebind_context(m, files, evidence, context)
        with self.assertRaisesRegex(ValueError, 'generated selected context closure'):
            v.validate_bundle(v.encoded(m), files, source)

    def test_cross_lock_rejects_malformed_paths_duplicates_and_pins(self):
        _, _, source, _, context = fixture(cross=True)
        lock_path = 'deploy/nitro/cross-inputs.lock.json'
        lock = v.parse(source[lock_path][1])
        mutations = [lambda p: p.__setitem__('objects', []),
                     lambda p: p.__setitem__('objects', {}),
                     lambda p: p.__setitem__('extra', True),
                     lambda p: p.__setitem__('schema', 'wrong'),
                     lambda p: p.__setitem__('target', 'aarch64-unknown-linux-gnu'),
                     lambda p: p.__setitem__('rust_version', None),
                     lambda p: p.__setitem__('builder_image', ''),
                     lambda p: p['objects'][0].__setitem__('extra', True),
                     lambda p: p['objects'][0].__setitem__('package', 'partial'),
                     lambda p: p['objects'].append(copy.deepcopy(p['objects'][0]))]
        for name in ('../x', '/cross-inputs/debs/x', 'cross-inputs/debs/../x',
                     'cross-inputs/debs//x', 'cross-inputs/debs/./x', 'cross-inputs/other/x',
                     'cross-inputs/debs', 'public/custody/testnet-enrollment.json'):
            mutations.append(lambda p, name=name: p['objects'][0].__setitem__('path', name))
        for key, value in [('sha256', '0'*64), ('size', True), ('size', 0), ('path', None)]:
            mutations.append(lambda p, key=key, value=value: p['objects'][0].__setitem__(key, value))
        for index, mutate in enumerate(mutations):
            changed = copy.deepcopy(lock); mutate(changed)
            data = v.encoded(changed)
            with self.subTest(index=index), self.assertRaises(ValueError):
                v.cross_context_files({**context, 'cross_lock_sha256': v.sha(data)},
                    {**source, lock_path: ('100644', data)})

    def test_current_public_cross_lock_matches_actual_inventory_and_checksum_order(self):
        # Read public pin metadata only. Substitute object acquisition; no real
        # cache bytes, native toolchains, downloads or builds are accessed.
        packaging = packaging_module()
        cross = packaging.cross_support()
        path = 'deploy/nitro/cross-inputs.lock.json'
        raw = (ROOT / path).read_bytes()
        pins = v.parse(raw)
        source = {path: ('100644', raw)}
        expected = v.cross_context_files({'builder_platform': 'linux/arm64',
            'cross_lock_sha256': v.sha(raw)}, source)
        with patch.object(cross, 'read_object', return_value=b'synthetic acquisition only') as acquire:
            actual = cross.cross_inputs({path: raw}, 'not-a-cache')
        self.assertEqual(acquire.call_count, len(pins['objects']))
        self.assertEqual(set(actual), set(expected))
        self.assertEqual(expected['cross-inputs/SHA256SUMS'], v.sha(actual['cross-inputs/SHA256SUMS']))
        for entry in pins['objects']:
            self.assertEqual(expected[entry['path']], entry['sha256'])
        pins['objects'].reverse()
        reversed_raw = v.encoded(pins)
        reversed_expected = v.cross_context_files({'builder_platform': 'linux/arm64',
            'cross_lock_sha256': v.sha(reversed_raw)}, {path: ('100644', reversed_raw)})
        self.assertNotEqual(expected['cross-inputs/SHA256SUMS'], reversed_expected['cross-inputs/SHA256SUMS'])
        self.assertEqual({k: val for k, val in expected.items() if k != 'cross-inputs/SHA256SUMS'},
                         {k: val for k, val in reversed_expected.items() if k != 'cross-inputs/SHA256SUMS'})

    def test_source_audit_invokes_enrollment_validation_and_stays_held(self):
        # Synthetic captured bytes only: no production receipt or measurement.
        for valid in (True, False):
            m, files, source, _, _ = fixture(enrollment=True, mutate_enrollment=
                None if valid else lambda manifest: manifest.__setitem__('purpose', 'transport-token/v1'))
            name = 'deploy/nitro/measurements/' + m['release'] + '.json'
            class SyntheticCapture:
                head = m['git_commit']
                base = m['base_main_commit']
                changes = [{'path': name, 'status': 'A'}]
                def snapshot(self, commit):
                    assert commit == m['git_commit']
                    return source
                def git(self, *args):
                    if args == ('merge-base', '--is-ancestor', m['git_commit'], self.head): return b''
                    if args == ('rev-parse', m['git_commit'] + '^{tree}'): return m['source_tree'].encode()
                    if args == ('archive', '--format=tar', m['git_commit']): return b'unit-only archive'
                    raise AssertionError(args)
            capture = SyntheticCapture()
            capture.files = {**source, **files, name: ('100644', v.encoded(m)),
                'apps/web/lib/nitro-dual-release-registry.ts': ('100644',
                    b'export const COMMITTED_DUAL_NITRO_MEASUREMENTS: readonly unknown[] = Object.freeze([]);')}
            errors, checks = gate.audit(capture)
            codes = [error['code'] for error in errors]
            with self.subTest(valid=valid):
                self.assertEqual('DUAL_RELEASE_INVALID' not in codes, valid, errors)
                self.assertIn('DUAL_ADMISSION_INTEGRATION_REQUIRED', codes)
                self.assertEqual(sum(check.get('complete') is False for check in checks), 3)

    def test_consistent_fixture_only_proves_byte_bindings(self):
        m,files,source,_,_=fixture()
        self.assertEqual(v.validate_bundle(v.encoded(m),files,source),m)
        self.assertNotIn('admitted',m)

    def reject_public(self, mutation):
        m, files, source, _, _ = fixture(mutation)
        # Every enclosing digest is recomputed: refusal must be semantic.
        with self.assertRaises(ValueError):
            v.validate_bundle(v.encoded(m), files, source)

    def test_unknown_and_missing_public_fields_at_each_level(self):
        def nodes(s,p,o):
            return [s, s['networks']['mainnet'], s['networks']['mainnet']['roles'], p['mainnet'],
                p['mainnet']['networks'][0], p['mainnet']['coordinator'], p['mainnet']['coordinator']['receipt_keys'][0], o['mainnet']]
        for index in range(8):
            for extra in (True,False):
                def change(s,p,o,source):
                    target=nodes(s,p,o)[index]
                    if extra: target['unexpected']='unit'
                    else: target.pop(next(k for k in target if k not in ('profile_sha256','MORPHEUS_CUSTODY_PROFILE_SHA256')))
                with self.subTest(index=index,extra=extra):self.reject_public(change)

    def test_profile_types_and_chain_registry_bindings(self):
        for key,value in [('profile_version',True),('snapshot_format_version',True),('signer_schema_version',True),
                          ('vault_id','0'*32),('root_key_commitment','0'*64),('environment','testnet')]:
            with self.subTest(key=key):
                self.reject_public(lambda s,p,o,src:p['mainnet'].__setitem__(key,value))
        for index in (0,1):
            for key,value in [('chain_family','wrong'),('chain_id',True),('chain_id',999),('genesis_hash','0x'+'0'*64)]:
                with self.subTest(index=index,key=key):
                    self.reject_public(lambda s,p,o,src:p['mainnet']['networks'][index].__setitem__(key,value))
        self.reject_public(lambda s,p,o,src:p['mainnet']['networks'][0].__setitem__('genesis_hash','0x'+'a'*64))

    def test_profile_cross_network_isolation(self):
        for key in ('vault_id','root_key_commitment'):
            self.reject_public(lambda s,p,o,src:p['testnet'].__setitem__(key,p['mainnet'][key]))
        for key in ('origin',):
            self.reject_public(lambda s,p,o,src:p['testnet']['coordinator'].__setitem__(key,p['mainnet']['coordinator'][key]))
        def snapshot(s,p,o,src):
            for k in ('snapshot_bucket','snapshot_prefix'):p['testnet']['coordinator'][k]=p['mainnet']['coordinator'][k]
        self.reject_public(snapshot)
        self.reject_public(lambda s,p,o,src:s['networks']['testnet'].__setitem__('workload_audience',s['networks']['mainnet']['workload_audience']))
        for destination in ('mainnet','testnet'):
            def same_role(s,p,o,src):
                role=s['networks']['mainnet']['roles']['UPDATER']
                s['networks'][destination]['roles']['WORKER']=role
                o[destination]['SIGNER_ROLE_WORKER_KEY_ID']=role
            self.reject_public(same_role)

    def test_public_urls_kms_and_receipt_shapes(self):
        for url in ['http://rpc.example.invalid','https://user@rpc.example.invalid','https://rpc.example.invalid:443',
                    'https://127.0.0.1','https://rpc.internal','https://rpc.example.invalid?q=x',
                    'https://rpc.example.invalid/../x','https://rpc.example.invalid/%2e','https://rpc.example.invalid/\\x']:
            with self.subTest(url=url):self.reject_public(lambda s,p,o,src:s['networks']['mainnet'].__setitem__('neo_n3_rpc',url))
        self.reject_public(lambda s,p,o,src:s['networks']['mainnet'].__setitem__('frontier_kms_key_arn','alias/unit'))
        self.reject_public(lambda s,p,o,src:p['mainnet']['coordinator'].__setitem__('aws_region','eu-west-1'))
        self.reject_public(lambda s,p,o,src:p['mainnet']['coordinator'].__setitem__('snapshot_prefix','../x'))
        self.reject_public(lambda s,p,o,src:p['mainnet']['coordinator'].__setitem__('receipt_keys',[]))
        self.reject_public(lambda s,p,o,src:p['mainnet']['coordinator']['receipt_keys'].append(p['mainnet']['coordinator']['receipt_keys'][0]))
        self.reject_public(lambda s,p,o,src:p['mainnet']['coordinator']['receipt_keys'][0].__setitem__('public_key_sec1_hex','04'+'0'*128))

    def test_malformed_public_containers_raise_typed_refusal(self):
        _,files,source,_,_=fixture()
        docs={name.rsplit('/',1)[-1]:v.parse(data) for name,(_,data) in files.items()}
        paths=[['public-input.json'], ['public-input.json','networks'],
               ['public-input.json','networks','mainnet'], ['public-input.json','networks','mainnet','roles'],
               ['mainnet.json'], ['mainnet.json','networks'], ['mainnet.json','networks',0],
               ['mainnet.json','coordinator'], ['mainnet.json','coordinator','receipt_keys'],
               ['mainnet.json','coordinator','receipt_keys',0], ['network-profiles.json']]
        for path in paths:
            for value in (None,True,1,'wrong',[]):
                changed=copy.deepcopy(docs);node=changed
                for key in path[:-1]:node=node[key]
                node[path[-1]]=value
                with self.subTest(path=path,value=value),self.assertRaises(ValueError):
                    v.validate_public_inputs(changed,source)
        for url in ['https://rpc.example.invalid/\tpath','https://rpc.example.invalid/\x00path']:
            self.reject_public(lambda s,p,o,src:s['networks']['mainnet'].__setitem__('neo_n3_rpc',url))

    def test_every_generated_overlay_value_is_bound(self):
        _,_,overlays=public_fixture({})
        for key in overlays['mainnet']:
            if key=='MORPHEUS_CUSTODY_PROFILE_SHA256':continue  # Recomputed by fixture; raw digest test covers it.
            with self.subTest(key=key):self.reject_public(lambda s,p,o,src:o['mainnet'].__setitem__(key,'wrong'))

    def test_strict_json(self):
        for data in (b'{"x":1,"x":2}',b'{"x":{"y":1,"y":2}}',b'{"x":NaN}',b'\xff',b'['*2000):
            with self.subTest(data=data[:30]),self.assertRaises(ValueError):v.parse(data)

    def test_manifest_controls(self):
        m,*_=fixture()
        controls=[('schema','wrong'),('pcr0','0'*96),('git_commit','HEAD'),('authority_admission','waived'),
                  ('supersedes',[m['release']]),('eif_size_bytes',True),('built_at','2026-02-30T00:00:00Z'),
                  ('candidate_ref','refs/heads/main'),('unknown',True),('reproducible_verified',1),
                  ('networks',['mainnet']),('app_ids',['morpheus-oracle'])]
        for key,value in controls:
            with self.subTest(key=key),self.assertRaises((ValueError,TypeError)):
                v.validate_manifest({**m,key:value})

    def test_public_file_missing_tamper_mode_and_extra(self):
        m,files,source,*_=fixture()
        for name in files:
            for mode,data in [('120000',files[name][1]),('100755',files[name][1]),('100644',files[name][1]+b' ' )]:
                altered={**files,name:(mode,data)}
                with self.subTest(name=name,mode=mode),self.assertRaises(ValueError):v.validate_bundle(v.encoded(m),altered,source)
            altered=dict(files);del altered[name]
            with self.assertRaises(ValueError):v.validate_bundle(v.encoded(m),altered,source)
        with self.assertRaises(ValueError):v.validate_manifest({**m,'public_bundle_files':{**m['public_bundle_files'],'../escape':'a'*64}})

    def test_source_closure_and_modes(self):
        m,files,source,*_=fixture()
        for name in source:
            changed=dict(source);changed[name]=('100755',source[name][1])
            with self.subTest(name=name),self.assertRaises(ValueError):v.validate_bundle(v.encoded(m),files,changed)
        for name in ['crates/new.rs','workers/neo-signer/new.rs','vendor/added.txt']:
            with self.assertRaises(ValueError):v.validate_bundle(v.encoded(m),files,{**source,name:('100644',b'added')})
        changed=dict(source);del changed['Cargo.lock']
        with self.assertRaises(ValueError):v.validate_bundle(v.encoded(m),files,changed)

    def test_every_selected_family_and_recipe(self):
        for name in (*v.SOURCE_FILES,*v.RECIPE_FILES,'vendor/a','crates/a','workers/neo-signer/a',
                     'workers/nitro-enclave-host/a','workers/neo-os-relayer/a'):
            self.assertTrue(v.affected(name),name)
        for name in ['README.md','apps/web/a.ts','workers/other/a','crates-other/x']:
            self.assertFalse(v.affected(name),name)

    def test_source_selector_matches_actual_packaging_inputs(self):
        spec = importlib.util.spec_from_file_location(
            'dual_packaging', ROOT / 'deploy/nitro/build-dual-enclave.py')
        packaging = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packaging)
        # Compare the independently maintained selectors against the actual
        # tracked tree, plus future descendants and near-miss path boundaries.
        names = subprocess.check_output(
            ['git', '-C', str(ROOT), 'ls-files', '-z']).decode().split('\0')
        names.extend(prefix + 'future-input.rs' for prefix in packaging.SOURCE_DIRS)
        names.extend(['crates-other/input.rs', 'workers/neo-signer-other/input.rs',
                      'deploy/nitro/Dockerfile.dual-enclave.cross.bak',
                      'deploy/nitro/cross-inputs.lock.json.bak',
                      'deploy/nitro/dual_cross.py.bak', 'apps/web/example.ts'])
        for name in names:
            if name:
                with self.subTest(name=name):
                    self.assertEqual(v.selected(name), packaging.wanted_source(name))
                    if packaging.wanted_source(name):
                        self.assertTrue(v.affected(name))

    def test_cross_build_inputs_bind_bytes_modes_and_required_closure(self):
        names = ('deploy/nitro/Dockerfile.dual-enclave.cross',
                 'deploy/nitro/cross-inputs.lock.json', 'deploy/nitro/dual_cross.py')
        class CaptureFixture:
            pass
        for name in names:
            with self.subTest(name=name):
                data = (ROOT / name).read_bytes()
                original = {name: ('100644', data)}
                self.assertTrue(v.affected(name))
                self.assertEqual(v.inventory(original), [
                    {'path': name, 'mode': '100644', 'size': len(data),
                     'sha256': v.sha(data)}])
                self.assertNotEqual(v.inventory(original), v.inventory({
                    name: ('100644', data + b'\nchanged\n')}))
                self.assertNotEqual(v.inventory(original), v.inventory({
                    name: ('100755', data)}))
                self.assertNotEqual(v.inventory(original), v.inventory({}))
                with self.assertRaises(ValueError):
                    v.inventory({name: ('120000', data)})
                capture = CaptureFixture()
                capture.files = {p: ('100644', b'unit-only')
                                 for p in (*v.SOURCE_FILES, *v.RECIPE_FILES)}
                capture.files['apps/web/lib/nitro-dual-release-registry.ts'] = (
                    '100644', b'export const COMMITTED_DUAL_NITRO_MEASUREMENTS: readonly unknown[] = Object.freeze([]);')
                capture.changes = [{'path': name, 'status': 'M'}]
                errors, _ = gate.audit(capture)
                self.assertIn('DUAL_SELECTED_INPUT_MEASUREMENT_ABSENT',
                              [error['code'] for error in errors])
                capture.files.pop(name)
                errors, _ = gate.audit(capture)
                self.assertIn({'code': 'DUAL_BUILD_INPUT_MISSING', 'message': name}, errors)

    def test_inventory_rejects_links_private_paths_and_binds_bytes(self):
        for name in ['crates/.env.local','vendor/keys/a','crates/a.pem']:
            with self.assertRaises(ValueError):v.inventory({name:('100644',b'x')})
        with self.assertRaises(ValueError):v.inventory({'Cargo.lock':('120000',b'target')})
        self.assertNotEqual(v.inventory({'Cargo.lock':('100644',b'a')}),v.inventory({'Cargo.lock':('100644',b'b')}))

    def test_actual_build_evidence_cross_bindings(self):
        m,_,source,e,context=fixture()
        changes=[('pcrs',{'PCR0':'a'*96}),('describe_pcrs',{}),('profile_sha256',{}),('map_sha256','a'*64),
                 ('rust_preparation',{}),('environment',{}),('environment_sha256','a'*64),('eif_sha256','a'*64),('eif_size_bytes',0),('toolchain_sha256',''),('extra',True)]
        for key,value in changes:
            altered=copy.deepcopy(e);altered['builds'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):v.validate_build_evidence(altered,m,context,v.inventory(source))
        for change in [{'published_build_index':1},{'builds':[e['builds'][0]]},{'selected_source_manifest':[]},
                       {'tool_bundle_sha256':'a'*64},{'status':'admitted'},{'schema':'neoos/dual-image-build-evidence/v1'}]:
            with self.assertRaises(ValueError):v.validate_build_evidence({**e,**change},m,context,v.inventory(source))
        altered=copy.deepcopy(e);altered['builds'][1]['describe_pcrs']['PCR2']='a'*96
        with self.assertRaises(ValueError):v.validate_build_evidence(altered,m,context,v.inventory(source))

    def test_source_gate_refuses_measurement_absence_and_missing_packaging_separately(self):
        class C:pass
        c=C();c.files={'apps/web/lib/nitro-dual-release-registry.ts':('100644',b'export const COMMITTED_DUAL_NITRO_MEASUREMENTS: readonly unknown[] = Object.freeze([]);')}
        c.changes=[{'path':'crates/example.rs','status':'M','old_mode':'100644','new_mode':'100644'}]
        errors,checks=gate.audit(c)
        self.assertIn('DUAL_SELECTED_INPUT_MEASUREMENT_ABSENT',[e['code'] for e in errors])
        self.assertIn('DUAL_BUILD_INPUT_MISSING',[e['code'] for e in errors])
        self.assertEqual(len([x for x in checks if x.get('status')=='NOT_EVALUABLE_MISSING_MEASUREMENT']),3)

    def test_present_invalid_dual_is_not_excused_as_absence(self):
        class C:pass
        c=C();name='deploy/nitro/measurements/bad.json'
        c.files={name:('100644',v.encoded({'schema':'neoos/dual-enclave-release/v1','release':'bad'}))}
        c.changes=[{'path':'Cargo.toml','status':'M'},{'path':name,'status':'A'}]
        c.snapshot=lambda _:{}
        errors,_=gate.audit(c);codes=[e['code'] for e in errors]
        self.assertIn('DUAL_RELEASE_INVALID',codes)
        self.assertNotIn('DUAL_SELECTED_INPUT_MEASUREMENT_ABSENT',codes)
        self.assertIn('DUAL_ADMISSION_INTEGRATION_REQUIRED',codes)

    def test_malformed_added_measurement_is_not_absent(self):
        class C:pass
        c=C();name='deploy/nitro/measurements/bad.json'
        c.files={name:('100644',b'{"schema":')};c.changes=[{'path':'Cargo.toml','status':'M'},{'path':name,'status':'A'}]
        errors,_=gate.audit(c);codes=[e['code'] for e in errors]
        self.assertIn('MANIFEST_JSON_INVALID',codes)
        self.assertNotIn('DUAL_SELECTED_INPUT_MEASUREMENT_ABSENT',codes)

    def test_cli_requires_base(self):
        cli=ROOT/'scripts/check-dual-release.mjs'
        no_base=subprocess.run(['node',str(cli)],capture_output=True,text=True)
        self.assertNotEqual(no_base.returncode,0)

    def test_cli_never_invents_a_complete_receipt_or_success(self):
        class FakeCapture:
            def __init__(self, root, base): pass
            def recheck(self): pass
            def receipt(self): return {'test_only': True}
        with patch.dict(sys.modules, {'dual_release_execution': object()}), \
             patch.object(gate.sys, 'flags', type('Flags', (), {'isolated': 1, 'no_site': 1})()), \
             patch.object(gate, 'Capture', FakeCapture), patch.object(gate, 'audit', return_value=([], [])), \
             patch.object(sys, 'argv', ['gate', '--base', 'a'*40]):
            from contextlib import redirect_stdout
            import io
            out=io.StringIO()
            with redirect_stdout(out): code=gate.main()
            report=json.loads(out.getvalue())
            self.assertEqual(code,1)
            self.assertFalse(report['complete']);self.assertFalse(report['passed'])
            self.assertFalse(report['full_admission'])



if __name__=='__main__':unittest.main()

"""Unit fixtures only. No fixture is written under the production measurement registry."""
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
            'NEO_RPC_URL': spec['neo_n3_rpc'], 'NEOX_RPC_URL': spec['neo_x_rpc'], 'NEOX_RPC': spec['neo_x_rpc'],
            'EVM_RPC_URL': spec['neo_x_rpc'], 'AWS_REGION': spec['aws_region'], 'FRONTIER_KMS_KEY_ARN': spec['frontier_kms_key_arn'],
            **{'SIGNER_ROLE_'+r+'_KEY_ID': spec['roles'][r] for r in ROLES}}
    return profiles, specs, overlays


def fixture(mutate_public=None):
    # Reuse recorded public PCRs, never invent or register production measurements.
    old = v.parse((ROOT / 'deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.10.json').read_bytes())
    source = {p: ('100644', b'unit fixture only\n') for p in (*v.SOURCE_FILES, *v.RECIPE_FILES)}
    source['deploy/nitro/Dockerfile.dual-enclave'] = ('100644', b'FROM fixture\n# DUAL_NETWORK_ENV\n')
    release = 'unit-fixture-not-admitted'
    prefix = 'deploy/nitro/releases/' + release + '/'
    profiles, specs, overlays = public_fixture(source)
    spec = {'schema': 'neoos/dual-image-input/v1', 'release': release, 'source_commit': 'a'*40, 'networks': specs}
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
    files['public/network-profiles.json'] = v.sha(map_bytes)
    files['Dockerfile'] = v.sha(source['deploy/nitro/Dockerfile.dual-enclave'][1].decode().replace(
        '# DUAL_NETWORK_ENV', 'ENV MORPHEUS_NETWORK_PROFILES_JSON='+json.dumps(map_bytes.decode().strip())).encode())
    context = {'schema': 'neoos/dual-image-context/v1', 'release': release, 'git_commit':'a'*40,
        'source_archive_sha256':'b'*64,'reviewed_input_sha256':v.sha(v.encoded(spec)),
        'map_sha256':v.sha(map_bytes),'networks':v.NETWORKS,'files':files,'status':'fixture only, not admission'}
    docs = {'public-input.json':v.encoded(spec), **{n+'.json':profiles[n] for n in v.NETWORKS},
            'network-profiles.json':map_bytes,'context-manifest.json':v.encoded(context),
            'candidate-publication.json':v.encoded({'fixture':'not publication evidence'})}
    m = {'schema':'neoos/dual-enclave-release/v1','release':release,'git_commit':'a'*40,
         'source_tree':'b'*40,'base_main_commit':'c'*40,'candidate_ref':'refs/tags/neoos-dual-candidate/'+'a'*40,
         'candidate_publication_sha256':v.sha(docs['candidate-publication.json']),
         'build_evidence_path':prefix+'candidate-build-evidence.json','build_evidence_sha256':'d'*64,
         'public_bundle_files':{},'reviewed_input_sha256':v.sha(docs['public-input.json']),
         'source_archive_sha256':'b'*64,'context_manifest_sha256':v.sha(docs['context-manifest.json']),
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
            'MORPHEUS_ALLOW_EPHEMERAL_KEY':'0','MORPHEUS_NETWORK_PROFILES_JSON':map_bytes.decode()},
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


class Validation(unittest.TestCase):
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

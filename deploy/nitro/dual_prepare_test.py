"""Execute the real Rust preparation binary with public synthetic fixtures."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
sys.dont_write_bytecode = True
from dual_image_test import Packaging, dual

HELPER = Path(sys.argv[1]).resolve()
del sys.argv[1]


class RustPreparation(Packaging):
    def map_file(self):
        _, _, overlays = self.validate()
        for n in dual.NETWORKS:
            overlays[n]['MORPHEUS_CUSTODY_PROFILE_FILE'] = str(self.root / (n+'.json'))
            overlays[n]['MORPHEUS_CUSTODY_DATA_DIR'] = str(self.root / 'state' / n)
        path = self.root / 'map.json'; path.write_bytes(dual.encoded(overlays))
        return path, overlays

    def call(self, path):
        result = subprocess.run([str(HELPER), str(path)], env={'PATH':'/usr/bin:/bin', 'MORPHEUS_NETWORK_PROFILES_JSON':'ambient-must-be-ignored', 'AWS_SECRET_ACCESS_KEY':'synthetic-canary'}, capture_output=True, timeout=5)
        self.assertFalse((self.root/'state').exists(), 'preparation must not create state')
        self.assertNotIn(b'synthetic-canary',result.stdout+result.stderr)
        return result

    def test_rust_positive_exact_receipt(self):
        path,_ = self.map_file(); result=self.call(path)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),{'schema':'neoos/dual-custody-build/v1','networks':list(dual.NETWORKS),'map_sha256':dual.sha(path.read_bytes())})

    def test_rust_invalid_curve_point_rejected_by_authoritative_parser(self):
        self.profiles['testnet']['coordinator']['receipt_keys'][0]['public_key_sec1_hex']='04'+'00'*64
        self.write();path,_=self.map_file()
        self.assertNotEqual(self.call(path).returncode,0)

    def test_rust_roles_match_native_route(self):
        path, original = self.map_file()
        for value in ('mainnet.worker', 'a/b', 'a%2fb', 'é', '', 'a' * 129):
            bad = json.loads(json.dumps(original))
            bad['mainnet']['SIGNER_ROLE_WORKER_KEY_ID'] = value
            path.write_bytes(dual.encoded(bad))
            with self.subTest(value=value): self.assertNotEqual(self.call(path).returncode, 0)
        for value in ('mainnet-worker', '_worker', 'a' * 128):
            good = json.loads(json.dumps(original))
            good['mainnet']['SIGNER_ROLE_WORKER_KEY_ID'] = value
            path.write_bytes(dual.encoded(good))
            with self.subTest(value=value): self.assertEqual(self.call(path).returncode, 0)

    def test_rust_relayer_public_profiles_are_validated_without_booting(self):
        for network in dual.NETWORKS:
            self.input['networks'][network]['relayer'] = {
                'state_file': f'/var/lib/neoos-relayer/{network}/state.json',
                'instance_id': f'{network}-instance', 'caller_id': f'{network}-caller',
                'store_url': 'https://store.example', 'store_api_key': 'sb_publishable_' + 'a' * 40,
                'issuer': 'https://issuer.example/auth/v1', 'mode': 'combined',
                'active_chains': ['neo_n3', 'neox'], 'feed_sync_enabled': True,
            }
        self.write()
        path, original = self.map_file()
        self.assertEqual(self.call(path).returncode, 0)
        for field, value in [('MORPHEUS_RELAYER_STORE_URL', 'https://user:pass@store.example'),
                             ('MORPHEUS_RELAYER_STORE_API_KEY', 'sb_secret_' + 'a' * 40),
                             ('MORPHEUS_RELAYER_CALLER_ID', original['testnet']['MORPHEUS_RELAYER_CALLER_ID'])]:
            bad = json.loads(json.dumps(original))
            bad['mainnet'][field] = value
            path.write_bytes(dual.encoded(bad))
            with self.subTest(field=field):
                self.assertNotEqual(self.call(path).returncode, 0)
        bad = json.loads(json.dumps(original))
        del bad['mainnet']['MORPHEUS_RELAYER_STATE_FILE']
        path.write_bytes(dual.encoded(bad))
        self.assertNotEqual(self.call(path).returncode, 0)

    def test_rust_map_boundaries(self):
        path,original=self.map_file()
        for key,value in [('MORPHEUS_CUSTODY_PROFILE_SHA256','00'*32),('SIGNER_SERVICE_URL','http://127.0.0.1:0/mainnet'),('MORPHEUS_CUSTODY_DATA_DIR',original['mainnet']['MORPHEUS_CUSTODY_DATA_DIR']),('MORPHEUS_CUSTODY_WORKLOAD_AUDIENCE','HTTPS://CUSTODY-MAINNET.EXAMPLE:443/')]:
            bad=json.loads(json.dumps(original));bad['testnet'][key]=value;path.write_bytes(dual.encoded(bad))
            with self.subTest(key=key):self.assertNotEqual(self.call(path).returncode,0)
        for raw in (b'{"mainnet":{},"mainnet":{},"testnet":{}}',b'{"mainnet":{}}'):
            path.write_bytes(raw);self.assertNotEqual(self.call(path).returncode,0)
        bad=json.loads(json.dumps(original));bad['mainnet']['NODE_ENV']='development';path.write_bytes(dual.encoded(bad))
        self.assertNotEqual(self.call(path).returncode,0)
        bad=json.loads(json.dumps(original));bad['mainnet']['MORPHEUS_CUSTODY_PROFILE_FILE']=original['testnet']['MORPHEUS_CUSTODY_PROFILE_FILE'];bad['mainnet']['MORPHEUS_CUSTODY_PROFILE_SHA256']=original['testnet']['MORPHEUS_CUSTODY_PROFILE_SHA256'];path.write_bytes(dual.encoded(bad))
        self.assertNotEqual(self.call(path).returncode,0)


if __name__=='__main__':
    suite=unittest.TestSuite(RustPreparation(name) for name in ('test_rust_positive_exact_receipt','test_rust_invalid_curve_point_rejected_by_authoritative_parser','test_rust_map_boundaries','test_rust_roles_match_native_route','test_rust_relayer_public_profiles_are_validated_without_booting'))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())

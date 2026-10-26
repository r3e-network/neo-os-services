"""Finite source/build-closure guards; these do not execute SQL or Rust."""
from pathlib import Path
import copy
import re
import sys
import unittest
sys.dont_write_bytecode = True
import dual_image_test as fixtures

dual = fixtures.dual

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'db/services/migrations/20261026090000_relayer_delivery_caller_scope.sql'


class EmbeddedRelayerSourceContract(unittest.TestCase):
    def test_builder_links_real_library_sources(self):
        manifest = (ROOT / 'workers/nitro-enclave-host/Cargo.toml').read_text()
        self.assertRegex(manifest, r'neo-os-relayer\s*=\s*\{[^}]*path')
        for name in ['Dockerfile.dual-enclave', 'Dockerfile.dual-enclave.cross']:
            recipe = (ROOT / 'deploy/nitro' / name).read_text()
            for directory in ['workers/neo-os-relayer/src', 'crates/neo-os-chain-n3/src', 'crates/neo-os-relayer-store/src']:
                self.assertIn('COPY ' + directory + ' ' + directory, recipe)

    def test_scoped_rpc_is_a_closed_six_function_contract(self):
        sql = MIGRATION.read_text()
        functions = re.findall(r'create function neoos_relayer_v2\.morpheus_delivery_([a-z_]+)\(', sql)
        self.assertEqual(set(functions), {'enqueue', 'claim', 'transition', 'checkpoint', 'feed_baseline', 'account_health'})
        self.assertEqual(len(functions), 6)
        self.assertIn("current_setting('role'", sql)
        self.assertIn("current_setting('request.jwt.claims'", sql)
        self.assertIn('for update', sql.lower())
        self.assertNotRegex(sql.lower(), r'grant\s+(select|insert|update|delete|all).*to neoos_relayer_caller')
        self.assertNotIn('to authenticator', sql.lower())

    def test_running_store_client_has_no_process_global_credentials(self):
        source = (ROOT / 'workers/neo-os-relayer/src/durable_v2.rs').read_text()
        client = source[source.index('pub fn client('):source.index('pub fn identity(')]
        self.assertNotIn('std::env::', client)
        self.assertIn('store_auth', client)

    def test_production_v2_gate_is_retained(self):
        source = (ROOT / 'workers/neo-os-relayer/src/config.rs').read_text()
        self.assertIn('if self.is_production() && !crate::durable_v2::enabled(self)', source)


class PublicRelayerInputs(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.Packaging('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        for network in dual.NETWORKS:
            self.fixture.input['networks'][network]['relayer'] = {
                'state_file': f'/var/lib/neoos-relayer/{network}/state.json',
                'instance_id': f'{network}-instance', 'caller_id': f'{network}-caller',
                'store_url': 'https://store.example', 'store_api_key': 'sb_publishable_' + 'a' * 40,
                'issuer': 'https://issuer.example/auth/v1', 'mode': 'combined',
                'active_chains': ['neo_n3', 'neox'], 'feed_sync_enabled': True,
            }
        self.fixture.write()

    def test_explicit_dual_relayer_maps_public_boot_fields(self):
        _, _, overlays = self.fixture.validate()
        self.assertEqual(overlays['mainnet']['MORPHEUS_RELAYER_CALLER_ID'], 'mainnet-caller')
        self.assertEqual(overlays['testnet']['MORPHEUS_DELIVERY_PROTOCOL'], 'v2')
        self.assertEqual(overlays['mainnet']['MORPHEUS_ACTIVE_CHAINS'], 'neo_n3,neox')
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY', overlays['testnet'])
        result = self.fixture.stage()
        # Staging only; no Docker, Nitro, Rust or public provider is run.
        self.assertIn(b'MORPHEUS_EMBEDDED_RELAYER=true', (self.fixture.root / 'context/Dockerfile').read_bytes())

    def test_partial_or_shared_identity_and_secret_key_are_refused(self):
        original = self.fixture.input['networks']['testnet'].pop('relayer')
        self.fixture.write()
        with self.assertRaises(Exception): self.fixture.validate()
        self.fixture.input['networks']['testnet']['relayer'] = original
        for key, value in [('caller_id', 'mainnet-caller'), ('instance_id', 'mainnet-instance'),
                           ('state_file', '/var/lib/neoos-relayer/mainnet/state.json'),
                           ('store_api_key', 'sb_secret_synthetic-never-accepted')]:
            old = original[key]; original[key] = value; self.fixture.write()
            with self.subTest(key=key), self.assertRaises(Exception): self.fixture.validate()
            original[key] = old

    def test_legacy_inputs_keep_embedded_gate_off(self):
        for network in dual.NETWORKS:
            del self.fixture.input['networks'][network]['relayer']
        self.fixture.write()
        _, _, overlays = self.fixture.validate()
        self.assertTrue(all('MORPHEUS_RELAYER_CALLER_ID' not in o for o in overlays.values()))
        self.fixture.stage()
        self.assertIn(b'MORPHEUS_EMBEDDED_RELAYER=false',
                      (self.fixture.root / 'context/Dockerfile').read_bytes())

    def test_scoped_endpoints_are_canonical_public_https(self):
        relay = self.fixture.input['networks']['mainnet']['relayer']
        for url in ['http://store.example', 'https://user:pass@store.example',
                    'https://127.0.0.1', 'https://store.example:443',
                    'https://store.example/?token=synthetic', 'https://store.example/#x',
                    'https://store.example/%2e%2e', 'https://store.example/../other',
                    'https://store.internal', 'https://store.example/$(synthetic)']:
            relay['store_url'] = url; self.fixture.write()
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.fixture.validate()

    def test_state_and_identity_namespace_controls(self):
        relay = self.fixture.input['networks']['mainnet']['relayer']
        pristine = copy.deepcopy(relay)
        cases = [('state_file', '/var/lib/neoos-relayer/mainnet/../testnet/state.json'),
                 ('state_file', '/var/lib/neoos-relayer/mainnet/nested/state.json'),
                 ('state_file', '/var/lib/neoos-relayer/mainnet/.json'),
                 ('state_file', '/var/lib/neoos-relayer/mainnet/state.json\nENV X=y'),
                 ('caller_id', ''), ('caller_id', 'x' * 97),
                 ('instance_id', 'same\nENV X=y'), ('issuer', 'issuer\nENV X=y')]
        for key, value in cases:
            relay.clear(); relay.update(pristine); relay[key] = value; self.fixture.write()
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.fixture.validate()

    def test_chain_modes_and_feed_flags_fail_closed(self):
        relay = self.fixture.input['networks']['mainnet']['relayer']
        pristine = copy.deepcopy(relay)
        for key, value in [('active_chains', ['neo_n3']), ('active_chains', ['neox', 'neo_n3']),
                           ('active_chains', ['neo_n3', 'neo_n3']), ('active_chains', 'neo_n3,neox'),
                           ('mode', 'automation'), ('feed_sync_enabled', 'true'),
                           ('feed_sync_enabled', 1), ('feed_sync_enabled', False)]:
            relay.clear(); relay.update(pristine); relay[key] = value; self.fixture.write()
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.fixture.validate()
        relay.clear(); relay.update(pristine)
        relay['mode'] = 'requests_only'; relay['feed_sync_enabled'] = False
        self.fixture.write(); self.fixture.validate()

    def test_unknown_or_missing_public_fields_cannot_smuggle_credentials(self):
        relay = self.fixture.input['networks']['mainnet']['relayer']
        pristine = copy.deepcopy(relay)
        for key in ['runtime_token', 'jwt', 'service_role_key', 'MORPHEUS_EMBEDDED_RELAYER']:
            relay.clear(); relay.update(pristine); relay[key] = 'synthetic'
            self.fixture.write()
            with self.subTest(key=key), self.assertRaises(ValueError): self.fixture.validate()
        for key in pristine:
            relay.clear(); relay.update(pristine); del relay[key]; self.fixture.write()
            with self.subTest(missing=key), self.assertRaises(ValueError): self.fixture.validate()


if __name__ == '__main__':
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(cls)
                               for cls in [EmbeddedRelayerSourceContract, PublicRelayerInputs])
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())

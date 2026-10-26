"""Bounded source/config joins only; not Rust/runtime/KMS qualification."""
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
import dual_image_test as fixtures
ROOT = Path(__file__).resolve().parents[2]

class D1RuntimeJoins(unittest.TestCase):
    def text(self, name):
        return (ROOT / name).read_text()

    def test_inner_notifies_outer_before_any_local_await(self):
        source = self.text('workers/neo-os-relayer/src/relayer/supervisor.rs')
        tail = source[source.index('// Heartbeat and filesystem'):]
        self.assertLess(tail.index('context.notify_stopping(reason)'), tail.index('task.await'))
        self.assertLess(tail.index('stop.send(Some(reason))'), tail.index('task.await'))
        host = self.text('workers/nitro-enclave-host/src/embedded_relayer.rs')
        self.assertIn('reason=control.stop_reason()', host)
        self.assertIn('self.control.begin_draining(reason)', host)

    def test_health_uses_dispatch_route_identity(self):
        dispatch = self.text('workers/nitro-enclave-host/src/dispatch.rs')
        host = self.text('workers/nitro-enclave-host/src/embedded_relayer.rs')
        shim = self.text('workers/nitro-enclave-host/src/bin/enclave_host.rs')
        self.assertIn('match classify_request(method, raw_url, headers)?', dispatch)
        self.assertIn('crate::dispatch::classify_request(method,raw_url,headers)', host)
        self.assertNotIn('raw_url.split(\'?\').next()==Some("/health")', shim)

    def test_builder_emits_existing_scoped_n3_alias(self):
        fixture = fixtures.Packaging('runTest')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        for network in fixtures.dual.NETWORKS:
            fixture.input['networks'][network]['neo_n3_rpc'] = 'https://chosen-' + network + '.example.invalid'
        fixture.write()
        _, _, overlays = fixture.validate()
        for network in fixtures.dual.NETWORKS:
            self.assertEqual(overlays[network]['NEO_RPC_URLS_' + network.upper()], fixture.input['networks'][network]['neo_n3_rpc'])
            self.assertEqual(overlays[network]['NEO_RPC_URL'], fixture.input['networks'][network]['neo_n3_rpc'])
            self.assertNotIn('ALLOW_GENERIC_NEO_RPC_URL', overlays[network])

    def test_dual_prepare_validates_public_profile_before_custody_plan(self):
        source = self.text('deploy/nitro/dual-prepare.rs')
        validate = source[source.index('fn validate('):source.index('\nfn main()')]
        self.assertLess(validate.index('embedded_relayer::validate_public_profiles('), validate.index('custody_bootstrap::prepare('))
        self.assertNotIn('std::env::var', validate)

    def test_boot_gate_and_public_validation_precede_custody_boot(self):
        source = self.text('workers/nitro-enclave-host/src/bin/enclave_host.rs')
        main = source[source.index('fn main()'):source.index('\nfn build_apps(')]
        before = main[:main.index('custody_bootstrap::boot(')]
        self.assertIn('embedded_relayer::validate_public_profiles(', before)
        self.assertIn('relayer_auth::enabled', before)
        self.assertIn('MORPHEUS_EMBEDDED_RELAYER', before)
        self.assertNotIn('MORPHEUS_EMBEDDED_RELAYER", "true"', before)

if __name__ == '__main__':
    unittest.main(verbosity=2)

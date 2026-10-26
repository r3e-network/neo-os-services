"""Source integration gates, not execution evidence for Rust, KMS or SQL.

These checks deliberately fail until the existing build planner and boot path
enforce the new public contract. No compiler or key/vault initialization runs.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PublicContractIntegration(unittest.TestCase):
    def test_build_planner_enforces_embedded_public_contract(self):
        source = (ROOT / 'deploy/nitro/dual-prepare.rs').read_text()
        planner = source[source.index('fn validate('):source.index('\nfn main()')]
        self.assertRegex(planner, r'embedded_relayer::validate_public_profiles\s*\(')

    def test_invalid_boot_contract_is_rejected_before_custody_initialization(self):
        source = (ROOT / 'workers/nitro-enclave-host/src/bin/enclave_host.rs').read_text()
        boot = source[source.index('fn main()'):source.index('\nfn build_apps(')]
        before_custody = boot[:boot.index('custody_bootstrap::boot(')]
        self.assertRegex(before_custody, r'embedded_relayer::validate_public_profiles\s*\(')
        self.assertIn('MORPHEUS_EMBEDDED_RELAYER', before_custody)

    def test_sql_acceptance_includes_gateway_fixture_and_caller_scope(self):
        script = (ROOT / 'scripts/test-relayer-delivery-v2.sh').read_text()
        self.assertRegex(script, r'create role authenticator\s+nologin\s+noinherit')
        self.assertIn('"$repo/tests/relayer-caller-scope.sql"', script)


if __name__ == '__main__':
    unittest.main(verbosity=2)

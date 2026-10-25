"""Exercise only the pure fixture builder; never import the chain driver."""
import ast
import base64
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/test-host-private-chain.py'


class FixtureTests(unittest.TestCase):
    def builder(self):
        tree = ast.parse(SOURCE.read_text())
        functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                     and n.name == 'fulfillment_request']
        self.assertEqual(len(functions), 1, 'fixture construction must be independently testable')
        namespace = {'base64': base64, 'json': json}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), 'exec'), namespace)
        return namespace['fulfillment_request']

    def test_exact_onchain_bytes_and_text_are_not_reserialized(self):
        build = self.builder()
        raw = b' { "function" : "hash.sha256", "input": {"answer":42} }\n'
        pending = [{'value': '1'}] + [{'value': base64.b64encode(v).decode()}
                   for v in [b'app', b'compute.run', b'compute_hash', raw]]
        request = build(pending, '0x' + '11' * 20, 894710606)
        self.assertEqual(request['payload_hex'], raw.hex())
        self.assertEqual(request['payload_text'], raw.decode())
        self.assertEqual(request['payload'], json.loads(raw))
        self.assertNotEqual(bytes.fromhex(request['payload_hex']), json.dumps(request['payload']).encode())
        self.assertEqual(request['fulfillment_context']['network_magic'], 894710606)
        self.assertEqual(request['fulfillment_context']['operation'], 'compute_hash')

    def test_malformed_base64_utf8_and_json_fail_closed(self):
        build = self.builder()
        for encoded in ['!!', base64.b64encode(b'\xff').decode(), base64.b64encode(b'not json').decode()]:
            pending = [{'value': '1'}] + [{'value': base64.b64encode(b'x').decode()}] * 3 + [{'value': encoded}]
            with self.assertRaises((ValueError, UnicodeDecodeError)):
                build(pending, '0x' + '11' * 20, 894710606)

    def test_driver_uses_builder_and_fixture_is_passed_to_host(self):
        source = SOURCE.read_text()
        self.assertIn('"request": fulfillment_request(pending, contract, config["magic"])', source)
        self.assertIn('"HOST_PRIVATE_CHAIN_FIXTURE": str(fixture)', source)


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""CU-43: disposable NeoGo chain; pre-signed journal stands in for SIGN/host.

Requires neo-go 0.121.0 on PATH and the Rust toolchain. No public endpoint,
existing wallet, database, or credential is used. All chain state is temporary.
"""
import http.server
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120, **kwargs)
    if result.returncode:
        # Wallet commands can emit sensitive inputs; never echo their output.
        raise RuntimeError(f"{args[0:2]} exited {result.returncode}")
    return result.stdout


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        value = sock.getsockname()[1]
        assert value >= 20000
        return value


def main():
    assert "0.121.0" in run(["neo-go", "--version"]), "neo-go 0.121.0 required"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="neoos-local-chain-", dir="/private/tmp" if Path("/private/tmp").exists() else "/tmp") as temp:
        root = Path(temp)
        wallet = root / "wallet.json"
        wallet_config = root / "wallet.yml"
        wallet_config.write_text(f'Path: {wallet}\nPassword: local-chain-disposable\n')
        run(["neo-go", "wallet", "init", "--wallet-config", str(wallet_config), "--account"], input="local\n")
        public = re.search(r"(?m)^\s*([0-9a-f]{66})\s*$", run(["neo-go", "wallet", "dump-keys", "--wallet-config", str(wallet_config)]))
        assert public, "generated public key missing"
        public = public.group(1)
        run(["neo-go", "wallet", "import-multisig", "--wallet-config", str(wallet_config), "--min", "1", public])
        address = json.loads(wallet.read_text())["accounts"][0]["address"]
        rpc_port, p2p_port = port(), port()
        url = f"http://127.0.0.1:{rpc_port}"
        config = root / "node.yml"
        config.write_text(f"""ProtocolConfiguration:
  Magic: 894710606
  MaxTraceableBlocks: 200000
  TimePerBlock: 100ms
  Genesis:
    TimePerBlock: 100ms
  MemPoolSize: 100
  StandbyCommittee:
    - {public}
  ValidatorsCount: 1
  VerifyTransactions: true
ApplicationConfiguration:
  DBConfiguration:
    Type: inmemory
  P2P:
    Addresses: ["127.0.0.1:{p2p_port}"]
    MinPeers: 0
    MaxPeers: 1
    AttemptConnPeers: 0
  Relay: true
  Consensus:
    Enabled: true
    UnlockWallet:
      Path: {wallet}
      Password: local-chain-disposable
  RPC:
    Enabled: true
    Addresses: ["127.0.0.1:{rpc_port}"]
    MaxGasInvoke: 100
""")
        def rpc(body):
            request = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
            with opener.open(request, timeout=3) as response:
                return json.load(response)
        with (root / "node.log").open("w") as log:
            node = subprocess.Popen(["neo-go", "node", "--config-file", str(config)], stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if node.poll() is not None:
                        raise RuntimeError("private node exited before startup")
                    try:
                        if rpc({"jsonrpc": "2.0", "id": 1, "method": "getblockcount", "params": []})["result"] >= 3:
                            break
                    except (OSError, KeyError):
                        pass
                    time.sleep(0.1)
                else:
                    raise RuntimeError("private node did not start")
                context = root / "context.json"
                run(["neo-go", "contract", "invokefunction", "--rpc-endpoint", url,
                     "--wallet-config", str(wallet_config), "--address", address,
                     "--out", str(context), "--force", "GAS", "transfer",
                     address, address, "1", "null", "--", f"{address}:CalledByEntry"])
                captured = {}
                class Capture(http.server.BaseHTTPRequestHandler):
                    def log_message(self, *_args):
                        pass
                    def do_POST(self):
                        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                        if body["method"] == "sendrawtransaction":
                            captured["raw"] = body["params"][0]
                            result = {"jsonrpc": "2.0", "id": body["id"], "result": {"hash": json.loads(context.read_text())["hash"]}}
                        else:
                            result = rpc(body)
                        data = json.dumps(result).encode()
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                # Capture the prepared bytes without broadcasting: the relayer
                # must perform the first real submission itself.
                with http.server.HTTPServer(("127.0.0.1", port()), Capture) as capture:
                    thread = threading.Thread(target=capture.serve_forever, daemon=True)
                    thread.start()
                    try:
                        run(["neo-go", "util", "sendtx", "--rpc-endpoint", f"http://127.0.0.1:{capture.server_port}", str(context)])
                    finally:
                        capture.shutdown()
                        thread.join()
                assert captured.get("raw"), "transaction preparation produced no bytes"
                fixture = root / "fixture.json"
                fixture.write_text(json.dumps({"url": url, "signed": {
                    "chain": "neo_n3", "request_id": "local-chain-acceptance",
                    "tx_hash": json.loads(context.read_text())["hash"], "raw": captured["raw"],
                }}))
                env = {**os.environ, "LOCAL_CHAIN_ACCEPTANCE": str(fixture),
                       "HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1",
                       "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": "",
                       "http_proxy": "http://127.0.0.1:1", "https_proxy": "http://127.0.0.1:1",
                       "all_proxy": "http://127.0.0.1:1", "no_proxy": ""}
                subprocess.run(["cargo", "test", "--locked", "--offline", "-p", "neo-os-relayer", "--test", "local_chain", "private_chain_scan_and_delivery", "--", "--ignored", "--exact"], env=env, check=True, timeout=480)
                print("Private-chain scan and journaled delivery: PASS (SIGN/host preparation stand-in).")
            finally:
                if node.poll() is None:
                    node.terminate()
                    try:
                        node.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        node.kill()
                        node.wait()


if __name__ == "__main__":
    main()

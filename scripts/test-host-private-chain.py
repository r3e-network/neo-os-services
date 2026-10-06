#!/usr/bin/env python3
"""Deploy the unmodified kernel and settle a host fulfillment on a private chain.

Requires Neo Express 3.10.1, nccs 3.9.1, .NET 10 and Rust. Run from the repo
root after `bash contracts/build.sh`. No existing wallet or endpoint is used.
Neo Express persists real blocks offline; its clock fast-forward matures the
kernel's verifier timelock. Custody and NSM hardware are test stand-ins.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        value = sock.getsockname()[1]
        assert value >= 20000
        return value


def script_hash(address):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    for character in address:
        number = number * 58 + alphabet.index(character)
    decoded = number.to_bytes(25, "big")
    assert hashlib.sha256(hashlib.sha256(decoded[:-4]).digest()).digest()[:4] == decoded[-4:]
    assert decoded[0] == 53
    return "0x" + decoded[1:21][::-1].hex()


def address_for(contract):
    payload = b"\x35" + bytes.fromhex(contract.removeprefix("0x"))[::-1]
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    number = int.from_bytes(payload + checksum, "big")
    result = ""
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    while number:
        number, digit = divmod(number, 58)
        result = alphabet[digit] + result
    return result


def main():
    neoxp = shutil.which("neoxp") or str(Path.home() / ".dotnet/tools/neoxp")
    assert "3.10.1" in subprocess.check_output([neoxp, "--version"], text=True)
    nef = Path("contracts/build/MorpheusOracle.nef").resolve()
    assert nef.is_file(), "run bash contracts/build.sh first"
    temp_parent = "/private/tmp" if Path("/private/tmp").exists() else "/tmp"
    with tempfile.TemporaryDirectory(prefix="host-private-chain-", dir=temp_parent) as temp:
        root = Path(temp)
        # Neo Express's chain storage and all fresh wallet material stay here.
        env = {**os.environ, "HOME": str(root), "DOTNET_CLI_HOME": str(root)}
        chain = root / "chain.neo-express"

        def xp(*args):
            result = subprocess.run([neoxp, *args], env=env, capture_output=True,
                                    text=True, timeout=120)
            # Never echo command output: wallet diagnostics can contain keys.
            assert result.returncode == 0, f"Neo Express {args[:2]} failed"
            return result.stdout

        xp("create", "-o", str(chain))
        config = json.loads(chain.read_text())
        config["magic"] = 894710606
        node = config["consensus-nodes"][0]
        node["rpc-port"], node["tcp-port"] = port(), port()
        chain.write_text(json.dumps(config))
        account = node["wallet"]["name"]
        owner = script_hash(node["wallet"]["accounts"][0]["script-hash"])

        def command(*args):
            return xp(*args, "-i", str(chain))

        command("transfer", "10000", "GAS", "genesis", account)
        deployed = json.loads(command("contract", "deploy", str(nef), account, "--json"))
        contract = deployed["contract-hash"]
        print(f"Fresh kernel deployed: {contract}", flush=True)

        def parameter(kind, value):
            return {"type": kind, "value": value}

        def invoke(method, args, read=False):
            path = root / "invoke.neo-invoke.json"
            path.write_text(json.dumps({"contract": contract, "operation": method, "args": args}))
            flags = ["--results"] if read else []
            result = json.loads(command("contract", "invoke", str(path), account, "--json", *flags))
            return result

        def text(value):
            return parameter("String", value)

        def integer(value):
            return parameter("Integer", str(value))

        def binary(value):
            return parameter("ByteArray", base64.b64encode(value).decode())

        def read_request():
            result = invoke("getRequest", [integer(1)], read=True)
            assert result["state"] == "HALT", "getRequest must halt"
            return result["stack"][0]["value"]

        address = parameter("Hash160", owner)
        invoke("setUpdater", [address])
        invoke("registerMiniApp", [text("cu87.private"), address, address,
                                  parameter("Hash160", "0x" + "00" * 20), text(""), text("")])
        invoke("grantModuleToMiniApp", [text("cu87.private"), text("compute.run")])
        command("transfer", "1", "GAS", account, address_for(contract))
        payload = {"function": "hash.sha256", "input": {"answer": 42}}
        invoke("submitMiniAppRequest", [text("cu87.private"), text("compute.run"),
                                        text("compute_hash"), binary(json.dumps(payload).encode())])
        pending = read_request()
        assert int(pending[0]["value"]) == 1
        assert int(pending[8]["value"]) == 0, "fresh request must be pending"
        print("On-chain request 1 is pending; invoking the host.", flush=True)

        def decoded(index):
            return base64.b64decode(pending[index]["value"]).decode()

        fixture = root / "request.json"
        fixture.write_text(json.dumps({"request": {
            "chain": "neo_n3", "request_id": pending[0]["value"],
            "request_type": decoded(3), "payload": json.loads(decoded(4)),
            "fulfillment_context": {"app_id": decoded(1), "module_id": decoded(2),
                                    "operation": decoded(3), "contract_script_hash": contract,
                                    "network_magic": config["magic"]},
        }}))
        subprocess.run(["cargo", "test", "--offline", "--locked", "-p", "nitro-enclave-host",
                        "--lib", "fulfill::tests::private_chain::fulfill_deployed_kernel_request", "--",
                        "--ignored", "--exact"], check=True, timeout=480,
                       env={**os.environ, "HOST_PRIVATE_CHAIN_FIXTURE": str(fixture)})
        response = json.loads(Path(f"{fixture}.response").read_text())
        invoke("proposeRuntimeVerificationPublicKey", [parameter("PublicKey", response["public_key"])])
        command("fastfwd", "1", "--timestamp-delta", "90000")
        invoke("executeRuntimeVerificationPublicKey", [])
        result_bytes = response["result"].encode()
        signature = bytes.fromhex(response["signature"])
        args = [integer(1), parameter("Boolean", True), binary(result_bytes),
                text(response["error"]), binary(signature)]
        # A corrupt signature must fault without changing the pending request.
        invalid = args[:-1] + [binary(bytes([signature[0] ^ 1]) + signature[1:])]
        rejected = invoke("fulfillRequest", invalid, read=True)
        assert rejected["state"] == "FAULT", "invalid signature must be rejected"
        assert int(read_request()[8]["value"]) == 0
        invoke("fulfillRequest", args)
        completed = read_request()
        assert int(completed[8]["value"]) == 1, "on-chain request must succeed"
        assert completed[11]["value"] is True
        assert base64.b64decode(completed[12]["value"]) == result_bytes
        assert int(completed[10]["value"]) > 0, "completion timestamp must be stored"
        replay = invoke("fulfillRequest", args, read=True)
        assert replay["state"] == "FAULT", "completed request must reject replay"
        print("PASS: pending -> succeeded; real signature verified; result persisted; corrupt signature and replay rejected.")


if __name__ == "__main__":
    main()

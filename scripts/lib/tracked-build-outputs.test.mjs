import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { trackedBuildOutputViolations } from "./tracked-build-outputs.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const checkerPath = path.join(repoRoot, "scripts/check-tracked-build-outputs.mjs");

test("rejects generated output at any depth", () => {
  assert.deepEqual(trackedBuildOutputViolations([
    "dist/index.js",
    "apps/web/coverage/lcov.info",
    "workers/nitro-worker/node_modules/undici/index.js",
    "workers/neo-signer/target/debug/signer_service",
    "apps/web/.next/BUILD_ID",
    "crates/example/src/generated.rs",
    "scripts/__pycache__/helper.cpython-313.pyc",
  ]), [
    "apps/web/.next/BUILD_ID",
    "apps/web/coverage/lcov.info",
    "dist/index.js",
    "scripts/__pycache__/helper.cpython-313.pyc",
    "workers/neo-signer/target/debug/signer_service",
    "workers/nitro-worker/node_modules/undici/index.js",
  ]);
});

test("retains reviewed contract artifacts, generated projections and Rust binary sources", () => {
  assert.deepEqual(trackedBuildOutputViolations([
    "contracts-evm/build/MiniAppCreditsV2.abi.json",
    "vendor/neo-os-did/contracts/build/NeoDIDRegistry.nef",
    "config/generated/NeoN3NetworkIdentity.g.cs",
    "workers/neo-signer/src/bin/signer_service.rs",
    "workers/nitro-enclave-host/src/bin/enclave_host.rs",
    "crates/nitro-attest/src/bin/nsm-attest-rs.rs",
  ]), []);
});

test("rejects a force-tracked output and passes the repository snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neoos-services-output-"));
  try {
    spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "generated.js"), "generated\n");
    spawnSync("git", ["-C", root, "add", "-f", "dist/generated.js"], { encoding: "utf8" });
    const result = spawnSync(process.execPath, [checkerPath, "--repo", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tracked build output/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

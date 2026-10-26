#!/usr/bin/env python3
"""Run the build-only Rust helper's controls in a private exact Git archive.

Usage: python3 deploy/nitro/test-dual-preparation.py
Requires the locked Cargo dependencies to be available offline. Never mutates
host sources, Cargo.lock or shared build targets; performs no cloud/RPC calls.
"""
import argparse
import importlib.util
import io
import sys
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--target-dir', type=Path, help='explicit private Cargo target (default: new temporary target)')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
module = importlib.util.spec_from_file_location('dual', repo / 'deploy/nitro/build-dual-enclave.py')
dual = importlib.util.module_from_spec(module)
module.loader.exec_module(dual)
signal.signal(signal.SIGTERM, dual.interrupted)
with tempfile.TemporaryDirectory(prefix='dual-rust-check-') as tmp:
    tmp = Path(tmp)
    tmp = tmp.resolve()
    git_env = dual.safe_env(tmp)
    commit = dual.git(repo, git_env, 'rev-parse', 'HEAD').decode().strip()
    with dual.object_repository(repo, git_env) as isolated:
        archive = dual.git(isolated, git_env, 'archive', '--format=tar', commit)
    source = tmp / 'source'; source.mkdir()
    # The archive comes from the isolated exact object tree, not local grafts.
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(source)
    example = source / 'workers/nitro-enclave-host/examples/dual_prepare.rs'
    example.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'deploy/nitro/dual-prepare.rs', example)
    env = {k: os.environ[k] for k in ('PATH','HOME','CARGO_HOME','RUSTUP_HOME') if k in os.environ}
    target = args.target_dir.resolve() if args.target_dir else tmp / 'target'
    env.update(CARGO_BUILD_JOBS='1', RUST_TEST_THREADS='1', CARGO_NET_OFFLINE='true', CARGO_TARGET_DIR=str(target))
    dual.run(['cargo','build','--locked','--offline','-p','nitro-enclave-host','--example','dual_prepare','--features','nitro-enclave-host/embedded-relayer'],env,cwd=source,timeout=900)
    dual.run(['cargo','test','--locked','--offline','-p','nitro-enclave-host','--example','dual_prepare','--features','nitro-enclave-host/embedded-relayer','--','--test-threads=1'],env,cwd=source,timeout=900)
    try:
        print(dual.run(['python3','-B',str(source/'deploy/nitro/dual_prepare_test.py'),str(target/'debug/examples/dual_prepare')],env,cwd=source,timeout=120).decode())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # The existing helper emits fixed diagnostic codes, never captured text.
        print('DUAL-PREPARATION-TEST-FAILURE ' + dual.encoded(dual.failure_diagnostic(error)).decode(), file=sys.stderr)
        raise

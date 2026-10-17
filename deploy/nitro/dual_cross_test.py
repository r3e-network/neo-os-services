"""Synthetic tool/context controls; never builds an image or EIF."""
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from dual_image_test import Packaging, dual, HERE


def cross_module():
    spec = importlib.util.spec_from_file_location('dual_cross', HERE / 'dual_cross.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CrossControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dual-cross-synthetic-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_explicit_cli_options(self):
        p = subprocess.run([sys.executable, '-B', str(HERE/'build-dual-enclave.py'), '--help'], capture_output=True)
        self.assertEqual(p.returncode, 0)
        for flag in (b'--builder-platform', b'--cross-cache', b'--linuxkit-mode'):
            self.assertIn(flag, p.stdout)

    def test_default_recipe_and_runtime_identical(self):
        old = (HERE/'Dockerfile.dual-enclave').read_text()
        new = (HERE/'Dockerfile.dual-enclave.cross').read_text()
        self.assertEqual(old[old.index('FROM debian:'):], new[new.index('FROM debian:'):].replace('/build/target/x86_64-unknown-linux-gnu/release/', '/build/target/release/'))
        self.assertIn('FROM --platform=linux/arm64 rust@sha256:', new)
        self.assertIn('cargo build --release --locked --target x86_64-unknown-linux-gnu', new)
        self.assertIn('QEMU_LD_PREFIX=/usr/x86_64-linux-gnu', new)
        self.assertIn('sha256sum -c SHA256SUMS', new)

    def synthetic(self):
        c = cross_module(); data = b'SYNTHETIC PUBLIC INPUT ONLY'; h = hashlib.sha256(data).hexdigest()
        cache = self.root/'cache'; (cache/'objects/sha256').mkdir(parents=True)
        p = cache/'objects/sha256'/h; p.write_bytes(data)
        entry = {'path':'cross-inputs/debs/synthetic.deb','sha256':h,'size':len(data)}
        return c, cache, p, entry

    def test_pinned_bytes_only_and_digest(self):
        c, cache, p, e = self.synthetic()
        self.assertEqual(c.read_object(cache, e), p.read_bytes())
        p.write_bytes(b'x'*e['size'])
        with self.assertRaises(ValueError):c.read_object(cache, e)

    def test_size_and_symlink_rejected(self):
        c, cache, p, e = self.synthetic()
        with self.assertRaises(ValueError):c.read_object(cache, dict(e,size=e['size']+1))
        p.write_bytes(b'x')
        with self.assertRaises(ValueError):c.read_object(cache, e)
        p.unlink(); target=self.root/'target';target.write_bytes(b'SYNTHETIC PUBLIC INPUT ONLY');p.symlink_to(target)
        with self.assertRaises((ValueError,OSError)):c.read_object(cache,e)

    def test_cache_parent_symlink_rejected(self):
        c, cache, p, e = self.synthetic();alias=self.root/'alias';alias.symlink_to(cache, target_is_directory=True)
        with self.assertRaises((ValueError,OSError)):c.read_object(alias,e)

    def test_no_cache_ambient_files_in_context(self):
        c,cache,p,e=self.synthetic(); (cache/'credentials').write_text('SYNTHETIC-CANARY')
        files={'deploy/nitro/cross-inputs.lock.json':json.dumps({'objects':[e]}).encode(),'deploy/nitro/Dockerfile.dual-enclave.cross':b'SYNTHETIC RECIPE'}
        out=c.cross_inputs(files,cache)
        self.assertEqual(set(out),{e['path'],'cross-inputs/SHA256SUMS'})
        self.assertNotIn(b'SYNTHETIC-CANARY',b''.join(out.values()))

    def test_reject_duplicate_or_escaping_input(self):
        c,cache,p,e=self.synthetic()
        for entries in ([e,e],[dict(e,path='../escape')],[dict(e,path='/absolute')],[dict(e,path='cross-inputs/debs/a\nb')],[dict(e,path='cross-inputs/debs/./a')]):
            with self.assertRaises(ValueError):c.cross_inputs({'deploy/nitro/cross-inputs.lock.json':json.dumps({'objects':entries}).encode()},cache)

    def test_linuxkit_adapter_dispatch_and_arch_override_rejected(self):
        c=cross_module(); bundle=self.root/'tools';bundle.mkdir();recorder=b'#!/bin/sh\nprintf "%s\\n" "$@"\n'
        (bundle/'linuxkit.native').write_bytes(recorder);(bundle/'linuxkit.native').chmod(0o700)
        adapter=bundle/'linuxkit';adapter.write_bytes(c.adapter_script());adapter.chmod(0o700)
        p=subprocess.run([str(adapter),'build','--name','synthetic','--format','kernel+initrd-nogz'],capture_output=True)
        self.assertEqual(p.returncode,0);self.assertEqual(p.stdout.splitlines()[:3],[b'build',b'--arch',b'amd64'])
        for args in (['build','--arch','arm64'],['build','--arch=arm64'],['version']):
            self.assertNotEqual(subprocess.run([str(adapter),*args],capture_output=True).returncode,0)

    def test_native_linuxkit_requires_pinned_bytes(self):
        c=cross_module();bad=self.root/'bad';bad.write_bytes(b'SYNTHETIC-NOT-AWS')
        with self.assertRaises(ValueError):c.native_linuxkit_bundle(bad,self.root/'blobs',self.root/'out')

    def test_linuxkit_bundle_binds_all_target_blobs(self):
        c=cross_module(); data=b'SYNTHETIC NATIVE'; native=self.root/'native';native.write_bytes(data)
        blobs=self.root/'blobs';blobs.mkdir(); blob=b'SYNTHETIC X86';(blobs/'bzImage').write_bytes(blob)
        with patch.object(c,'ARM_LINUXKIT_SHA256',hashlib.sha256(data).hexdigest()), patch.object(c,'ARM_LINUXKIT_BYTES',len(data)), patch.object(c,'X86_BLOBS',{'bzImage':(hashlib.sha256(blob).hexdigest(),len(blob))}):
            out=c.native_linuxkit_bundle(native,blobs,self.root/'out')
            self.assertEqual((out/'bzImage').read_bytes(),blob)
            self.assertEqual((out/'linuxkit').read_bytes(),c.adapter_script())
            (blobs/'bzImage').write_bytes(b'x'*len(blob))
            with self.assertRaises(ValueError):c.native_linuxkit_bundle(native,blobs,self.root/'bad-output')
            self.assertFalse((self.root/'bad-output').exists())

    def test_cli_flag_pairings_refused_before_source_access(self):
        for flags in (['--native-linuxkit','/synthetic'],['--linuxkit-mode','native-arm64'],['--linuxkit-mode','native-arm64','--native-linuxkit','/synthetic']):
            p=subprocess.run([sys.executable,'-B',str(HERE/'build-dual-enclave.py'),'prepare','--repo','/synthetic','--input','/synthetic','--input-sha256','0'*64,'--output','/synthetic-output',*flags],capture_output=True)
            self.assertEqual(p.returncode,1)
            self.assertIn(b'ValueError',p.stderr)

    def test_native_adapter_is_explicit_and_keeps_stock_cli(self):
        for enabled in (False, True):
            recorded=[]
            def bundle(native, blobs, output):
                self.assertEqual(native,Path('/trusted/native'))
                self.assertEqual(blobs,Path('/trusted/blobs'))
                output.mkdir();(output/'linuxkit').write_bytes(b'SYNTHETIC ADAPTER');(output/'linuxkit.native').write_bytes(b'SYNTHETIC TOOL')
                return output
            def build(repo, context, manifest, output, env, docker, cli, blobs):
                recorded.append((dict(manifest),cli,blobs))
            args=['dual','build','--repo',str(self.root),'--input','/synthetic','--input-sha256','0'*64,'--output',str(self.root.parent/'synthetic-unused-output'),'--nitro-cli','/trusted/nitro','--nitro-blobs','/trusted/blobs']
            if enabled:args+=['--linuxkit-mode','native-arm64','--native-linuxkit','/trusted/native']
            with patch.object(sys,'argv',args),patch.object(dual,'stage',return_value={'git_commit':'a'*40}),patch.object(dual,'build',side_effect=build),patch.object(dual,'native_linuxkit_bundle',side_effect=bundle) as bundler,patch.object(sys,'stdout',io.StringIO()):
                dual.main()
            self.assertEqual(bundler.call_count,int(enabled))
            manifest,cli,blobs=recorded[0];self.assertEqual(cli,Path('/trusted/nitro'))
            if enabled:
                self.assertEqual(manifest['linuxkit_mode'],'native-arm64')
                self.assertEqual(manifest['linuxkit_adapter_sha256'],hashlib.sha256(b'SYNTHETIC ADAPTER').hexdigest())
                self.assertEqual(manifest['linuxkit_native_sha256'],hashlib.sha256(b'SYNTHETIC TOOL').hexdigest())
                self.assertNotEqual(blobs,Path('/trusted/blobs'))
            else:
                self.assertNotIn('linuxkit_mode',manifest);self.assertEqual(blobs,Path('/trusted/blobs'))


class CrossStaging(Packaging):
    def setUp(self):
        super().setUp()
        for name in ('Dockerfile.dual-enclave.cross','cross-inputs.lock.json','dual_cross.py'):
            shutil.copyfile(HERE/name,self.repo/'deploy/nitro'/name)
        self.git('add','.');self.git('commit','-qm','synthetic cross source')
        self.commit=self.git('rev-parse','HEAD').strip();self.input['source_commit']=self.commit;self.write()

    def test_cross_mode_is_opt_in_and_requires_cache(self):
        default=self.stage();self.assertNotIn('builder_platform',default)
        with self.assertRaises(ValueError):dual.stage(self.repo,self.input_path,self.hash,self.root/'cross',self.env,builder_platform='linux/arm64')
        self.assertFalse((self.root/'cross').exists())

    def test_cross_context_selects_recipe_and_binds_inputs(self):
        with patch.object(dual, 'cross_inputs', return_value={'cross-inputs/SHA256SUMS':b'SYNTHETIC ONLY\n'}):
            m=dual.stage(self.repo,self.input_path,self.hash,self.root/'cross',self.env,builder_platform='linux/arm64',cross_cache=self.root/'synthetic-cache')
        docker=(self.root/'cross/Dockerfile').read_text()
        self.assertIn('FROM --platform=linux/arm64',docker)
        self.assertIn('ENV MORPHEUS_NETWORK_PROFILES_JSON=',docker)
        self.assertEqual(m['builder_platform'],'linux/arm64')
        self.assertEqual(m['files']['cross-inputs/SHA256SUMS'],hashlib.sha256(b'SYNTHETIC ONLY\n').hexdigest())


if __name__=='__main__':
    suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(CrossControls))
    suite.addTests(CrossStaging(n) for n in ('test_cross_mode_is_opt_in_and_requires_cache','test_cross_context_selects_recipe_and_binds_inputs'))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())

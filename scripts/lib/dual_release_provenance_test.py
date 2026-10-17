"""Disposable local Git histories; no remotes, artifacts or production measurements."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from dual_release_provenance import Capture, TOOLS
from dual_release_validation import encoded, sha

ROOT = Path(__file__).resolve().parents[2]


class CommittedSource(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dual-source-test-')
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.env = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': self.temp.name,
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                    'GIT_AUTHOR_NAME': 'Jimmy', 'GIT_AUTHOR_EMAIL': 'jimmy@r3e.network',
                    'GIT_COMMITTER_NAME': 'Jimmy', 'GIT_COMMITTER_EMAIL': 'jimmy@r3e.network'}
        self.git('init', '-q')
        for name in TOOLS:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        registry = self.root / 'apps/web/lib/nitro-dual-release-registry.ts'
        registry.parent.mkdir(parents=True)
        shutil.copy2(ROOT / registry.relative_to(self.root), registry)
        self.put('Cargo.toml', b'[workspace]\n')
        self.put('crates/deleted.rs', b'// deleted unit fixture\n')
        self.put('crates/mode.rs', b'// mode unit fixture\n')
        self.commit('test: base source snapshot')
        self.base = self.git('rev-parse', 'HEAD')
        self.put('Cargo.toml', b'[workspace]\nmembers=[]\n')
        (self.root / 'crates/deleted.rs').unlink()
        self.put('crates/added.rs', b'// added unit fixture\n')
        (self.root / 'crates/mode.rs').chmod(0o755)
        self.commit('test: selected source changes')
        self.head = self.git('rev-parse', 'HEAD')

    def tearDown(self):
        self.temp.cleanup()

    def put(self, name, data):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, env=self.env,
                                       stderr=subprocess.PIPE).decode().strip()

    def commit(self, message):
        self.git('add', '--all')
        self.git('commit', '-qm', message)

    def cli(self, base=None, runner=None, environment=None):
        args = ['node', str((runner or self.root) / 'scripts/check-dual-release.mjs'),
                '--root', str(self.root), '--base', base or self.base]
        # Gate rejects externally supplied Git behavior overrides. Fixture author
        # metadata is for local commits only, not inherited by gate execution.
        env = {'PATH': self.env['PATH'], 'HOME': self.temp.name, **(environment or {})}
        result = subprocess.run(args, cwd=self.root, env=env, capture_output=True, text=True, timeout=20)
        return result.returncode, json.loads(result.stdout)

    def test_actual_committed_cli_records_diff_and_gate_bundle_without_admission(self):
        code, report = self.cli()
        self.assertEqual(code, 1, report)
        self.assertTrue(report['source_checks_complete'])
        self.assertFalse(report['passed']); self.assertFalse(report['complete']); self.assertFalse(report['full_admission'])
        receipt = report['provenance']
        self.assertEqual(receipt['head']['commit'], self.head)
        self.assertEqual(receipt['head']['tree'], self.git('rev-parse', 'HEAD^{tree}'))
        self.assertEqual(receipt['base']['commit'], self.base)
        self.assertEqual(receipt['merge_base'], self.base)
        self.assertIn('parents', receipt['head'])
        self.assertEqual(receipt['head']['parents'], [self.base])
        changes = {row['path']: row for row in receipt['changes']}
        self.assertEqual(set(changes), {'Cargo.toml','crates/added.rs','crates/deleted.rs','crates/mode.rs'})
        self.assertEqual(changes['Cargo.toml']['status'], 'M')
        self.assertEqual(changes['crates/added.rs']['old_mode'], '000000')
        self.assertEqual(changes['crates/deleted.rs']['new_mode'], '000000')
        self.assertEqual((changes['crates/mode.rs']['old_mode'], changes['crates/mode.rs']['new_mode']), ('100644','100755'))
        for row in changes.values():
            self.assertEqual(len(row['old_oid']),40);self.assertEqual(len(row['new_oid']),40)
        self.assertIn('gate_tool_bundle', receipt)
        bundle = receipt['gate_tool_bundle']
        self.assertEqual(bundle['scope'], 'supplemental-source-gate-only')
        self.assertEqual(set(bundle['files']), set(TOOLS))
        self.assertEqual(bundle['sha256'], sha(encoded(bundle['files'])))
        for name, meta in bundle['files'].items():
            data=(self.root/name).read_bytes()
            self.assertEqual(meta, {'mode': '100644', 'size': len(data), 'sha256': sha(data)})
        codes=[e['code'] for e in report['diagnostics']]
        self.assertEqual(codes.count('DUAL_SELECTED_INPUT_MEASUREMENT_ABSENT'),1)
        self.assertIn('DUAL_BUILD_INPUT_MISSING',codes)
        self.assertEqual(sum(c['status']=='NOT_EVALUABLE_MISSING_MEASUREMENT' for c in report['checks'] if 'status' in c),3)

    def test_alias_base_and_nonancestor_base_reject(self):
        for base in ['HEAD', self.base[:12]]:
            with self.subTest(base=base):self.assertEqual(self.cli(base)[0],2)
        self.git('checkout','--detach',self.base)
        self.put('unrelated.txt',b'unrelated branch\n');self.commit('test: unrelated history')
        unrelated=self.git('rev-parse','HEAD')
        self.git('checkout','--detach',self.head)
        code, report=self.cli(unrelated)
        self.assertEqual(code,2,report)
        self.assertEqual(report['diagnostics'][0]['message'],'base must be an ancestor of HEAD')

    def test_staged_untracked_and_hidden_selected_edits_reject(self):
        self.put('untracked.txt',b'dirty\n');self.assertEqual(self.cli()[0],2)
        (self.root/'untracked.txt').unlink()
        self.put('Cargo.toml',b'dirty\n');self.git('add','Cargo.toml');self.assertEqual(self.cli()[0],2)
        self.git('reset','--hard',self.head)
        self.git('update-index','--assume-unchanged','Cargo.toml')
        self.put('Cargo.toml',b'hidden dirty\n')
        code,report=self.cli();self.assertEqual(code,2)
        self.assertEqual(report['diagnostics'][0]['message'],'worktree bytes/mode differ from HEAD')

    def test_history_overrides_and_shallow_reject(self):
        self.git('update-ref','refs/replace/'+self.base,self.head)
        self.assertEqual(self.cli()[1]['diagnostics'][0]['message'],'replacement refs')
        self.git('update-ref','-d','refs/replace/'+self.base)
        self.put('.git/info/grafts',self.head.encode()+b'\n')
        self.assertEqual(self.cli()[1]['diagnostics'][0]['message'],'grafted history')
        (self.root/'.git/info/grafts').unlink()
        self.put('.git/shallow',self.head.encode()+b'\n')
        self.assertEqual(self.cli()[1]['diagnostics'][0]['message'],'full history required')

    def test_external_executing_tool_mode_or_symlink_reject(self):
        runner=Path(self.temp.name)/'runner'
        for name in TOOLS:
            target=runner/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
        target=runner/TOOLS[0];target.chmod(0o755)
        self.assertEqual(self.cli(runner=runner)[0],2)
        target.chmod(0o644)
        target=runner/TOOLS[2];target.unlink();target.symlink_to(self.root/TOOLS[2])
        self.assertEqual(self.cli(runner=runner)[0],2)

    def test_tool_content_drift_and_git_environment_override_reject(self):
        self.put(TOOLS[2], (self.root/TOOLS[2]).read_bytes()+b'\n# unit tool drift\n')
        self.commit('test: different audited tool bytes')
        # Execute the original reviewed module bytes against a different committed tool.
        self.assertEqual(self.cli(runner=ROOT)[0],2)
        self.assertEqual(self.cli(environment={'GIT_DIR':str(self.root/'.git')})[0],2)

    def test_recheck_revalidates_history(self):
        capture=Capture(self.root,self.base)
        self.git('update-ref','refs/replace/'+self.base,self.head)
        with self.assertRaisesRegex(ValueError,'replacement refs'):capture.recheck()

    def test_recheck_rejects_executing_tool_drift_outside_audited_root(self):
        runner=Path(self.temp.name)/'runner'
        for name in TOOLS:
            target=runner/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
        program = (
            'import sys; from pathlib import Path; '
            'sys.path.insert(0, sys.argv[1]); from dual_release_provenance import Capture; '
            'c=Capture(sys.argv[2],sys.argv[3]); '
            'p=Path(sys.argv[1])/"dual_release_validation.py"; p.write_bytes(p.read_bytes()+b"\\n# drift\\n"); '
            'c.recheck()'
        )
        result=subprocess.run(['python3','-B','-c',program,str(runner/'scripts/lib'),str(self.root),self.base],
            env={'PATH':self.env['PATH'],'HOME':self.temp.name},capture_output=True,text=True,timeout=20)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('ValueError: executing tool differs from HEAD',result.stderr)

    def test_base_equal_head_has_no_selected_input_absence(self):
        code,report=self.cli(self.head)
        self.assertEqual(code,1)
        self.assertEqual(report['provenance']['changes'],[])
        self.assertNotIn('DUAL_SELECTED_INPUT_MEASUREMENT_ABSENT',[e['code'] for e in report['diagnostics']])
        self.assertIn('DUAL_BUILD_INPUT_MISSING',[e['code'] for e in report['diagnostics']])
        self.assertFalse(report['full_admission'])

    def test_local_fsmonitor_never_executes(self):
        hook=Path(self.temp.name)/'monitor.sh';marker=Path(self.temp.name)/'monitor-ran'
        hook.write_text('#!/bin/sh\nprintf ran >> '+str(marker)+'\nprintf "token\\000"\n')
        hook.chmod(0o755)
        self.git('config','core.fsmonitor',str(hook))
        code,report=self.cli()
        self.assertEqual(code,1,report)
        self.assertFalse(marker.exists())
        self.assertEqual(report['provenance']['head']['commit'],self.head)
        self.assertTrue(report['source_checks_complete'])
        capture=Capture(self.root,self.base)
        capture.git('status','--porcelain')
        self.assertFalse(marker.exists())

    def test_local_clean_filter_cannot_execute_during_clean_capture(self):
        hook=Path(self.temp.name)/'filter.sh';marker=Path(self.temp.name)/'filter-ran'
        hook.write_text('#!/bin/sh\nprintf ran >> '+str(marker)+'\ncat\n');hook.chmod(0o755)
        self.put('.gitattributes',b'Cargo.toml filter=probe\n')
        self.commit('test: repository attributes')
        self.head=self.git('rev-parse','HEAD')
        self.git('config','filter.probe.clean',str(hook))
        # Force Git to examine clean worktree bytes instead of an index stat hit.
        import time
        stamp=time.time()+10
        os.utime(self.root/'Cargo.toml',(stamp,stamp))
        code,report=self.cli()
        self.assertEqual(code,1,report);self.assertFalse(marker.exists())
        self.assertEqual(report['provenance']['head']['commit'],self.head)

    def test_ignored_unchecked_bytecode_cannot_replace_executed_sources(self):
        import py_compile
        import importlib.util
        target=self.root/'scripts/lib/dual_release_provenance.py'
        payload=Path(self.temp.name)/'tainted.py'
        payload.write_bytes(target.read_bytes()+b'\n_old = Capture.receipt\ndef taint(self):\n r=_old(self)\n r["head"]["commit"]="f"*40\n r["base"]["commit"]="e"*40\n return r\nCapture.receipt=taint\n')
        cache=Path(importlib.util.cache_from_source(str(target)));cache.parent.mkdir(exist_ok=True)
        py_compile.compile(str(payload),cfile=str(cache),dfile=str(target),doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
        with (self.root/'.git/info/exclude').open('a') as f:f.write('\nscripts/lib/__pycache__/\n')
        self.assertEqual(self.git('status','--porcelain'),'')
        code,report=self.cli()
        self.assertEqual(code,1,report)
        self.assertEqual(report['provenance']['head']['commit'],self.head)
        self.assertEqual(report['provenance']['base']['commit'],self.base)
        self.assertTrue(report['provenance']['runtime']['verified_memory_sources'])

    def test_startup_hooks_pythonpath_and_user_site_do_not_run(self):
        startup=Path(self.temp.name)/'startup';startup.mkdir()
        marker=Path(self.temp.name)/'startup-ran'
        for name in ('sitecustomize.py','usercustomize.py'):
            (startup/name).write_text('from pathlib import Path\nPath('+repr(str(marker))+').write_text("ran")\n')
        (startup/'json.py').write_text('raise RuntimeError("local module executed")\n')
        code,report=self.cli(environment={'PYTHONPATH':str(startup),'PYTHONHOME':str(startup),
             'PYTHONUSERBASE':str(startup),'PYTHONSTARTUP':str(startup/'sitecustomize.py')})
        self.assertEqual(code,1,report);self.assertFalse(marker.exists())
        self.assertEqual(report['provenance']['head']['commit'],self.head)
        self.assertTrue(report['provenance']['runtime']['isolated'])
        self.assertTrue(report['provenance']['runtime']['no_site'])

    def test_git_environment_rejection_precedes_sanitization(self):
        for key in ('GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY',
                    'GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_SHALLOW_FILE',
                    'GIT_REPLACE_REF_BASE','GIT_NO_REPLACE_OBJECTS','GIT_EXTERNAL_DIFF','GIT_CONFIG_SYSTEM','GIT_DIR'):
            code,report=self.cli(environment={key:'untrusted'})
            self.assertEqual(code,2,key)
            self.assertEqual(report['diagnostics'][0]['message'],'Git environment override')
        code,report=self.cli(environment={'GIT_CONFIG_GLOBAL':'untrusted','GIT_CONFIG_NOSYSTEM':'0',
            'GIT_OPTIONAL_LOCKS':'1','GIT_TERMINAL_PROMPT':'1'})
        self.assertEqual(code,1,report)

    def test_source_mismatch_is_refused_before_module_execution(self):
        marker=Path(self.temp.name)/'module-ran'
        target=self.root/'scripts/lib/dual_release_validation.py'
        target.write_text('from pathlib import Path\nPath('+repr(str(marker))+').write_text("ran")\n'+target.read_text())
        code,report=self.cli()
        self.assertEqual(code,2,report);self.assertFalse(marker.exists())
        self.assertEqual(report['diagnostics'][0]['message'],'Executing tool differs from HEAD')

    def test_executed_source_buffer_must_equal_captured_commit(self):
        import types
        from unittest.mock import patch
        records={name:('100644',(self.root/name).read_bytes()) for name in TOOLS}
        records['scripts/lib/dual_release_validation.py']=('100644',b'not the executed reviewed source')
        context=types.SimpleNamespace(sources=records,head=self.head)
        with patch.dict('sys.modules',{'dual_release_execution':context}):
            with self.assertRaisesRegex(ValueError,'executed bytes differ from HEAD'):
                Capture(self.root,self.base)

    def test_clean_capture_accepts_existing_repository_path_syntax(self):
        for name in ('apps/web/app/api/jobs/[jobId]/route.ts','apps/web/app/api/[...path]/route.ts',
                     'deploy/systemd/worker@.service','docs/file with space.md'):
            self.put(name,b'public unit fixture\n')
        self.commit('test: ordinary repository paths')
        self.head=self.git('rev-parse','HEAD')
        # Self base exercises whole-tree cleanliness without changing the strict
        # release/selected-input path contract in raw change diagnostics.
        code,report=self.cli(self.head)
        self.assertEqual(code,1,report)
        self.assertEqual(report['provenance']['head']['commit'],self.head)

    def test_direct_python_entry_cannot_emit_source_completion(self):
        result=subprocess.run(['python3','-B',str(self.root/'scripts/lib/check_dual_release.py'),
            '--root',str(self.root),'--base',self.base],env={'PATH':self.env['PATH'],'HOME':self.temp.name},
            capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,2)
        report=json.loads(result.stdout)
        self.assertNotIn('source_checks_complete',report)
        self.assertEqual(report['diagnostics'][0]['message'],'verified isolated launcher required')

    def test_recheck_rejects_head_and_input_drift(self):
        capture=Capture(self.root,self.base)
        self.put('Cargo.toml',b'dirty\n')
        with self.assertRaises(ValueError):capture.recheck()
        self.commit('test: changed during capture')
        with self.assertRaisesRegex(ValueError,'HEAD changed during audit'):capture.recheck()


if __name__ == '__main__':
    unittest.main()

"""Real finite installer flow with synthetic host files and external replies only."""
import base64
import copy
import os
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import hosted_native_candidate as c
import hosted_docker_install as d

PINS_PATH = c.ROOT / 'deploy/nitro/hosted-docker-packages.json'
PINS = json.loads(PINS_PATH.read_text())
EMPTY = {'containers': [], 'images': [], 'volumes': []}


class DockerUpgrade(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory(prefix='docker-upgrade-offline-')
        self.addCleanup(t.cleanup)
        self.root = Path(t.name)
        self.host = self.root / 'host'; self.host.mkdir()
        self.work = self.root / 'work'; self.work.mkdir()
        self.events = []; self.fault = None; self.upgraded = False; self.masked = False; self.active = True
        self.old_pids = {'docker.service': '101', 'containerd.service': '102'}
        self.new_pids = {'docker.service': '201', 'containerd.service': '202'}
        for path in ('usr/bin', 'run/systemd/system', 'var', 'etc/docker', 'proc'):
            (self.host / path).mkdir(parents=True, exist_ok=True)
        (self.host / 'proc/1').mkdir(); (self.host / 'proc/1/comm').write_text('systemd\n')
        (self.host / 'var/run').symlink_to(self.host / 'run')
        for binary in ('docker', 'dockerd', 'containerd'):
            (self.host / 'usr/bin' / binary).write_bytes(binary.encode())
        for unit, pid in self.old_pids.items():
            path = self.host / 'proc' / pid; path.mkdir()
            (path / 'exe').symlink_to('/usr/bin/' + ('dockerd' if unit == 'docker.service' else 'containerd'))
        self.pins = copy.deepcopy(PINS)
        # Tiny synthetic bytes replace transport, while exercising real size/hash
        # verification, metadata/dependency checks, ordering and readback paths.
        for p in self.pins['packages']:
            p['size'] = len(p['Package']); p['sha256'] = c.sha(p['Package'].encode())
        for unit in d.UNITS:
            path = self.host / 'usr/lib/systemd/system' / unit; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(unit.encode())
            self.pins['unit_sha256'][unit] = c.sha(unit.encode())
        self.rows = {name: {'version': minimum or '1.0', 'arch': 'amd64', 'status': 'ii '} for name, minimum in d.PREREQUISITES.items()}
        for p in self.pins['packages']:
            self.rows[p['Package']] = {'version': '2.3.6' if p['Package']=='containerd.io' else '5:28.0.4', 'arch': 'amd64', 'status': 'ii '}
        real_sha = c.file_sha
        def file_sha(path):
            path = Path(path)
            if path.name == 'exe' and 'proc' in path.parts:
                return real_sha(self.host / str(path.readlink()).lstrip('/'))
            return real_sha(path)
        for context in (patch.object(d, 'HOST', self.host), patch.object(c, 'file_sha', side_effect=file_sha),
                        patch.object(c, 'download', side_effect=self.download),
                        patch.object(subprocess, 'Popen', side_effect=AssertionError('real process forbidden')),
                        patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden'))):
            context.start(); self.addCleanup(context.stop)
        test = self
        class External:
            root = test.work
            paths = []
            docker = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
            def resources(self): test.events.append('resources')
            def inventory(self):
                test.events.append('inventory')
                return {**EMPTY, 'containers': ['foreign']} if test.fault=='nonempty' else copy.deepcopy(EMPTY)
            def run(self, args, **kwargs): return test.run_tool([str(x) for x in args])
        self.runner = External()

    def download(self, _url, _record, destination, _runner, _deadline):
        self.events.append('download')
        name = next(p['Package'] for p in self.pins['packages'] if p['filename'] == destination.name)
        destination.write_bytes((name + ('bad' if self.fault=='hash' else '')).encode())

    def run_tool(self, args):
        self.events.append(args)
        if args[0] == '/usr/bin/sudo': args = args[2:]
        exe = Path(args[0]).name
        if exe=='readlink':return (str((self.host/args[1].lstrip('/')).readlink())+'\n').encode()
        if exe=='sha256sum':
            target=self.host/str((self.host/args[1].lstrip('/')).readlink()).lstrip('/')
            return (c.file_sha(target)+'  '+args[1]+'\n').encode()
        if exe=='ps':
            pids=self.new_pids if self.upgraded else self.old_pids
            text=''.join(pid+' '+('dockerd' if unit=='docker.service' else 'containerd')+'\n' for unit,pid in pids.items()) if self.active else ''
            if self.fault=='unknown-pid' and self.upgraded:text+='999 dockerd\n'
            return text.encode()
        if exe=='git':
            if 'rev-parse' in args:return ('1'*40+'\n').encode()
            if 'status' in args:return b''
            if 'get-url' in args:return (c.ORIGIN+'\n').encode()
            if 'ls-remote' in args:return ('1'*40+'\trefs/heads/main\n').encode()
            raise AssertionError(args)
        if exe=='dpkg-query':
            if args[1]=='--search':
                name={'/usr/bin/docker':'docker-ce-cli','/usr/bin/dockerd':'docker-ce','/usr/bin/containerd':'containerd.io'}[args[2]]
                return (name+': '+args[2]+'\n').encode()
            rows=copy.deepcopy(self.rows)
            if self.fault=='conflict': rows['runc']={'version':'1','arch':'amd64','status':'ii '}
            if self.fault=='dependency': del rows['nftables']
            if self.fault=='held': rows['docker-ce']['status']='hi '
            return ''.join(name+'\t'+v['version']+'\t'+v['arch']+'\t'+v['status']+'\n' for name,v in rows.items()).encode()
        if exe=='dpkg-deb':
            self.assertEqual(self.events.count('download'),3)
            p=next(p for p in self.pins['packages'] if p['filename']==Path(args[2]).name)
            value={k:p[k] for k in d.FIELDS if p.get(k) is not None}
            if self.fault=='metadata': value['Architecture']='arm64'
            return ''.join(k+': '+v+'\n' for k,v in value.items()).encode()
        if exe=='apt-get':
            self.assertIn('--simulate',args); self.assertIn('--no-download',args); self.assertIn('--no-remove',args)
            if 'check' in args:
                if self.fault=='broken': raise c.CommandFailure('command_failed')
                return b''
            if self.fault=='reverse-dependency': raise c.CommandFailure('command_failed')
            plan=''.join('Inst '+p['Package']+' ['+self.rows[p['Package']]['version']+'] ('+p['Version']+' local-deb [amd64])\n' for p in self.pins['packages'])
            if self.fault=='extra-package': plan+='Inst unapproved (1.0 remote [amd64])\n'
            if self.fault=='removal': plan+='Remv old-package [1.0]\n'
            return plan.encode()
        if exe=='dpkg':
            if args[1]=='--print-architecture': return b'amd64\n'
            if args[1]=='--audit': return b'broken package' if self.fault=='audit' else b''
            if args[1]=='--compare-versions':
                if (self.fault=='dependency-version' and args[3]=='ge') or (self.fault=='downgrade' and args[3]=='le'): raise c.CommandFailure('command_failed')
                return b''
            self.assertEqual(args[1],'--install'); self.assertFalse(self.active); self.assertTrue(self.masked)
            if self.fault=='dpkg': raise c.CommandFailure('command_failed')
            for p in self.pins['packages']: self.rows[p['Package']]['version']=p['Version']
            self.upgraded=True
            if self.fault=='autostart': self.active=True
            return b''
        if exe=='systemctl':
            action=args[1]
            if action=='show':
                unit=args[2];pids=self.new_pids if self.upgraded else self.old_pids
                binary='/usr/bin/dockerd' if unit=='docker.service' else '/usr/bin/containerd'
                argv=binary+(' -H fd:// --containerd=/run/containerd/containerd.sock' if unit=='docker.service' else '')
                row={'Id':unit,'LoadState':'masked' if self.masked else 'loaded','ActiveState':'active' if self.active else 'inactive','SubState':'running' if self.active else 'dead','MainPID':pids.get(unit,'0') if self.active else '0','ExecStart':'{ path='+binary+' ; argv[]='+argv+' ; }','FragmentPath':'/usr/lib/systemd/system/'+unit,'DropInPaths':'','Listen':'/run/docker.sock (Stream)' if unit=='docker.socket' else ''}
                if self.fault=='endpoint': row['Listen']='/run/other.sock (Stream)'
                if self.fault=='dropin': row['DropInPaths']='/etc/systemd/system/docker.service.d/custom.conf'
                if self.fault=='lost-service' and self.upgraded: row['LoadState']='not-found'
                return ''.join(k+'='+v+'\n' for k,v in row.items()).encode()
            if action=='mask':
                self.masked=True
                for unit in d.UNITS:(self.host/'run/systemd/system'/unit).symlink_to('/dev/null')
            elif action=='stop':
                if self.fault=='stop-reply': raise c.CommandFailure('command_failed')
                if self.fault!='still-running':
                    self.active=False
                    if self.fault!='old-process':
                        for pid in self.old_pids.values():shutil.rmtree(self.host/'proc'/pid)
            elif action=='unmask':
                self.masked=False
                for unit in d.UNITS:(self.host/'run/systemd/system'/unit).unlink()
            elif action=='start':
                if self.fault=='start': raise c.CommandFailure('command_failed')
                self.active=True
                for unit,pid in self.new_pids.items():
                    path=self.host/'proc'/pid;path.mkdir();(path/'exe').symlink_to('/usr/bin/'+('dockerd' if unit=='docker.service' else 'containerd'))
            elif action!='daemon-reload': raise AssertionError(args)
            return b''
        if exe=='docker':
            self.assertEqual(args[:3],self.runner.docker)
            if args[3]=='info':return json.dumps({'DockerRootDir':str(self.host/'run')}).encode()
            if args[3:5]==['buildx','version']:return b'github.com/docker/buildx v0.37.2 abc123'
            v={'Version':'29.9.1','Os':'linux','Arch':'amd64','MinAPIVersion':'1.44','ApiVersion':'1.56'}
            if self.fault=='version' or not self.upgraded:v['Version']='28.0.4'
            if not self.upgraded:v['ApiVersion']='1.48'
            if self.fault=='api':v['ApiVersion']='1.48'
            if self.fault=='api-min':v['MinAPIVersion']='1.50'
            if self.fault=='platform':v['Arch']='arm64'
            return json.dumps(v if args[-1]=='{{json .Server}}' else {'Client':v,'Server':v}).encode()
        raise AssertionError(args)

    def run_upgrade(self):
        if self.fault=='non-systemd':(self.host/'proc/1/comm').write_text('other-init\n')
        return d.Upgrade(c,self.runner).install(self.pins)

    def test_exact_pin_metadata(self):
        self.assertEqual(PINS['engine_version'],'29.9.1')
        self.assertEqual([p['Version'] for p in PINS['packages']],['2.4.2-2~ubuntu.24.04~noble','5:29.9.1-1~ubuntu.24.04~noble','5:29.9.1-1~ubuntu.24.04~noble'])
        self.assertEqual([p['sha256'] for p in PINS['packages']],['7327ab23182425e94b46a91567e9ddf0183f9b3a5ed53d5e2489f000dbf9cfe2','961968342af4738eb5fb5fc03f9834106c1e454bd010d574cf1a6feae9905efc','463a666215797c9f9ea7d0ad1751de5b2b3806a1b539a3550e16822ef34ccbfd'])

    def test_success_uses_only_pinned_install_and_default_units(self):
        result=self.run_upgrade();self.assertEqual(result['server_version'],'29.9.1')
        commands=[e for e in self.events if isinstance(e,list)]
        installs=[e for e in commands if '--install' in e];self.assertEqual(len(installs),1)
        self.assertEqual(len(installs[0]),7);self.assertEqual(installs[0][:4],['/usr/bin/sudo','-n','/usr/bin/dpkg','--install'])
        mutation=next(i for i,e in enumerate(commands) if 'mask' in e)
        self.assertTrue(any('install' in e and '--simulate' in e for e in commands[:mutation]))
        self.assertLess(commands.index(installs[0]),next(i for i,e in enumerate(commands) if 'unmask' in e))

    def test_failures_never_reach_later_mutations(self):
        # Fresh setup per case preserves each transition's initial state.
        faults=('non-systemd','hash','metadata','conflict','dependency','dependency-version','held','downgrade','broken','audit','reverse-dependency','extra-package','removal','endpoint','dropin','nonempty','stop-reply','still-running','old-process','dpkg','autostart','lost-service','unknown-pid','start','version','api','api-min','platform')
        for fault in faults:
            with self.subTest(fault=fault):
                probe=DockerUpgrade('runTest');probe.setUp();probe.fault=fault
                try:
                    with self.assertRaises((c.Refused,ValueError)):probe.run_upgrade()
                    commands=[e for e in probe.events if isinstance(e,list)]
                    if fault in faults[:16]:self.assertFalse(any('mask' in e for e in commands))
                    if fault in ('stop-reply','still-running','old-process'):self.assertFalse(any('--install' in e for e in commands))
                    if fault in ('dpkg','autostart','lost-service','unknown-pid'):self.assertFalse(any('start' in e for e in commands))
                finally:probe.doCleanups()

    def test_overall_budget_is_failclosed(self):
        up=d.Upgrade(c,self.runner);up.deadline=0
        with self.assertRaises(c.Refused):up.install(self.pins)
        self.assertFalse(self.events)

    def execute_to_bootstrap(self, invalid_input=False, invalid_source=False):
        class ReachedBootstrap(Exception): pass
        raw=json.dumps({'schema':'neoos/dual-public-bundle/v1','files':{n:'{}' for n in ('dual-input.json','mainnet.json','testnet.json')}}).encode()
        env={'GITHUB_REPOSITORY':c.REPOSITORY,'GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','CANDIDATE_REPOSITORY_PRIVATE':'false','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_WORKFLOW_REF':c.REPOSITORY+'/.github/workflows/measured-candidate.yml@refs/heads/main','CANDIDATE_SOURCE_SHA':'1'*40,'GITHUB_SHA':'1'*40,'GITHUB_WORKFLOW_SHA':'1'*40,'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','PUBLIC_BUNDLE_BASE64':base64.b64encode(raw).decode(),'PUBLIC_BUNDLE_SHA256':c.sha(raw)}
        if invalid_source:env['GITHUB_SHA']='2'*40
        def stage(*_args):
            self.events.append('public-input-admitted')
            if invalid_input:raise c.Refused('validation')
            return self.work/'dual-input.json'
        def bootstrap(*_args):
            self.events.append('bootstrap')
            raise ReachedBootstrap()
        # The real execute and real Upgrade run throughout. Only host/transport,
        # stock public-input fixture and bootstrap execution are substituted.
        real_parse=c.parse
        def parse(data):
            v=real_parse(data)
            return self.pins if isinstance(v,dict) and v.get('schema')=='neoos/hosted-docker-packages/v1' else v
        with patch.object(c,'Runner',return_value=self.runner),patch.object(c,'check_host',return_value=16*1024**3),patch.object(c,'stage_bundle',side_effect=stage),patch.object(c,'load_builder',return_value=None),patch.object(c,'bootstrap',side_effect=bootstrap),patch.object(c,'parse',side_effect=parse):
            try:c.execute(self.work,env)
            except ReachedBootstrap:return True
        return False

    def test_execute_repairs_declared_old_api_before_bootstrap(self):
        self.assertTrue(self.execute_to_bootstrap())
        mutation=next(i for i,e in enumerate(self.events) if isinstance(e,list) and 'mask' in e)
        self.assertLess(self.events.index('public-input-admitted'),mutation)
        compatibility=next(i for i,e in enumerate(self.events) if isinstance(e,list) and e[-1]=='{{json .Server}}')
        install=next(i for i,e in enumerate(self.events) if isinstance(e,list) and '--install' in e)
        self.assertLess(install,compatibility)
        self.assertLess(compatibility,self.events.index('bootstrap'))

    def test_execute_refusals_block_bootstrap_and_publication(self):
        for fault in ('source','input','hash','metadata','conflict','dependency','reverse-dependency','stop-reply','still-running','dpkg','autostart','lost-service','unknown-pid','start','version','api'):
            with self.subTest(fault=fault):
                probe=DockerUpgrade('runTest');probe.setUp();probe.fault=fault
                try:
                    with self.assertRaises(c.Refused):probe.execute_to_bootstrap(invalid_source=fault=='source',invalid_input=fault=='input')
                    self.assertNotIn('bootstrap',probe.events)
                    self.assertFalse((probe.work/'candidate').exists())
                    if fault in ('source','input'):self.assertNotIn('download',probe.events)
                finally:probe.doCleanups()

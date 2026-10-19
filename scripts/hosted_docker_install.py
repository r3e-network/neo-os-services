"""Finite default-daemon upgrade, called only by admitted hosted orchestration.

No command-line entry point. The owning disposable GitHub VM is discarded on
failure; this is not a host repair tool and never resolves/downloads dependencies.
"""
from pathlib import Path
import re
import time

HOST = Path('/')
BUDGET_SECONDS = 180
PACKAGES = ('containerd.io', 'docker-ce-cli', 'docker-ce')
UNITS = ('docker.socket', 'docker.service', 'containerd.service')
PREFIX = 'https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/'
FIELDS = ('Package', 'Version', 'Architecture', 'Depends', 'Pre-Depends',
          'Conflicts', 'Breaks', 'Replaces', 'Recommends')
PREREQUISITES = {'libc6': '2.38', 'libseccomp2': '2.5.0',
                 'init-system-helpers': '1.54~', 'iptables': None,
                 'nftables': None, 'libsystemd0': None}


def fields(raw, separator=': '):
    result = {}
    previous = None
    for line in raw.decode().splitlines():
        if line.startswith((' ', '\t')) and separator == ': ' and previous:
            result[previous] += '\n' + line
            continue
        key, value = line.split(separator, 1)
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
        previous = key
    return result


class Upgrade:
    def __init__(self, c, runner):
        self.c, self.runner = c, runner
        self.deadline = time.monotonic() + BUDGET_SECONDS

    def require(self, value):
        self.c.require(value, 'docker_install_validation')

    def run(self, args, timeout=30):
        remaining = self.deadline - time.monotonic()
        self.c.require(remaining > 0, 'timeout')
        return self.runner.run(args, timeout=min(timeout, remaining), tool='docker')

    def sudo(self, args, timeout=30):
        return self.run(['/usr/bin/sudo', '-n', *args], timeout)

    def systemctl(self, *args):
        return self.sudo(['/usr/bin/systemctl', *args])

    def installed(self):
        raw = self.run(['/usr/bin/dpkg-query', '--show', '--showformat=${Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n'])
        result = {}
        for line in raw.decode().splitlines():
            name, version, arch, status = line.split('\t')
            # Reject duplicate/multiarch names rather than guessing dependencies.
            self.require(name not in result)
            result[name] = {'version': version, 'arch': arch, 'status': status}
        return result

    def units(self, state):
        result = {}
        for unit in UNITS:
            row = fields(self.run(['/usr/bin/systemctl', 'show', unit, '--no-pager', '--all',
                                  '--property=Id,LoadState,ActiveState,SubState,MainPID,ExecStart,FragmentPath,DropInPaths,Listen']), '=')
            self.require(row['Id'] == unit and row['DropInPaths'] == '')
            self.require(row['ActiveState'] == state)
            pid = row.get('MainPID', '0')
            self.require(re.fullmatch(r'[0-9]+', pid) is not None)
            if state == 'inactive':
                self.require(pid == '0' and row['LoadState'] == 'masked')
                mask = HOST / 'run/systemd/system' / unit
                self.require(mask.is_symlink() and str(mask.readlink()) == '/dev/null')
            else:
                self.require(row['LoadState'] == 'loaded')
                self.require(row['FragmentPath'] in ('/lib/systemd/system/' + unit, '/usr/lib/systemd/system/' + unit))
                if unit == 'docker.socket':
                    self.require(pid == '0' and row['Listen'] in ('/run/docker.sock (Stream)', '/var/run/docker.sock (Stream)'))
                else:
                    binary = '/usr/bin/dockerd' if unit == 'docker.service' else '/usr/bin/containerd'
                    argv = binary + (' -H fd:// --containerd=/run/containerd/containerd.sock' if unit == 'docker.service' else '')
                    self.require(int(pid) > 1 and ('path=' + binary + ' ; argv[]=' + argv + ' ;') in row['ExecStart'])
                    proc = '/proc/' + pid + '/exe'
                    self.require(self.sudo(['/usr/bin/readlink', proc]).decode().strip() == binary)
                    live_hash = self.sudo(['/usr/bin/sha256sum', proc]).decode().split()[0]
                    self.require(live_hash == self.c.file_sha(HOST / binary.lstrip('/')))
            result[unit] = row
        processes = set()
        for line in self.run(['/usr/bin/ps', '-eo', 'pid=,comm=']).decode().splitlines():
            pid, command = line.strip().split(None, 1)
            self.require(pid.isdigit())
            name = Path(command).name
            if name.startswith(('dockerd', 'containerd', 'docker-proxy', 'runc')):
                processes.add(pid)
        expected = set() if state == 'inactive' else {result[u]['MainPID'] for u in ('docker.service', 'containerd.service')}
        self.require(processes == expected)
        return result

    def host_config(self):
        self.require((HOST / 'proc/1/comm').read_text().strip() == 'systemd')
        self.require((HOST / 'run/systemd/system').is_dir())
        self.require(self.run(['/usr/bin/dpkg', '--print-architecture']).strip() == b'amd64')
        self.require((HOST / 'var/run').resolve() == (HOST / 'run').resolve())
        for binary, package in (('/usr/bin/docker', 'docker-ce-cli'), ('/usr/bin/dockerd', 'docker-ce'), ('/usr/bin/containerd', 'containerd.io')):
            path = HOST / binary.lstrip('/')
            self.require(path.is_file() and not path.is_symlink())
            self.require(self.run(['/usr/bin/dpkg-query', '--search', binary]).decode().strip() == package + ': ' + binary)
        # No endpoint/config migration. A configured TCP/alternate host or custom
        # containerd endpoint requires a new proposal, never silent rewriting.
        config = HOST / 'etc/docker/daemon.json'
        if config.exists():
            self.require(config.is_file() and not config.is_symlink() and config.stat().st_size <= 16384)
            value = self.c.parse(config.read_bytes())
            self.require(isinstance(value, dict) and not set(value) & {'hosts', 'containerd', 'tls', 'tlsverify', 'tlscacert', 'tlscert', 'tlskey'})
        self.require(not any((HOST / 'run/systemd/system' / unit).exists() or (HOST / 'run/systemd/system' / unit).is_symlink() for unit in UNITS))

    def prepare(self, pins):
        self.require(pins['schema'] == 'neoos/hosted-docker-packages/v1')
        packages = pins['packages']
        self.require([p['Package'] for p in packages] == list(PACKAGES))
        paths = []
        directory = self.runner.root / 'docker-packages'
        directory.mkdir(mode=0o700)
        # Verify ALL archives before dpkg-deb parses any control data.
        for p in packages:
            name = p['filename']
            self.require(re.fullmatch(r'[a-z0-9_.~+-]+\.deb', name) is not None)
            self.require(p['Architecture'] == 'amd64' and p['url'] == PREFIX + name)
            path = directory / name
            self.c.download(p['url'], {'size': p['size'], 'sha256': p['sha256']}, path, self.runner, self.deadline)
            self.require(path.stat().st_size == p['size'] and self.c.file_sha(path) == p['sha256'])
            paths.append(path)
        for p, path in zip(packages, paths):
            control = fields(self.run(['/usr/bin/dpkg-deb', '--field', path]))
            self.require(all(control.get(key) == p.get(key) for key in FIELDS))
        self.require(not self.run(['/usr/bin/dpkg', '--audit']).strip())
        installed = self.installed()
        for name in ('docker.io', 'docker-cli', 'containerd', 'runc'):
            self.require(name not in installed or installed[name]['status'][1:] in ('n ', 'c '))
        for name, minimum in PREREQUISITES.items():
            self.require(name in installed and installed[name]['status'] == 'ii ')
            if minimum:
                self.run(['/usr/bin/dpkg', '--compare-versions', installed[name]['version'], 'ge', minimum])
        for p in packages:
            row = installed.get(p['Package'], {})
            self.require(row.get('status') == 'ii ' and row.get('arch') == 'amd64')
            self.run(['/usr/bin/dpkg', '--compare-versions', row['version'], 'le', p['Version']])
        # APT simulation validates the full prospective dependency graph, including
        # reverse dependencies/Breaks, but may not download/remove/add any package.
        apt = ['/usr/bin/apt-get', '--simulate', '--no-download', '--no-remove', '--no-install-recommends']
        self.run([*apt, 'check'])
        plan = self.run([*apt, '--reinstall', 'install', *paths]).decode()
        selected = {p['Package']: p['Version'] for p in packages}
        seen = set()
        for line in plan.splitlines():
            self.require(not line.startswith(('Remv ', 'Purg ')))
            if line.startswith('Inst '):
                match = re.fullmatch(r'Inst ([a-z0-9.+-]+)(?: \[[^\]]+\])? \(([^ ]+) [^\n]+\)', line)
                self.require(match is not None)
                name, version = match.groups()
                self.require(name not in seen and selected.get(name) == version)
                seen.add(name)
            elif line.startswith('Conf '):
                match = re.fullmatch(r'Conf ([a-z0-9.+-]+) \(([^ ]+) [^\n]+\)', line)
                self.require(match is not None and selected.get(match[1]) == match[2])
        self.require(seen == set(PACKAGES))
        return paths, installed

    def install(self, pins):
        c, runner = self.c, self.runner
        c.phase('docker-install-check')
        self.host_config()
        before = self.units('active')
        initial = runner.inventory()
        self.require(not initial['containers'] and not initial['volumes'])
        paths, old_packages = self.prepare(pins)
        # Recheck immediately before the first mutation, after all package gates.
        self.require(self.units('active') == before and runner.inventory() == initial)
        runner.resources()
        c.phase('docker-install')
        self.systemctl('mask', '--runtime', *UNITS)
        self.systemctl('stop', *UNITS)
        self.units('inactive')
        for unit in ('docker.service', 'containerd.service'):
            self.require(not (HOST / ('proc/' + before[unit]['MainPID'])).exists())
        self.sudo(['/usr/bin/dpkg', '--install', *paths], timeout=120)
        self.systemctl('daemon-reload')
        # Pinned maintainer scripts request starts/restarts. Runtime masks must
        # remain intact and every unit stopped before deliberate unmask/start.
        self.units('inactive')
        after_packages = self.installed()
        for p in pins['packages']:
            self.require(after_packages[p['Package']] == {'version': p['Version'], 'arch': 'amd64', 'status': 'ii '})
        expected = dict(old_packages)
        for p in pins['packages']:
            expected[p['Package']] = {'version': p['Version'], 'arch': 'amd64', 'status': 'ii '}
        self.require(after_packages == expected)
        self.require(not self.run(['/usr/bin/dpkg', '--audit']).strip())
        self.run(['/usr/bin/apt-get', '--simulate', '--no-download', '--no-remove', '--no-install-recommends', 'check'])
        self.systemctl('unmask', '--runtime', *UNITS)
        self.systemctl('daemon-reload')
        self.systemctl('start', 'containerd.service', 'docker.socket', 'docker.service')
        c.phase('docker-install-readback')
        self.host_config()
        after = self.units('active')
        for unit in ('docker.service', 'containerd.service'):
            self.require(after[unit]['MainPID'] != before[unit]['MainPID'])
        for unit, digest in pins['unit_sha256'].items():
            self.require(c.file_sha(HOST / after[unit]['FragmentPath'].lstrip('/')) == digest)
        version = c.parse(self.run([*runner.docker, 'version', '--format', '{{json .}}']))
        for name in ('Client', 'Server'):
            v = version[name]
            self.require(v['Version'] == pins['engine_version'] and v['Os'] == 'linux' and v['Arch'] == 'amd64')
        self.require(c.api_version(version['Server']['MinAPIVersion']) <= (1, 49) <= c.api_version(version['Server']['ApiVersion']))
        self.require(runner.inventory() == initial)
        runner.resources()
        self.c.require(time.monotonic() < self.deadline, 'timeout')
        return {'manifest_sha256': c.file_sha(c.ROOT / 'deploy/nitro/hosted-docker-packages.json'),
                'packages': [{key: p[key] for key in ('Package', 'Version', 'sha256', 'size')} for p in pins['packages']],
                'prior_packages': {name: old_packages[name] for name in PACKAGES},
                'before_units': before, 'after_units': after,
                'executables': {name: c.file_sha(HOST / ('usr/bin/' + name)) for name in ('docker', 'dockerd', 'containerd')},
                'client_version': version['Client']['Version'], 'server_version': version['Server']['Version']}


def install(c, runner):
    pins = c.parse((c.ROOT / 'deploy/nitro/hosted-docker-packages.json').read_bytes())
    return Upgrade(c, runner).install(pins)

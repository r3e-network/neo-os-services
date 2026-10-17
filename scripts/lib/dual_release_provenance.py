"""Committed Git snapshot capture for the supplemental dual release checker."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import shutil
import stat

from dual_release_validation import affected, digest, encoded, path, require, sha

TOOLS = ('scripts/check-dual-release.mjs', 'scripts/lib/check_dual_release.py',
         'scripts/lib/dual_release_validation.py', 'scripts/lib/dual_release_provenance.py')
LIMIT = 64 * 1024 * 1024


class Capture:
    def __init__(self, root, base):
        self.root = Path(root).resolve()
        digest(base, 40)
        self.env = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': '/nonexistent',
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                    'GIT_NO_REPLACE_OBJECTS': '1',
                    'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0'}
        require(not any(k.startswith('GIT_') for k in os.environ
                        if k not in ('GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
                                     'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT')), 'Git environment override')
        self.require_full_history()
        self.head = self.git('rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
        require(self.git('rev-parse', '--verify', base + '^{commit}').decode().strip() == base, 'exact base OID')
        self.base = base
        self.tree = self.git('rev-parse', self.head + '^{tree}').decode().strip()
        self.base_tree = self.git('rev-parse', base + '^{tree}').decode().strip()
        self.merge_base = self.git('merge-base', base, self.head).decode().strip()
        require(self.merge_base == self.base, 'base must be an ancestor of HEAD')
        self.parents = self.git('rev-list', '--parents', '-n', '1', self.head).decode().split()[1:]
        self.require_clean()
        self.files = self.snapshot(self.head)
        # Bind this gate's named local source files, not a publication tool bundle
        # or an immutable execution sandbox. Independent source review is required.
        self.require_tool_sources()
        context = sys.modules.get('dual_release_execution')
        if context is not None:
            require(context.head == self.head, 'HEAD changed before capture')
        self.changes = []
        raw = self.git('diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
                       '--abbrev=40', base + '...' + self.head).split(b'\0')
        for i in range(0, len(raw) - 1, 2):
            old_mode, new_mode, old_oid, new_oid, status = raw[i][1:].decode().split()
            name = raw[i + 1].decode(); path(name)
            self.changes.append(dict(path=name, old_mode=old_mode, new_mode=new_mode,
                                     old_oid=old_oid, new_oid=new_oid, status=status))

    def require_full_history(self):
        require(self.git('rev-parse', '--is-shallow-repository').strip() == b'false', 'full history required')
        require(not self.git('for-each-ref', '--format=%(refname)', 'refs/replace').strip(), 'replacement refs')
        graft = self.git('rev-parse', '--git-path', 'info/grafts').decode().strip()
        require(not (self.root / graft).exists(), 'grafted history')

    def require_tool_sources(self):
        here = Path(__file__).resolve().parents[2]
        for name in TOOLS:
            cursor = here
            for part in name.split('/'):
                cursor = cursor / part
                require(not cursor.is_symlink(), 'symlink executing tool source')
            require(name in self.files and cursor.is_file() and
                    stat.S_ISREG(cursor.stat().st_mode), 'missing executing tool source')
            mode = '100755' if cursor.stat().st_mode & 0o111 else '100644'
            require(self.files[name] == (mode, cursor.read_bytes()), 'executing tool differs from HEAD')
            context = sys.modules.get('dual_release_execution')
            if context is not None:
                require(context.sources.get(name) == self.files[name], 'executed bytes differ from HEAD')

    def git(self, *args):
        result = subprocess.run(['git', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
                                 '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
                                 '-c', 'maintenance.auto=false', *args], cwd=self.root, env=self.env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30)
        require(result.returncode == 0 and len(result.stdout) <= LIMIT, 'Git provenance unavailable')
        return result.stdout

    def require_clean(self):
        # `git status` can execute repository clean filters. Compare raw index,
        # committed blobs and worktree bytes ourselves; never ask Git to convert
        # worktree content. No index stat refresh or writes are needed.
        require(not self.git('ls-files', '--others', '--exclude-standard', '-z'), 'clean committed HEAD required')
        tree = {}
        for row in self.git('ls-tree', '-r', '-z', '--full-tree', self.head).split(b'\0'):
            if not row:
                continue
            meta, raw_name = row.split(b'\t', 1)
            mode, kind, oid = meta.decode().split(); name = raw_name.decode()
            # Whole-repository names include Next.js brackets and systemd '@'.
            # Release-bundle syntax is intentionally narrower and stays separate.
            require(name and len(raw_name) <= 4096 and not name.startswith('/') and
                    all(part not in ('', '.', '..') for part in name.split('/')),
                    'unsafe tracked path')
            require(kind == 'blob' and mode in ('100644', '100755', '120000'), 'nonregular tracked input')
            tree[name] = (mode, oid)
        index = {}
        for row in self.git('ls-files', '--stage', '-z').split(b'\0'):
            if not row:
                continue
            meta, raw_name = row.split(b'\t', 1)
            mode, oid, stage = meta.decode().split(); name = raw_name.decode()
            require(stage == '0' and name not in index, 'clean committed HEAD required')
            index[name] = (mode, oid)
        require(index == tree, 'clean committed HEAD required')
        for name, (mode, oid) in tree.items():
            cursor = self.root
            for part in name.split('/')[:-1]:
                cursor = cursor / part
                require(not cursor.is_symlink(), 'symlink worktree input')
            cursor = cursor / name.rsplit('/', 1)[-1]
            require(cursor.exists() or cursor.is_symlink(), 'worktree bytes/mode differ from HEAD')
            if mode == '120000':
                require(cursor.is_symlink(), 'worktree bytes/mode differ from HEAD')
                data = os.fsencode(os.readlink(cursor))
                actual_mode = '120000'
            else:
                require(not cursor.is_symlink() and stat.S_ISREG(cursor.stat().st_mode) and
                        cursor.stat().st_size <= LIMIT, 'worktree bytes/mode differ from HEAD')
                with cursor.open('rb') as stream:
                    data = stream.read(LIMIT + 1)
                require(len(data) <= LIMIT, 'worktree input size limit')
                actual_mode = '100755' if cursor.stat().st_mode & 0o111 else '100644'
            actual_oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            require((actual_mode, actual_oid) == (mode, oid), 'worktree bytes/mode differ from HEAD')

    def snapshot(self, revision):
        files = {}
        total = 0
        for row in self.git('ls-tree', '-r', '-z', '--full-tree', revision).split(b'\0'):
            if not row:
                continue
            meta, raw_name = row.split(b'\t', 1)
            mode, kind, oid = meta.decode().split(); name = raw_name.decode()
            if not (affected(name) or name.startswith(('deploy/nitro/', 'scripts/')) or
                    name in ('apps/web/lib/nitro-dual-release-registry.ts', 'apps/web/lib/nitro-measurements.ts')):
                continue
            path(name)
            require(kind == 'blob' and mode in ('100644', '100755'), 'nonregular captured input')
            data = self.git('cat-file', 'blob', oid)
            total += len(data)
            require(total <= LIMIT, 'snapshot size limit')
            require(hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == oid, 'Git object identity')
            files[name] = (mode, data)
            if revision == self.head:
                cursor = self.root
                for part in name.split('/'):
                    cursor = cursor / part
                    require(not cursor.is_symlink(), 'symlink worktree input')
                require(cursor.is_file() and cursor.read_bytes() == data and
                        ('100755' if cursor.stat().st_mode & 0o111 else '100644') == mode,
                        'worktree bytes/mode differ from HEAD')
        return files

    def recheck(self):
        self.require_full_history()
        require(self.git('rev-parse', 'HEAD').decode().strip() == self.head, 'HEAD changed during audit')
        self.require_clean()
        require(self.snapshot(self.head) == self.files, 'inputs changed during audit')
        self.require_tool_sources()

    def receipt(self):
        git_executable = Path(shutil.which('git', path=self.env['PATH'])).resolve()
        tool_files = {n: {'mode': self.files[n][0], 'size': len(self.files[n][1]),
                          'sha256': sha(self.files[n][1])} for n in sorted(TOOLS)}
        return {'gate_tool_bundle': {'scope': 'supplemental-source-gate-only',
                                     'files': tool_files, 'sha256': sha(encoded(tool_files))},
                'runtime': {'python': sys.version,
                            'isolated': bool(sys.flags.isolated), 'no_site': bool(sys.flags.no_site),
                            'verified_memory_sources': 'dual_release_execution' in sys.modules, 'python_executable_sha256': sha(Path(sys.executable).resolve().read_bytes()),
                            'git_executable_sha256': sha(git_executable.read_bytes())},
                'head': {'commit': self.head, 'tree': self.tree, 'parents': self.parents},
                'base': {'commit': self.base, 'tree': self.base_tree}, 'merge_base': self.merge_base,
                'changes': self.changes,
                'tools': [{'path': n, 'mode': self.files[n][0], 'sha256': sha(self.files[n][1])} for n in TOOLS],
                'files': [{'path': n, 'mode': m, 'sha256': sha(b)} for n, (m, b) in sorted(self.files.items())]}

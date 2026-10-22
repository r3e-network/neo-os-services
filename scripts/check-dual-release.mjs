/** Verified-source launcher for the supplemental gate, not full admission. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const paths = [
  'scripts/check-dual-release.mjs',
  'scripts/lib/check_dual_release.py',
  'scripts/lib/dual_release_validation.py',
  'scripts/lib/dual_release_provenance.py',
];
const allowedGit = new Set([
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_OPTIONAL_LOCKS',
  'GIT_TERMINAL_PROMPT',
]);
const runtimeEnv = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/nonexistent' };
const gitEnv = {
  ...runtimeEnv,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};
function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
function refuse(message) {
  console.log(
    JSON.stringify({
      schema: 'neoos/dual-source-prerequisite/v1',
      scope: 'supplemental-source-prerequisite',
      full_admission: false,
      complete: false,
      passed: false,
      diagnostics: [{ code: 'DUAL_PROVENANCE_FAILED', message }],
    })
  );
  process.exitCode = 2;
}
// -I excludes PYTHONPATH/user-site/cwd; -S excludes site/startup hooks.
// No filesystem loader handles gate modules: compile the exact verified bytes
// retained in this process. -B alone would still allow unchecked cached pyc.
const bootstrap = String.raw`
import base64, hashlib, importlib.abc, importlib.util, json, sys, types
from types import MappingProxyType
if len(sys.argv) != 2 or not sys.argv[1].isascii() or not sys.argv[1].isdecimal():
    raise ValueError('Invalid input frame length')
input_size = int(sys.argv[1])
if str(input_size) != sys.argv[1] or not 0 < input_size <= 8 * 1024 * 1024:
    raise ValueError('Invalid input frame length')
# A complete frame is sufficient even if the parent pipe has not closed yet.
data = sys.stdin.buffer.read(input_size)
if len(data) != input_size:
    raise ValueError('Incomplete input frame')
payload = json.loads(data)
assert sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode
records = {}
for name, record in payload['sources'].items():
    data = base64.b64decode(record['data'], validate=True)
    assert hashlib.sha256(data).hexdigest() == record['sha256']
    records[name] = (record['mode'], data)
context = types.ModuleType('dual_release_execution')
context.sources = MappingProxyType(records)
context.head = payload['head']
sys.modules[context.__name__] = context
modules = {name.rsplit('/', 1)[-1][:-3]: name for name in records if name.endswith('.py')}
class VerifiedLoader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in modules:
            return importlib.util.spec_from_loader(fullname, self)
        return None
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        name = modules[module.__name__]
        filename = payload['source_root'] + '/' + name
        module.__file__ = filename
        exec(compile(records[name][1], filename, 'exec', dont_inherit=True), module.__dict__)
sys.meta_path.insert(0, VerifiedLoader())
sys.argv = [payload['source_root'] + '/scripts/lib/check_dual_release.py', '--root', payload['root'], '--base', payload['base']]
import check_dual_release
sys.exit(check_dual_release.main())
`;
try {
  // Check the original environment before replacing it; never silently strip
  // a dangerous Git override and then claim it was accepted safely.
  requireValue(
    !Object.keys(process.env).some((key) => key.startsWith('GIT_') && !allowedGit.has(key)),
    'Git environment override'
  );
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let root = sourceRoot;
  let base;
  const seen = new Set();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    requireValue(
      ['--root', '--base'].includes(flag) && !seen.has(flag) && typeof args[i + 1] === 'string',
      'Expected --base full commit and optional --root'
    );
    seen.add(flag);
    if (flag === '--root') root = resolve(args[i + 1]);
    else base = args[i + 1];
  }
  requireValue(typeof base === 'string' && /^[0-9a-f]{40}$/.test(base), 'Exact base OID required');
  const git = (...gitArgs) => {
    const run = spawnSync(
      'git',
      [
        '--no-replace-objects',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'maintenance.auto=false',
        ...gitArgs,
      ],
      { cwd: root, env: gitEnv, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }
    );
    requireValue(!run.error && run.status === 0, 'Git pre-execution identity unavailable');
    return run.stdout;
  };
  const head = git('rev-parse', '--verify', 'HEAD^{commit}').toString().trim();
  requireValue(/^[0-9a-f]{40}$/.test(head), 'Invalid committed HEAD');
  const sources = {};
  for (const name of paths) {
    let cursor = sourceRoot;
    for (const part of name.split('/')) {
      cursor = join(cursor, part);
      requireValue(!lstatSync(cursor).isSymbolicLink(), 'Symlink executing tool source');
    }
    const info = lstatSync(cursor);
    requireValue(info.isFile() && info.size <= 1024 * 1024, 'Bounded regular tool source required');
    const data = readFileSync(cursor);
    const mode = info.mode & 0o111 ? '100755' : '100644';
    const entry = git('ls-tree', head, '--', name).toString();
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\n]+)\n$/.exec(entry);
    requireValue(
      match && match[3] === name && match[1] === mode,
      'Executing tool mode differs from HEAD'
    );
    const committed = git('cat-file', 'blob', match[2]);
    const oid = createHash('sha1')
      .update(Buffer.from(`blob ${committed.length}\0`))
      .update(committed)
      .digest('hex');
    requireValue(oid === match[2] && data.equals(committed), 'Executing tool differs from HEAD');
    sources[name] = {
      mode,
      data: data.toString('base64'),
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }
  requireValue(
    git('rev-parse', 'HEAD').toString().trim() === head,
    'HEAD changed before execution'
  );
  const payload = { sources, source_root: sourceRoot, root, base, head };
  const input = Buffer.from(JSON.stringify(payload), 'utf8');
  requireValue(input.length > 0 && input.length <= 8 * 1024 * 1024, 'Bounded input frame required');
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', bootstrap, String(input.length)], {
    env: runtimeEnv,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
  requireValue(
    !result.error && [1, 2].includes(result.status),
    'Isolated source gate execution failed'
  );
  const output = JSON.parse(result.stdout);
  requireValue(
    output.complete === false && output.passed === false && output.full_admission === false,
    'Unexpected admission result'
  );
  process.stdout.write(result.stdout);
  process.exitCode = result.status;
} catch (error) {
  // No subprocess stderr, input bytes or filesystem details in public errors.
  const safe = new Set([
    'Git environment override',
    'Expected --base full commit and optional --root',
    'Exact base OID required',
    'Git pre-execution identity unavailable',
    'Invalid committed HEAD',
    'Symlink executing tool source',
    'Bounded regular tool source required',
    'Executing tool mode differs from HEAD',
    'Executing tool differs from HEAD',
    'HEAD changed before execution',
    'Bounded input frame required',
    'Isolated source gate execution failed',
    'Unexpected admission result',
  ]);
  refuse(safe.has(error.message) ? error.message : 'Cannot verify gate execution sources');
}

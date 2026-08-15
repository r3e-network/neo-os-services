import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from './common.mjs';

process.env.MORPHEUS_NETWORK ||= 'testnet';
process.env.NEXT_PUBLIC_MORPHEUS_NETWORK ||= process.env.MORPHEUS_NETWORK;

const scripts = [
  'examples/scripts/test-n3-examples.mjs',
];

for (const script of scripts) {
  console.log(`\n==> ${script}`);
  execFileSync('node', [path.resolve(repoRoot, script)], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

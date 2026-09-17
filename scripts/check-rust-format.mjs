import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { auditRustFormat } from './lib-rust-format.mjs';

function main() {
  const failures = auditRustFormat();
  if (failures.length > 0) {
    console.error('Rust format gate failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('Rust format gate passed (handwritten rustfmt + generated identity).');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES } from './lib-neo-signers.mjs';

const DEFAULT_ROOTS = [
  process.cwd(),
  '/Users/jinghuiliao/git',
  '/Users/jinghuiliao/Documents/Codex',
  '/Users/jinghuiliao/.codex',
];

const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS;
const wanted = /(^|\/)(\.env[^/]*|.*env.*|.*secret.*|.*nitro.*|.*morpheus.*)$/i;
const skipPath =
  /\/node_modules\/|\/\.git\/|\/\.next\/|\/dist\/|\/build\/|\/coverage\/|\.(png|jpe?g|gif|webp|pdf|zip|gz|tar|sqlite|db|log)$/i;
const keyLike =
  /(?:^|[^A-Za-z0-9])((?:[KL][1-9A-HJ-NP-Za-km-z]{51})|(?:[a-fA-F0-9]{64}))(?:$|[^A-Za-z0-9])/g;
const envLine = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;
const maxFileSize = 1024 * 1024;

const files = [];

async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (skipPath.test(full)) continue;
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!entry.isFile() || !wanted.test(full)) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.size <= maxFileSize) files.push(full);
    } catch {
      // Ignore unreadable files.
    }
  }
}

// S5: the pinned-role resolver materializes no plaintext key, so this audit cannot
// say which role a found secret belongs to. (Before this, every candidate came
// back as matching oracle_verifier — its public-key-only path reports ok with no
// key at all — so the report named roles it never checked.) It now lists every
// key-like value it finds by file, line, variable and fingerprint (never the whole
// value), marks the variables a pinned-role resolution used to read before S5,
// and exits 1 when anything is found: a leftover plaintext key fails the audit.
const RETIRED_SIGNER_NAMES = new Set(
  Object.values(NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES).flatMap((byRole) =>
    Object.values(byRole).flat()
  )
);

for (const root of roots) await walk(path.resolve(root));

const seen = new Set();
const candidates = [];
for (const file of files) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    continue;
  }
  let lineNo = 0;
  for (const line of raw.split(/\r?\n/)) {
    lineNo += 1;
    if (!/(WIF|PRIVATE|KEY|SECRET|NEO|ORACLE|RELAYER|UPDATER|MORPHEUS)/i.test(line)) {
      continue;
    }
    const parsedLine = line.match(envLine);
    const key = parsedLine ? parsedLine[1] : '(inline)';
    keyLike.lastIndex = 0;
    for (const match of line.matchAll(keyLike)) {
      const value = match[1];
      const fingerprint = `${value.slice(0, 4)}:${value.length}:${value.slice(-4)}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      candidates.push({
        file,
        line: lineNo,
        key,
        fingerprint,
        retired_signer_name: RETIRED_SIGNER_NAMES.has(key),
      });
    }
  }
}

console.log(
  JSON.stringify(
    {
      ok: candidates.length === 0,
      roots,
      files_scanned: files.length,
      candidates_scanned: candidates.length,
      role_mapping:
        'unavailable: S5 retired plaintext Neo N3 signer keys, so no candidate is materialized or matched to a role',
      candidates,
    },
    null,
    2
  )
);
if (candidates.length) process.exitCode = 1;

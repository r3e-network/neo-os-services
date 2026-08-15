import fs from 'node:fs/promises';
import path from 'node:path';
import { reportPinnedNeoN3Role } from './lib-neo-signers.mjs';

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

function roleEnvForSecret(role, value) {
  const env = {};
  const prefix =
    role === 'oracle_verifier'
      ? 'MORPHEUS_ORACLE_VERIFIER'
      : `MORPHEUS_${role.toUpperCase()}_NEO_N3`;
  if (/^[KL]/.test(value)) env[`${prefix}_WIF_MAINNET`] = value;
  else env[`${prefix}_PRIVATE_KEY_MAINNET`] = value;
  return env;
}

function auditSecret(value) {
  return ['worker', 'relayer', 'updater', 'oracle_verifier'].map((role) => {
    const report = reportPinnedNeoN3Role('mainnet', role, {
      env: roleEnvForSecret(role, value),
      allowMissing: false,
    });
    return {
      role,
      ok: report.ok,
      selected: report.selected_identity?.script_hash || null,
      pinned: report.pinned?.script_hash || null,
    };
  });
}

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
      const identities = auditSecret(value);
      const matches = identities.filter((entry) => entry.ok).map((entry) => entry.role);
      candidates.push({
        file,
        line: lineNo,
        key,
        fingerprint,
        matches,
        identities: identities.map(({ role, selected }) => ({ role, selected })),
      });
    }
  }
}

const matching = candidates.filter((entry) => entry.matches.length);
console.log(
  JSON.stringify(
    {
      roots,
      files_scanned: files.length,
      candidates_scanned: candidates.length,
      matching_candidates: matching.length,
      matching,
    },
    null,
    2
  )
);

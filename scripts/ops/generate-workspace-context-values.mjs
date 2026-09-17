import fs from 'node:fs';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeEol(value) {
  return value.replace(/\r\n/g, '\n');
}

function listExistingFiles(candidatePaths) {
  return candidatePaths.filter(fileExists);
}

function globEnvFiles(repoRoot, extra = []) {
  const candidates = new Set();
  const base = [
    '.env',
    '.env.local',
    '.env.development.local',
    '.env.production.local',
    '.env.test.local',
    '.env.ci',
    ...extra,
  ];

  for (const name of base) {
    candidates.add(path.join(repoRoot, name));
  }

  // Also include any `.env.*.local` variants (common pattern).
  try {
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('.env.')) continue;
      if (!entry.name.endsWith('.local')) continue;
      candidates.add(path.join(repoRoot, entry.name));
    }
  } catch {
    // ignore
  }

  return listExistingFiles([...candidates]);
}

function safeRel(fromDir, absolutePath) {
  try {
    const rel = path.relative(fromDir, absolutePath);
    return rel.startsWith('..') ? absolutePath : rel;
  } catch {
    return absolutePath;
  }
}

function renderFileSection({ repoRoot, filePath }) {
  const ext = path.extname(filePath).toLowerCase();
  const language = ext === '.toml' ? 'toml' : ext === '.json' ? 'json' : 'dotenv';
  const headerPath = safeRel(repoRoot, filePath);
  const content = normalizeEol(readText(filePath)).trimEnd();

  return [`### \`${headerPath}\``, '', '```' + language, content, '```', ''].join('\n');
}

function collectKeysFromText(text) {
  const keys = new Set();
  const normalized = normalizeEol(text);
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=/);
    if (!match) continue;
    keys.add(match[1]);
  }
  return keys;
}

function union(sets) {
  const out = new Set();
  for (const set of sets) {
    for (const item of set) out.add(item);
  }
  return out;
}

function sortAlpha(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function buildRequiredKeyList() {
  // Keep this list aligned with docs/WORKSPACE_CONTEXT.md.
  return [
    // Supabase
    'SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    // Cloudflare / Upstash
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_DNS_API_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    // Sentry
    'NEXT_PUBLIC_SENTRY_DSN',
    'SENTRY_DSN',
    'SENTRY_ENVIRONMENT',
    'SENTRY_TRACES_SAMPLE_RATE',
    'SENTRY_PROFILES_SAMPLE_RATE',
    'SENTRY_ORG',
    'SENTRY_PROJECT',
    'SENTRY_AUTH_TOKEN',
    // Checkly
    'CHECKLY_API_KEY',
    'CHECKLY_ACCOUNT_ID',
    'CHECKLY_PROJECT_NAME',
    // Turnstile
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
    // Email
    'RESEND_API_KEY',
    // Oracle runtime access
    'MORPHEUS_RUNTIME_URL',
    'MORPHEUS_RUNTIME_TOKEN',
    // Control plane
    'MORPHEUS_CONTROL_PLANE_URL',
    'MORPHEUS_CONTROL_PLANE_API_KEY',
    // Neo signers
    'NEO_TESTNET_WIF',
    'TEST_WIF',
    'AA_TEST_WIF',
    'ORACLE_TEST_WIF',
    'FLAGSHIP_LIVE_WIF',
    'AA_RELAY_WIF',
    // Neo RPC
    'NEO_RPC_URL',
    // Feed providers
    'TWELVEDATA_API_KEY',
    // Web3Auth
    'WEB3AUTH_CLIENT_ID',
    'WEB3AUTH_CLIENT_SECRET',
    'WEB3AUTH_JWKS_URL',
    'VITE_WEB3AUTH_CLIENT_ID',
    'VITE_WEB3AUTH_NETWORK',
    // AA relay config
    'AA_RELAY_RPC_URL',
    'VITE_AA_RELAY_RPC_URL',
    'VITE_AA_RELAY_URL',
    'AA_RELAY_ALLOWED_HASH',
  ];
}

function collectRepoSections({ title, repoRoot, extraFiles = [] }) {
  const files = [
    ...globEnvFiles(repoRoot, extraFiles),
    ...listExistingFiles(extraFiles.map((p) => path.join(repoRoot, p))),
  ];

  const unique = [...new Set(files)].sort((a, b) => a.localeCompare(b));
  const rendered = unique.map((filePath) => renderFileSection({ repoRoot, filePath }));

  const keySets = unique.map((filePath) => collectKeysFromText(readText(filePath)));
  const keys = union(keySets);

  return { title, repoRoot, files: unique, rendered, keys };
}

function main() {
  const oracleRoot = process.cwd();
  const siblingRoot = path.resolve(oracleRoot, '..');

  const aaRoot = path.join(siblingRoot, 'neo-os-aa');
  const platformRoot = path.join(siblingRoot, 'neo-os-web');

  const oracleExtra = [
    'deploy/nitro/morpheus.env',
    'deploy/nitro/morpheus.mainnet.env',
    'deploy/nitro/morpheus.testnet.env',
    'deploy/cloudflare/morpheus-edge-gateway/wrangler.meshmini.toml',
    'deploy/cloudflare/morpheus-control-plane/wrangler.meshmini.toml',
    'apps/web/.env.local',
  ];

  const aaExtra = ['frontend/.env.local', 'frontend/.env'];

  const platformExtra = ['platform/host-app/.env.local', 'platform/admin-console/.env.local'];

  const sections = [];

  sections.push(
    collectRepoSections({
      title: 'neo-os-services',
      repoRoot: oracleRoot,
      extraFiles: oracleExtra,
    })
  );
  if (fs.existsSync(aaRoot)) {
    sections.push(
      collectRepoSections({ title: 'neo-os-aa', repoRoot: aaRoot, extraFiles: aaExtra })
    );
  }
  if (fs.existsSync(platformRoot)) {
    sections.push(
      collectRepoSections({
        title: 'neo-os-web',
        repoRoot: platformRoot,
        extraFiles: platformExtra,
      })
    );
  }

  const allKeys = union(sections.map((section) => section.keys));
  const requiredKeys = new Set(buildRequiredKeyList());
  const missing = sortAlpha([...requiredKeys].filter((key) => !allKeys.has(key)));

  const outDir = path.join(oracleRoot, 'private-backups');
  ensureDir(outDir);
  const outPath = path.join(outDir, 'WORKSPACE_CONTEXT_VALUES.md');

  const lines = [];
  lines.push('# Workspace Context Values (Sensitive)');
  lines.push('');
  lines.push(
    'This file contains **secret values** and is intentionally located under `private-backups/` (gitignored).'
  );
  lines.push('Do not commit it. Prefer encrypting it before sharing or storing off-machine.');
  lines.push('');
  lines.push(`Generated: \`${nowIso()}\``);
  lines.push('');
  lines.push('## Included Files');
  lines.push('');
  for (const section of sections) {
    lines.push(`- **${section.title}**: ${section.files.length} file(s)`);
  }
  lines.push('');
  if (missing.length) {
    lines.push('## Missing Keys (Not Found In Local Env Files)');
    lines.push('');
    lines.push('These keys were not found in any discovered local `.env` / runtime env files.');
    lines.push(
      'If you want this document to be fully self-contained, add them to a local env file under `private-backups/` and re-run the generator.'
    );
    lines.push('');
    for (const key of missing) {
      lines.push(`- \`${key}\``);
    }
    lines.push('');
  }

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push('');
    lines.push(`Repo root: \`${section.repoRoot}\``);
    lines.push('');
    if (!section.rendered.length) {
      lines.push('_No local env/config files discovered._');
      lines.push('');
      continue;
    }
    lines.push(...section.rendered.join('\n').split('\n'));
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  // IMPORTANT: Do not print secret contents to stdout.
  console.log(`Wrote ${outPath}`);
  console.log(
    `Included ${sections.reduce((acc, section) => acc + section.files.length, 0)} file(s).`
  );
  console.log(`Missing keys: ${missing.length}`);
}

main();

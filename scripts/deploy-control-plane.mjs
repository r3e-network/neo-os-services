#!/usr/bin/env node
/** Protected Cloudflare control-plane release command. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wrangler = 'wrangler@4.130.0';

const confirmation = String(process.env.DEPLOY_CONTROL_PLANE_CONFIRM || '').trim();
if (confirmation !== 'I_UNDERSTAND_THIS_DEPLOYS_CONTROL_PLANE') {
  throw new Error(
    'Set DEPLOY_CONTROL_PLANE_CONFIRM=I_UNDERSTAND_THIS_DEPLOYS_CONTROL_PLANE to deploy'
  );
}
if (!String(process.env.CLOUDFLARE_API_TOKEN || '').trim()) {
  const whoami = spawnSync('npx', ['--yes', wrangler, 'whoami'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (whoami.status !== 0 || !String(whoami.stdout || '').includes('You are logged in')) {
    throw new Error('CLOUDFLARE_API_TOKEN or an existing Wrangler OAuth login is required');
  }
}

// Validate the environment the worker will run against BEFORE shipping code to
// it. Nothing else in the pipeline does: CI never runs check:control-plane, so
// without this a deploy could publish a worker whose declared rate limits have
// no Upstash backend (it now refuses ingest) or whose ingress keys are absent.
const envCheck = spawnSync(
  process.execPath,
  [resolve(process.cwd(), 'scripts/check-control-plane-env.mjs'), '--strict'],
  { stdio: 'inherit' }
);
if (envCheck.status !== 0) {
  throw new Error(
    'control-plane environment validation failed (scripts/check-control-plane-env.mjs --strict); fix the reported gaps before deploying'
  );
}

const config = resolve(
  process.cwd(),
  'deploy/cloudflare/morpheus-control-plane/wrangler.meshmini.toml'
);
const source = readFileSync(config, 'utf8');
if (!/account_id\s*=\s*"[^"]+"/.test(source)) {
  throw new Error(`Cloudflare account_id missing from ${config}`);
}

const result = spawnSync('npx', ['--yes', wrangler, 'deploy', '--config', config], {
  stdio: 'inherit',
  env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN },
});
process.exitCode = result.status ?? 1;

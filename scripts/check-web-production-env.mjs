#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findCredentialDomainCollisions } from './lib-credential-separation.mjs';

const REQUIRED_GROUPS = [
  {
    name: 'confidential_runtime_url',
    alternatives: [
      ['MORPHEUS_RUNTIME_URL'],
      ['MORPHEUS_MAINNET_RUNTIME_URL'],
      ['MORPHEUS_TESTNET_RUNTIME_URL'],
      ['MORPHEUS_RUNTIME_URL_MAINNET'],
      ['MORPHEUS_RUNTIME_URL_TESTNET'],
    ],
  },
  {
    name: 'runtime_auth',
    alternatives: [['MORPHEUS_RUNTIME_TOKEN'], ['NITRO_API_TOKEN'], ['NITRO_SHARED_SECRET']],
  },
  {
    name: 'control_plane_auth',
    alternatives: [['MORPHEUS_CONTROL_PLANE_API_KEY'], ['MORPHEUS_OPERATOR_API_KEY']],
  },
  {
    name: 'workflow_auth',
    alternatives: [['MORPHEUS_WORKFLOW_API_KEY']],
  },
  {
    name: 'signing_admin_auth',
    alternatives: [['MORPHEUS_SIGNING_ADMIN_API_KEY']],
  },
  {
    name: 'relay_admin_auth',
    alternatives: [['MORPHEUS_RELAY_ADMIN_API_KEY']],
  },
  {
    name: 'cron_auth',
    alternatives: [['MORPHEUS_CRON_SECRET'], ['CRON_SECRET']],
  },
  {
    name: 'supabase_url',
    alternatives: [['SUPABASE_URL'], ['NEXT_PUBLIC_SUPABASE_URL'], ['morpheus_SUPABASE_URL']],
  },
  {
    name: 'supabase_service_key',
    alternatives: [
      ['SUPABASE_SECRET_KEY'],
      ['SUPABASE_SERVICE_ROLE_KEY'],
      ['morpheus_SUPABASE_SECRET_KEY'],
      ['morpheus_SUPABASE_SERVICE_ROLE_KEY'],
    ],
  },
  {
    name: 'distributed_rate_limit',
    alternatives: [
      ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
      ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
      ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'],
      ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
      ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY'],
      ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
      ['morpheus_SUPABASE_URL', 'morpheus_SUPABASE_SECRET_KEY'],
      ['morpheus_SUPABASE_URL', 'morpheus_SUPABASE_SERVICE_ROLE_KEY'],
    ],
  },
];

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnvironmentFile(content) {
  const environment = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    environment[match[1]] = unquote(match[2]);
  }
  return environment;
}

function hasValue(environment, key) {
  return String(environment[key] || '').trim().length > 0;
}

export function validateWebProductionEnvironment(environment) {
  const missing = REQUIRED_GROUPS.filter(
    (group) => !group.alternatives.some((keys) => keys.every((key) => hasValue(environment, key)))
  ).map((group) => ({
    name: group.name,
    alternatives: group.alternatives,
  }));
  const forbiddenSignerEnv = Object.keys(environment)
    .filter((name) => {
      if (!hasValue(environment, name)) return false;
      const normalized = name.toUpperCase();
      return (
        /(?:^|_)WIF(?:_|$)/.test(normalized) ||
        (/(?:^|_)(?:PRIVATE_KEY|PK)(?:_|$)/.test(normalized) &&
          /(NEO|NEOX|EVM|MORPHEUS|SIGNER)/.test(normalized))
      );
    })
    .sort();
  const runtimeCredentialValues = new Set(
    ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET']
      .map((name) => String(environment[name] || '').trim())
      .filter(Boolean)
  );
  const reusedRuntimeCredentialEnv = [
    'MORPHEUS_CONTROL_PLANE_API_KEY',
    'MORPHEUS_OPERATOR_API_KEY',
    'MORPHEUS_RELAYER_API_KEY',
    'MORPHEUS_RELAYER_ADMIN_API_KEY',
    'ADMIN_CONSOLE_API_KEY',
    'MORPHEUS_WORKFLOW_API_KEY',
    'MORPHEUS_APP_BACKEND_TOKEN',
  ]
    .filter(
      (name) =>
        hasValue(environment, name) && runtimeCredentialValues.has(String(environment[name]).trim())
    )
    .sort();
  const credentialDomainCollisions = findCredentialDomainCollisions(environment);

  return {
    ok:
      missing.length === 0 &&
      forbiddenSignerEnv.length === 0 &&
      credentialDomainCollisions.length === 0,
    missing,
    forbiddenSignerEnv,
    reusedRuntimeCredentialEnv,
    credentialDomainCollisions,
  };
}

export function formatMissingGroups(missing) {
  return missing.map(
    (group) => `${group.name}: ${group.alternatives.map((keys) => keys.join(' + ')).join(' OR ')}`
  );
}

function main() {
  const envPath = path.resolve(process.argv[2] || '.vercel/.env.production.local');
  if (!fs.existsSync(envPath)) {
    console.error(`Production environment file not found: ${envPath}`);
    process.exitCode = 1;
    return;
  }

  const environment = parseEnvironmentFile(fs.readFileSync(envPath, 'utf8'));
  const validation = validateWebProductionEnvironment(environment);
  if (!validation.ok) {
    console.error('Vercel production environment is incomplete:');
    for (const line of formatMissingGroups(validation.missing)) {
      console.error(`- ${line}`);
    }
    for (const name of validation.forbiddenSignerEnv) {
      console.error(`- forbidden host signing key: ${name}`);
    }
    for (const name of validation.reusedRuntimeCredentialEnv) {
      console.error(`- control-plane credential reuses a runtime data-plane token: ${name}`);
    }
    for (const collision of validation.credentialDomainCollisions) {
      console.error(
        `- credential reused across ${collision.domains.join('/')} trust domains: ${collision.names.join(', ')}`
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log('Vercel production environment preflight passed.');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) main();

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadDotEnv } from './lib-env.mjs';
import { betterStackApi, loadBetterStackEnv } from './betterstack-lib.mjs';
import {
  betterStackTelemetryApi,
  loadBetterStackTelemetryEnv,
} from './betterstack-telemetry-lib.mjs';
import { trimString } from './lib-strings.mjs';

function parseArgs(argv = []) {
  const options = {
    output: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--output' && argv[i + 1]) {
      options.output = argv[i + 1];
      i += 1;
    }
  }

  return options;
}

function redactToken(value) {
  const raw = trimString(value);
  if (!raw) return '';
  if (raw.length <= 8) return raw;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

await loadDotEnv('.env.local');
await loadDotEnv('.env');
await loadBetterStackEnv();
await loadBetterStackTelemetryEnv();

const options = parseArgs(process.argv.slice(2));

async function loadCheckly() {
  const apiKey = trimString(process.env.CHECKLY_API_KEY);
  const accountId = trimString(process.env.CHECKLY_ACCOUNT_ID);
  if (!apiKey || !accountId) {
    return { configured: false, total_checks: 0, checks: [] };
  }

  const response = await fetch('https://api.checklyhq.com/v1/checks?limit=100', {
    headers: {
      'X-Checkly-Account': accountId,
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  const payload = await response.json().catch(() => []);
  const checks = Array.isArray(payload) ? payload : [];
  return {
    configured: true,
    account_id: accountId,
    total_checks: checks.length,
    checks: checks.map((check) => ({
      id: check.id || null,
      name: check.name || null,
      type: check.checkType || check.type || null,
      activated: check.activated ?? null,
      locations: Array.isArray(check.locations) ? check.locations : [],
      tags: Array.isArray(check.tags) ? check.tags : [],
    })),
  };
}

async function loadBetterStackHeartbeats() {
  const response = await betterStackApi('/heartbeats?page=1&per_page=100');
  const rows = Array.isArray(response?.data) ? response.data : [];
  return {
    total_heartbeats: rows.length,
    heartbeats: rows.map((row) => ({
      id: row.id,
      name: row.attributes?.name || null,
      url: row.attributes?.url || null,
      period: row.attributes?.period || null,
      grace: row.attributes?.grace || null,
      status: row.attributes?.status || null,
    })),
  };
}

async function loadBetterStackMonitors() {
  const response = await betterStackApi('/monitors?page=1&per_page=100');
  const rows = Array.isArray(response?.data) ? response.data : [];
  return {
    total_monitors: rows.length,
    monitors: rows.map((row) => ({
      id: row.id,
      name: row.attributes?.pronounceable_name || null,
      url: row.attributes?.url || null,
      monitor_type: row.attributes?.monitor_type || null,
      status: row.attributes?.status || null,
      check_frequency: row.attributes?.check_frequency || null,
    })),
  };
}

async function loadBetterStackSources() {
  const response = await betterStackTelemetryApi('/sources?page=1&per_page=100');
  const rows = Array.isArray(response?.data) ? response.data : [];
  return {
    total_sources: rows.length,
    sources: rows.map((row) => ({
      id: row.id,
      name: row.attributes?.name || null,
      platform: row.attributes?.platform || null,
      ingesting_host: row.attributes?.ingesting_host || null,
      token_preview: redactToken(row.attributes?.token || ''),
    })),
  };
}

const inventory = {
  generated_at: new Date().toISOString(),
  checkly: await loadCheckly(),
  betterstack: {
    heartbeats: await loadBetterStackHeartbeats(),
    monitors: await loadBetterStackMonitors(),
    sources: await loadBetterStackSources(),
  },
};

const serialized = `${JSON.stringify(inventory, null, 2)}\n`;

if (options.output) {
  const outputPath = path.resolve(process.cwd(), options.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serialized, 'utf8');
}

process.stdout.write(serialized);

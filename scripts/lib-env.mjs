import fs from 'node:fs/promises';
import path from 'node:path';
import { trimString } from './lib-strings.mjs';

export function parseDotEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function readDotEnvFile(filePath) {
  return parseDotEnv(await fs.readFile(filePath, 'utf8'));
}

export async function readMergedDotEnvFiles(filePaths = []) {
  const merged = {};
  for (const filePath of filePaths) {
    if (!trimString(filePath)) continue;
    try {
      Object.assign(merged, await readDotEnvFile(filePath));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return merged;
}

export async function loadDotEnv(envPath = path.resolve(process.cwd(), '.env'), options = {}) {
  try {
    const parsed = await readDotEnvFile(envPath);
    const override = options.override ?? false;
    for (const [key, value] of Object.entries(parsed)) {
      if (override || !trimString(process.env[key])) {
        process.env[key] = value;
      }
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

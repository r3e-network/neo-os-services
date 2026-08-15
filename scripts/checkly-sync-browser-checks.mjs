import { loadDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';
import { execFileSync } from 'node:child_process';

await loadDotEnv('.env.local');
await loadDotEnv('.env');

const apiKey = trimString(process.env.CHECKLY_API_KEY);
const accountId = trimString(process.env.CHECKLY_ACCOUNT_ID);
const projectName = trimString(process.env.CHECKLY_PROJECT_NAME || 'meshmini');

if (!apiKey || !accountId) {
  console.error('Missing CHECKLY_API_KEY or CHECKLY_ACCOUNT_ID.');
  process.exit(1);
}

const AA_BASE_URL = 'https://neo-abstract-account.vercel.app';
const ORACLE_BASE_URL = trimString(
  process.env.MORPHEUS_ORACLE_WEB_URL || 'https://neo-morpheus-oracle.vercel.app'
);

const baseHeaders = {
  'X-Checkly-Account': accountId,
  Authorization: `Bearer ${apiKey}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

async function api(pathname, init = {}) {
  const method = init.method || 'GET';
  const headers = {
    ...baseHeaders,
    ...(init.headers || {}),
  };

  const args = ['-sS', '-X', method];

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }

  if (init.body !== undefined) {
    args.push('--data', String(init.body));
  }

  args.push(`https://api.checklyhq.com/v1${pathname}`);

  const stdout = execFileSync('curl', args, { encoding: 'utf8' });
  return JSON.parse(stdout);
}

function buildBrowserScript(url, headingPattern) {
  return `const { chromium } = require("playwright");\n(async () => {\n  const browser = await chromium.launch();\n  const page = await browser.newPage();\n  await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });\n  await page.getByRole("heading", { name: ${headingPattern} }).waitFor({ state: "visible", timeout: 30000 });\n  await browser.close();\n})();`;
}

function buildOracleStarterReadinessScript(url) {
  return `const { chromium } = require("playwright");\n(async () => {\n  const browser = await chromium.launch();\n  const page = await browser.newPage();\n  const seen = [];\n  page.on("pageerror", (error) => { throw error; });\n  page.on("console", (msg) => { if (msg.type() === "error") throw new Error(msg.text()); });\n  await page.route("**/api/oracle/public-key**", async (route) => {\n    seen.push(route.request().url());\n    await route.fulfill({\n      status: 200,\n      contentType: "application/json",\n      body: JSON.stringify({ available: false, degraded: true, public_key: null, key_source: "unavailable", algorithm: "X25519-HKDF-SHA256-AES-256-GCM", message: "runtime denied public-key access" }),\n    });\n  });\n  await page.route("**/api/onchain/state**", async (route) => {\n    seen.push(route.request().url());\n    await route.fulfill({\n      status: 200,\n      contentType: "application/json",\n      body: JSON.stringify({ network: "testnet", generated_at: "2026-06-01T00:00:00.000Z", neo_n3: { oracle: null, datafeed: null, error: "mock rpc unavailable" } }),\n    });\n  });\n  await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });\n  await page.getByText("Public key unavailable").first().waitFor({ state: "visible", timeout: 30000 });\n  await page.getByText("On-chain state unavailable").first().waitFor({ state: "visible", timeout: 30000 });\n  const disabled = await page.getByRole("button", { name: "Encrypt Patch Locally" }).isDisabled();\n  if (!disabled) throw new Error("Starter Studio encryption stayed enabled while key access was degraded.");\n  if (!seen.some((item) => item.includes("/api/oracle/public-key?network=testnet"))) throw new Error("Starter Studio did not request the testnet public key.");\n  if (!seen.some((item) => item.includes("/api/onchain/state?limit=20&network=testnet"))) throw new Error("Starter Studio did not request testnet on-chain state.");\n  await browser.close();\n})();`;
}

function buildOracleComputeReadinessScript(url) {
  return `const { chromium } = require("playwright");\n(async () => {\n  const browser = await chromium.launch();\n  const page = await browser.newPage();\n  const seen = [];\n  page.on("pageerror", (error) => { throw error; });\n  page.on("console", (msg) => { if (msg.type() === "error") throw new Error(msg.text()); });\n  await page.route("**/api/onchain/state**", async (route) => {\n    seen.push(route.request().url());\n    await route.fulfill({\n      status: 200,\n      contentType: "application/json",\n      body: JSON.stringify({ network: "testnet", generated_at: "2026-06-01T00:00:00.000Z", neo_n3: { oracle: null, datafeed: null, error: "mock rpc unavailable" } }),\n    });\n  });\n  await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });\n  await page.getByRole("button", { name: /Private Compute/ }).click();\n  await page.getByRole("heading", { name: "Private Compute" }).waitFor({ state: "visible", timeout: 30000 });\n  await page.getByText("On-chain state unavailable").first().waitFor({ state: "visible", timeout: 30000 });\n  await page.getByRole("button", { name: "Generate On-Chain Compute Package" }).click();\n  await page.getByText("NEEDS VERIFICATION").first().waitFor({ state: "visible", timeout: 30000 });\n  const disabled = await page.getByRole("button", { name: "Submit compute request with NEP-21 wallet" }).isDisabled();\n  if (!disabled) throw new Error("Private Compute NEP-21 submit stayed enabled while on-chain state was degraded.");\n  if (!seen.some((item) => item.includes("/api/onchain/state?limit=20&network=testnet"))) throw new Error("Private Compute did not request testnet on-chain state.");\n  await browser.close();\n})();`;
}

const desiredChecks = [
  {
    name: 'aa-home-browser',
    url: `${AA_BASE_URL}/`,
    sslCheckDomain: 'neo-abstract-account.vercel.app',
    script: buildBrowserScript(`${AA_BASE_URL}/`, '/Smart Wallets That Never Lock You Out/i'),
  },
  {
    name: 'aa-identity-browser',
    url: `${AA_BASE_URL}/identity`,
    sslCheckDomain: 'neo-abstract-account.vercel.app',
    script: buildBrowserScript(`${AA_BASE_URL}/identity`, '/Web3Auth \\/ NeoDID Workspace/i'),
  },
  {
    name: 'morpheus-oracle-starter-studio-readiness-browser',
    url: `${ORACLE_BASE_URL}/docs/studio?network=testnet`,
    sslCheckDomain: new URL(ORACLE_BASE_URL).hostname,
    tags: [projectName, 'oracle', 'browser', 'readiness'],
    script: buildOracleStarterReadinessScript(`${ORACLE_BASE_URL}/docs/studio?network=testnet`),
  },
  {
    name: 'morpheus-oracle-private-compute-readiness-browser',
    url: `${ORACLE_BASE_URL}/explorer?network=testnet`,
    sslCheckDomain: new URL(ORACLE_BASE_URL).hostname,
    tags: [projectName, 'oracle', 'browser', 'readiness'],
    script: buildOracleComputeReadinessScript(`${ORACLE_BASE_URL}/explorer?network=testnet`),
  },
];

function buildBrowserPayload(spec) {
  return {
    name: spec.name,
    checkType: 'BROWSER',
    activated: true,
    muted: false,
    shouldFail: false,
    frequency: 360,
    locations: ['us-east-1'],
    tags: spec.tags || [projectName, 'aa', 'browser'],
    sslCheckDomain: spec.sslCheckDomain,
    script: spec.script,
  };
}

const existing = await api('/checks?limit=100');
const existingByName = new Map(
  (Array.isArray(existing) ? existing : []).map((check) => [String(check.name || ''), check])
);

const created = [];
const updated = [];

for (const spec of desiredChecks) {
  const payload = buildBrowserPayload(spec);
  const existingCheck = existingByName.get(spec.name);

  if (existingCheck) {
    const check = await api(`/checks/${existingCheck.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    updated.push({
      name: spec.name,
      id: check?.id || existingCheck.id,
      frequency: 360,
    });
    continue;
  }

  const check = await api('/checks/browser', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  created.push({
    name: spec.name,
    id: check?.id || null,
    url: spec.url,
  });
}

console.log(
  JSON.stringify(
    {
      account_id: accountId,
      project_name: projectName,
      created,
      updated,
      total_browser_checks: desiredChecks.length,
    },
    null,
    2
  )
);

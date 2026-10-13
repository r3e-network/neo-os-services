import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = resolve(appRoot, 'app/api');

// Replaces `sign-relay-auth-logging.test.ts`, whose subjects are retired.
// That suite drove `/api/sign/payload` and `/api/relay/transaction` through
// their admin gate and asserted that a rejected request logged nothing. Both
// lanes are gone (CU-149) and could not be repaired:
//
//   - `/api/sign/payload` aimed at a host lane the measured image refuses:
//     `sign.rs` closes blind payload signing with a 503 unless the image sets
//     `ENCLAVE_ALLOW_BLIND_SIGN=1`, which the shipped posture does not and
//     `scripts/custody-plane-e2e.mjs` asserts. Re-enabling it is not a fix.
//   - `/api/relay/transaction` aimed at `/relay/transaction`, which no Target
//     in `workers/nitro-enclave-host/src/routes.rs` classifies. Transaction
//     submission goes through the relayer, not the enclave.
//
// The property the old suite guarded is carried forward in a stronger form: no
// request can reach a retired lane at all, so nothing can be logged on its
// behalf either, and no proxy may be re-pointed at those host paths.

const RETIRED_SEGMENTS = ['sign/payload', 'relay/transaction'];
const RETIRED_HOST_TARGETS = ['/sign/payload', '/relay/transaction'];

function routeFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFilesUnder(full));
    else if (/^route\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry)) found.push(full);
  }
  return found;
}

/** The literal host path of every `proxyToNitro('<path>', …)` call in a route. */
function proxyTargets(source: string): string[] {
  const targets: string[] = [];
  const call = /proxyToNitro\(\s*['"`](\/[^'"`]*)['"`]/g;
  for (const match of source.matchAll(call)) targets.push(match[1]);
  return targets;
}

describe('retired web proxies', () => {
  it.each(RETIRED_SEGMENTS)('publishes no /api/%s route handler', (segment) => {
    expect(existsSync(resolve(apiRoot, segment, 'route.ts'))).toBe(false);
  });

  it('points no remaining proxy at a retired host path', () => {
    const offenders: string[] = [];
    for (const file of routeFilesUnder(apiRoot)) {
      for (const target of proxyTargets(readFileSync(file, 'utf8'))) {
        if (RETIRED_HOST_TARGETS.includes(target)) offenders.push(`${file} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

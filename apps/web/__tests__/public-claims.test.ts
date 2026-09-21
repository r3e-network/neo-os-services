import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * SVC-D-7 (CL-32): guard the claims the public site makes.
 *
 * Morpheus runs on ONE operator's node. The honest half of the TEE story —
 * measured, reproducible code holds the key, so the operator cannot read
 * secrets or change logic undetectably — is ours to claim. The half that comes
 * from an operator SET is not: a single node cannot be decentralized, cannot
 * be trustless, and is by definition a single point of failure.
 *
 * This workspace has shipped over-stated verification claims before, which is
 * why the wording is enforced rather than reviewed. To add a legitimate use of
 * one of these words (quoting someone else, naming a third-party network),
 * put it on the allowlist below with the reason.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Rendered, user-facing copy. API route comments are not site copy. */
const COPY_ROOTS = ['app', 'components', 'docs'];
const COPY_EXTENSIONS = new Set(['.tsx', '.mdx', '.md']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', 'dist', 'api', '__tests__']);

const BANNED_CLAIMS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /decentrali[sz]ed/i,
    why: 'one operator runs the relayer and one enclave node serves requests',
  },
  { pattern: /trustless/i, why: 'the TEE and its single operator are the trust root' },
  {
    pattern: /no single point of failure/i,
    why: 'the single operator IS the single point of failure',
  },
  { pattern: /zero[- ]trust/i, why: 'the operator is trusted for availability and censorship' },
  { pattern: /fully confidential/i, why: 'logic, binary and boundary I/O are public' },
  { pattern: /cannot be compromised/i, why: 'side channels and speculative execution exist' },
  { pattern: /100% secure/i, why: 'not a claim any system can support' },
];

/**
 * Legitimate uses, each with the reason it is not a claim about NeoOS.
 * `file` is repo-relative to apps/web; `snippet` must appear on the line.
 */
const ALLOWLIST: { file: string; snippet: string; why: string }[] = [
  {
    file: 'app/docs/verifier/page.tsx',
    snippet: 'not a decentralized quorum',
    why: 'the limitations section denying the claim, not making it',
  },
];

async function collectCopyFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await collectCopyFiles(path.join(dir, entry.name), out);
    } else if (COPY_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function isAllowed(relativePath: string, line: string) {
  return ALLOWLIST.some((entry) => entry.file === relativePath && line.includes(entry.snippet));
}

describe('public claims (CL-32 / SVC-D-7)', () => {
  it('finds site copy to scan at all (a vacuous pass is a failure)', async () => {
    const files = (
      await Promise.all(COPY_ROOTS.map((root) => collectCopyFiles(path.join(appRoot, root))))
    ).flat();
    expect(files.length).toBeGreaterThan(20);
  });

  it('never claims decentralization, trustlessness or invulnerability', async () => {
    const files = (
      await Promise.all(COPY_ROOTS.map((root) => collectCopyFiles(path.join(appRoot, root))))
    ).flat();

    const violations: string[] = [];
    for (const file of files) {
      const relativePath = path.relative(appRoot, file);
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const claim of BANNED_CLAIMS) {
          if (!claim.pattern.test(line)) continue;
          if (isAllowed(relativePath, line)) continue;
          violations.push(
            `${relativePath}:${index + 1} matches ${claim.pattern} — ${claim.why}\n    ${line.trim()}`
          );
        }
      });
    }

    expect(violations, `banned public claims:\n${violations.join('\n')}`).toEqual([]);
  });

  it('publishes a limitations section naming the negative space CL-32 requires', async () => {
    const page = await readFile(path.join(appRoot, 'app/docs/verifier/page.tsx'), 'utf8');
    expect(page).toContain('what-this-does-not-protect-against');
    // Each of the four properties CL-32 requires a limitations section to name.
    expect(page).toMatch(/side channel/i);
    expect(page).toMatch(/speculative execution/i);
    expect(page).toMatch(/egress metadata is visible to the host/i);
    expect(page).toMatch(/censor or halt/i);
    expect(page).toMatch(/enclave binary are public/i);
  });

  it('the FAQ describes relayer availability as single-operator', async () => {
    const faq = await readFile(path.join(appRoot, 'app/docs/faq/page.tsx'), 'utf8');
    expect(faq).toMatch(/single node, not a pool/i);
    expect(faq).toMatch(/one operator runs the relayer/i);
  });
});

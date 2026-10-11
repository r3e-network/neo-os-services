#!/usr/bin/env node
// Companion reporter for one refusal class of scripts/check-vrf-consumers.mjs: a
// policy binding whose reviewed bytes no longer match the file. That gate is the
// authority and is unchanged; it stops at the first problem, carries no hashes and
// says nothing about whose change caused the staleness, and it sits far enough down
// lint-and-format that an unrelated red keeps it from running at all. So a
// dependency bump used to leave its stale binding for the next unrelated branch.
// This runs above those steps, names every stale binding in one pass, and says
// whether the change under test caused the staleness or inherited it.
//
// It never refuses a binding the gate accepts: byte equality is the only question
// asked. Refreshing a hash stays a human review of the diff, so the remedy says so
// rather than offering a command that would rewrite the policy unread.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY = 'baselines/vrf-consumers.json';
const AUTHORITY = 'scripts/check-vrf-consumers.mjs';
const OWNS = `${AUTHORITY} owns policy validation`;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0;

class Refusal extends Error {}
function requireRule(ok, message) {
  if (!ok) throw new Refusal(message);
}

// Only the fields this report reads, and only enough of them to fail closed: a
// policy this cannot understand must refuse, never report zero stale bindings.
function bindings(source) {
  let policy;
  try {
    policy = JSON.parse(source);
  } catch (error) {
    throw new Refusal(`policy is not JSON: ${error.message} (${OWNS})`);
  }
  requireRule(object(policy) && policy.version === 1, `policy version must be 1 (${OWNS})`);
  requireRule(Array.isArray(policy.reviews), `policy reviews must be an array (${OWNS})`);
  const bound = [];
  for (const review of policy.reviews) {
    requireRule(object(review) && text(review.consumer), `review needs a consumer (${OWNS})`);
    requireRule(text(review.owner), `${review.consumer}: review needs an owner (${OWNS})`);
    requireRule(object(review.inputs), `${review.consumer}: review needs inputs (${OWNS})`);
    for (const [path, binding] of Object.entries(review.inputs)) {
      requireRule(
        path.split('/').every((part) => part && part !== '.' && part !== '..') &&
          !path.includes('\\'),
        `invalid input path ${path} (${OWNS})`
      );
      requireRule(/^[a-f0-9]{64}$/.test(binding?.sha256), `invalid hash for ${path} (${OWNS})`);
      bound.push({
        path,
        reviewed: binding.sha256,
        consumer: review.consumer,
        owner: review.owner,
      });
    }
  }
  return bound;
}

// Bytes as the gate reads them. A binding whose path is absent, is a directory or
// is any other non-regular file has no bytes to compare, which is its own line.
function currentHash(root, path) {
  let stat;
  try {
    stat = lstatSync(resolve(root, path));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return stat.isFile() ? hash(readFileSync(resolve(root, path))) : null;
}

function readBasePolicy(git, commit, base) {
  if (!git('ls-tree', '--name-only', commit, '--', POLICY).trim()) return null;
  try {
    return new Map(bindings(git('show', `${commit}:${POLICY}`)).map((b) => [b.path, b.reviewed]));
  } catch {
    // Conservative: an unreadable base policy attributes every staleness to the
    // change under test rather than telling its author it belongs to someone else.
    console.log(`note: the policy at ${base} is unreadable; attributing every stale binding here`);
    return null;
  }
}

// A staleness is inherited only when the base was already stale: bound there, with
// bytes that did not match. Anything else — fresh at the base, or a binding this
// change introduced — is caused here.
function inherited(root, commit, basePolicy, path) {
  const reviewed = basePolicy?.get(path);
  if (!reviewed) return false;
  try {
    return (
      hash(
        execFileSync('git', ['show', `${commit}:${path}`], {
          cwd: root,
          encoding: 'buffer',
          maxBuffer: 256 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      ) !== reviewed
    );
  } catch {
    return true;
  }
}

function report(binding, cause, current) {
  console.log(`policy binding stale (${cause}): ${binding.path}`);
  console.log(`  review    ${binding.consumer} (owner: ${binding.owner})`);
  console.log(`  reviewed  ${binding.reviewed}`);
  if (current === null) {
    console.log(
      `  refresh   delete the "${binding.path}" binding from the ${binding.consumer} review ` +
        `in ${POLICY}; the reviewed file is no longer a regular file in the tree`
    );
    return;
  }
  console.log(`  current   ${current}`);
  console.log(
    `  refresh   re-read these bytes, then set the "${binding.path}" binding of the ` +
      `${binding.consumer} review in ${POLICY} to sha256 ${current}; refreshing a hash is a ` +
      `review of the diff, never a way to clear the gate`
  );
}

function main() {
  let root = ROOT;
  let base = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    requireRule(
      ['--root', '--base'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('-'),
      'invalid argument'
    );
    if (args[i] === '--root') root = resolve(args[++i]);
    else base = args[++i];
  }
  const git = (...a) =>
    execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const bound = bindings(readFileSync(resolve(root, POLICY), 'utf8'));
  let commit = null;
  let basePolicy = null;
  if (base !== null) {
    requireRule(/^[0-9A-Za-z][0-9A-Za-z._/~^@-]*$/.test(base), 'invalid base ref');
    try {
      commit = git('rev-parse', '--verify', `${base}^{commit}`).trim();
    } catch {
      throw new Refusal('base must resolve to a local commit');
    }
    basePolicy = readBasePolicy(git, commit, base);
  }

  let caused = 0;
  let carried = 0;
  let absent = 0;
  for (const binding of bound) {
    const current = currentHash(root, binding.path);
    if (current === binding.reviewed) continue;
    if (current === null) {
      absent++;
      report(binding, 'no file in the tree', null);
      continue;
    }
    if (commit === null) {
      caused++;
      report(binding, 'attribution needs --base', current);
      continue;
    }
    if (inherited(root, commit, basePolicy, binding.path)) {
      carried++;
      report(binding, `already stale at ${base}, not caused by this change`, current);
    } else {
      caused++;
      report(binding, 'caused by this change', current);
    }
  }

  const stale = caused + carried + absent;
  if (stale === 0) {
    console.log(
      `policy bindings fresh: ${bound.length} checked${commit === null ? '' : `; base ${base}`}`
    );
    return;
  }
  throw new Refusal(
    commit === null
      ? `${stale} stale, ${absent} with no file (${bound.length} checked); run with ` +
          '--base <ref> to attribute them'
      : `${caused} caused by this change, ${carried} inherited, ${absent} with no file ` +
          `(${bound.length} checked)`
  );
}

try {
  main();
} catch (error) {
  console.error(`policy binding freshness refused: ${error.message}`);
  process.exitCode = 1;
}

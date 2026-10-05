#!/usr/bin/env node
/**
 * Route-parity gate: the declared capability registry, the measured host route
 * table and the web proxy targets.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three trees in this repository each answer "which runtime routes exist", and
 * nothing compared them:
 *
 *   1. workers/nitro-worker/src/capabilities.js - the capability registry. The
 *      published contract: the relayer, the SDK and the docs resolve against it.
 *   2. workers/nitro-enclave-host/src/routes.rs - the route table of the image
 *      that actually runs (`classify`, the pure classifier `dispatch.rs` feeds).
 *      This is the measured frontier; everything in the JS tree above it is
 *      scheduled for deletion.
 *   3. apps/web/app/api/**\/route.* - the Next.js proxies, each calling
 *      `proxyToNitro(<host path>, { method })`. A proxy the host cannot answer
 *      is a 404 behind a 200-shaped public API.
 *
 * A fourth, smaller source: the edge gateway forwards the paths in its
 * RUNTIME_BOX_PASSTHROUGH list (deploy/cloudflare/morpheus-edge-gateway/worker.mjs)
 * to the host with the caller's own method, so each has to be a live host route.
 *
 * At HEAD twelve declared capability ids have no host route at all, and five
 * web proxies reach nothing a caller can use:
 *
 *   - `/compute/functions`, `/neodid/runtime`, `/relay/transaction`: the host
 *     has no such route;
 *   - `/sign/payload`: the host classifies it, but the lane is retired and
 *     answers 503 unless the measured image sets ENCLAVE_ALLOW_BLIND_SIGN=1,
 *     which the shipped posture does not;
 *   - `GET /keys/derived`: the host serves the route for POST only, and
 *     `classify` falls through to NotFound on a method mismatch.
 *
 * That is the finding: not that the gap is large, but that it was invisible.
 * Every lane added after this point is checked against the host before anybody
 * builds a caller for it. (The specification's "four" proxies was a path-only
 * count; the method-aware count is five.)
 *
 * THE BASELINE IS SHRINK-ONLY, AND IT IS ENFORCED IN TWO PLACES
 * -------------------------------------------------------------
 * `baselines/capability-route-parity.json` records the known dead lanes so the
 * gate is green on the head instead of red on arrival. It is a record of debt,
 * not an allowance, and it may only ever get smaller.
 *
 * In the tree, on every run:
 *   * every dead id and every dead proxy must be in the baseline, and an entry
 *     that is not actually dead fails (stale debt is deleted, never left);
 *   * every entry needs a reason, an owner and `expires`, a real calendar date;
 *   * an entry whose `expires` is today or earlier fails: it is the first day
 *     the entry no longer holds, the rule the topology gate's exceptions use;
 *   * an `expires` more than MAX_EXPIRY_HORIZON_DAYS after today fails, so a
 *     date cannot be pushed out of reach (2099-12-31 is not a deadline);
 *   * a proxy entry records the target and the method the proxy uses, so
 *     re-pointing a baselined proxy at another dead route fails.
 *
 * Against the base, with `--base <ref>` (CI passes the pull request's base
 * commit): the baseline at that ref is read with git, and an entry that is not
 * in it (added), a later `expires` (extended) or a re-pointed proxy fails. A
 * tree cannot see its own history, so the rules above cannot tell "the baseline
 * was edited in the same change that adds a dead id" from "the baseline has
 * always said this"; the base can. Deleting an entry is the only edit that
 * passes both. CI runs the comparison on pull requests, where a base exists, as
 * it does the build-input rule of check-nitro-measurements.
 *
 * READING THE SOURCES FAILS CLOSED
 * --------------------------------
 * The sources are text, read with a scanner that knows comments, strings,
 * template literals and regular expressions (`maskScript`, `maskRust`). It is a
 * reader, not a compiler, and what it cannot read it does not skip. Each of
 * these is exit 1 rather than a silently shorter list:
 *   * a CAPABILITIES entry that is not an object literal with a string `id` and
 *     a literal `paths` array; a duplicate id; the array being mutated outside
 *     its literal; a `featurePath` count that differs from the entry count;
 *   * a `proxyToNitro` reference that is not a direct call; a target that is not
 *     one literal; an init that is not an object literal free of spreads; a
 *     `method` that is not a literal;
 *   * a route literal in `classify` that the structural reader did not attribute
 *     to a method (an `else`, a `match`, a condition it cannot read).
 *
 * WHAT IT DOES NOT SEE
 * ---------------------
 *   * Web code that calls the host without `proxyToNitro`: apps/web/lib/neodid-did.ts
 *     fetches `${runtimeUrl}/neodid/runtime` and apps/web/lib/neo-control-plane.ts
 *     fetches `${apiBaseUrl}/txproxy/invoke`. Source text cannot tell a host URL from any
 *     other base URL, so those calls are not compared. Both aim at ids this baseline
 *     already records as dead, so closing the ids closes them.
 *   * The edge gateway's other table, `mapToAppBackendPath`, maps edge paths to apps/web
 *     routes rather than to host routes; its targets are not compared with the web tree.
 *   * Methods of declared ids: the registry names none, so an id is judged on its path.
 *
 * No host code changes here, so the enclave measurement is untouched: nothing
 * in the measured frontier, its Cargo.lock or its Dockerfiles is read into a
 * decision, only the route table's own source text.
 *
 * USAGE
 *   node scripts/check-capability-route-parity.mjs
 *   node scripts/check-capability-route-parity.mjs --root <dir>   # audit a tree
 *   node scripts/check-capability-route-parity.mjs --base <ref>   # also: the baseline only shrank since <ref>
 *
 * There is no flag that moves the clock: the gate reads the real UTC day, and
 * its tests pin the clock with a preload, as the topology gate's tests do.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Where the shrink-only debt record lives, relative to the repository root. */
export const BASELINE_PATH = 'baselines/capability-route-parity.json';

/** No baseline entry may expire more than this many days after the day it is checked. */
export const MAX_EXPIRY_HORIZON_DAYS = 60;

const REGISTRY_PATH = 'workers/nitro-worker/src/capabilities.js';
const HOST_ROUTES_PATH = 'workers/nitro-enclave-host/src/routes.rs';
const HOST_DISPATCH_PATH = 'workers/nitro-enclave-host/src/dispatch.rs';
const HOST_SIGN_PATH = 'workers/nitro-enclave-host/src/sign.rs';
const WEB_API_DIR = 'apps/web/app/api';
const EDGE_WORKER_PATH = 'deploy/cloudflare/morpheus-edge-gateway/worker.mjs';

/** Next.js route handler files: route.ts, route.tsx, route.js, route.jsx, route.mjs, ... */
const ROUTE_FILE = /^route\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * The refusal a host handler returns when the lane is closed unless the image
 * opts in. `sign.rs` guards `handle_sign_payload` with
 * `if !blind_sign_enabled(state) { return Err(blind_sign_disabled_error()) }`,
 * and `scripts/custody-plane-e2e.mjs` asserts that closed posture is what
 * ships: the measured image does not set `ENCLAVE_ALLOW_BLIND_SIGN=1`.
 *
 * The chain is followed through the source rather than hardcoded, because the
 * route is only dead BECAUSE of the handler: `Target::SignPayload =>` in
 * dispatch.rs still classifies the path, which is exactly why a route-table
 * comparison alone reports the lane as live. A lane that is routed to a
 * permanently-refusing handler is dead for a caller, and the gate has to see
 * that or it under-reports by one.
 */
const RETIREMENT_GUARD = 'blind_sign_disabled_error';

// ---------------------------------------------------------------------------
// Reading source text
//
// Both scanners return a copy of the source with the same length, in which
// comments are blanked and the inside of string-like literals is filled with
// `_`. Brackets and commas that remain are real structure, and an index in the
// copy is an index in the source, which is how a literal is read back out.
// ---------------------------------------------------------------------------

const WORD_CHAR = /[A-Za-z0-9_$]/;
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);
const REGEX_AFTER_PUNCTUATION = '(,=:[!&|?{;+-*%<>~^';

/**
 * Mask JavaScript or TypeScript: comments become spaces, and the inside of
 * string, template and regular-expression literals becomes `_`. A template's
 * `${ ... }` expressions are code and stay readable.
 */
export function maskScript(source) {
  const out = Array.from(source);
  const length = source.length;

  const fill = (from, to, character) => {
    for (let k = from; k < to; k += 1) {
      if (source[k] !== '\n' && source[k] !== '\r') out[k] = character;
    }
  };

  // A `/` starts a regular expression, not a division, when the last
  // significant character cannot end an expression.
  const regexAllowedAt = (index) => {
    let back = index - 1;
    while (back >= 0 && /\s/.test(out[back])) back -= 1;
    if (back < 0) return true;
    if (WORD_CHAR.test(out[back])) {
      let first = back;
      while (first >= 0 && WORD_CHAR.test(out[first])) first -= 1;
      return REGEX_AFTER_WORD.has(out.slice(first + 1, back + 1).join(''));
    }
    return REGEX_AFTER_PUNCTUATION.includes(out[back]);
  };

  const skipString = (start) => {
    const quote = source[start];
    let k = start + 1;
    while (k < length) {
      const character = source[k];
      if (character === '\\') {
        k += 2;
        continue;
      }
      if (character === quote) {
        fill(start + 1, k, '_');
        return k + 1;
      }
      if (character === '\n') break;
      k += 1;
    }
    throw new Error(`unterminated string literal at offset ${start}`);
  };

  const skipRegex = (start) => {
    let k = start + 1;
    let inClass = false;
    while (k < length) {
      const character = source[k];
      if (character === '\n') break;
      if (character === '\\') {
        k += 2;
        continue;
      }
      if (character === '[') inClass = true;
      else if (character === ']') inClass = false;
      else if (character === '/' && !inClass) {
        fill(start + 1, k, '_');
        k += 1;
        while (k < length && /[a-z]/.test(source[k])) k += 1;
        return k;
      }
      k += 1;
    }
    throw new Error(`unterminated regular expression literal at offset ${start}`);
  };

  // `scanCode` and `skipTemplate` call each other: a template holds code, and
  // that code can hold another template.
  let scanCode;
  const skipTemplate = (start) => {
    let k = start + 1;
    let textFrom = k;
    while (k < length) {
      const character = source[k];
      if (character === '\\') {
        k += 2;
        continue;
      }
      if (character === '`') {
        fill(textFrom, k, '_');
        return k + 1;
      }
      if (character === '$' && source[k + 1] === '{') {
        fill(textFrom, k, '_');
        k = scanCode(k + 2, true) + 1;
        textFrom = k;
        continue;
      }
      k += 1;
    }
    throw new Error(`unterminated template literal at offset ${start}`);
  };

  scanCode = (start, untilBrace) => {
    let depth = 0;
    let k = start;
    while (k < length) {
      const character = source[k];
      const next = source[k + 1];
      if (character === '/' && next === '/') {
        const lineEnd = source.indexOf('\n', k);
        const end = lineEnd === -1 ? length : lineEnd;
        fill(k, end, ' ');
        k = end;
      } else if (character === '/' && next === '*') {
        const end = source.indexOf('*/', k + 2);
        if (end === -1) throw new Error(`unterminated block comment at offset ${k}`);
        fill(k, end + 2, ' ');
        k = end + 2;
      } else if (character === '"' || character === "'") {
        k = skipString(k);
      } else if (character === '`') {
        k = skipTemplate(k);
      } else if (character === '/' && regexAllowedAt(k)) {
        k = skipRegex(k);
      } else {
        if (untilBrace) {
          if (character === '{') depth += 1;
          else if (character === '}') {
            if (depth === 0) return k;
            depth -= 1;
          }
        }
        k += 1;
      }
    }
    if (untilBrace) throw new Error('unterminated template expression');
    return length;
  };

  scanCode(0, false);
  return out.join('');
}

/**
 * Mask Rust. `code` has comments blanked (nested block comments included) and
 * keeps string literals, so a route literal can be read from it. `shape` also
 * fills the inside of string and character literals, so a brace or a `//` in a
 * string is never structure.
 */
export function maskRust(source) {
  const code = Array.from(source);
  const shape = Array.from(source);
  const length = source.length;

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (source[k] !== '\n') {
        code[k] = ' ';
        shape[k] = ' ';
      }
    }
  };
  const fillShape = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (source[k] !== '\n') shape[k] = '_';
    }
  };

  let k = 0;
  while (k < length) {
    const character = source[k];
    const next = source[k + 1];
    if (character === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', k);
      const end = lineEnd === -1 ? length : lineEnd;
      blank(k, end);
      k = end;
      continue;
    }
    if (character === '/' && next === '*') {
      let depth = 1;
      let end = k + 2;
      while (end < length && depth > 0) {
        if (source[end] === '/' && source[end + 1] === '*') {
          depth += 1;
          end += 2;
        } else if (source[end] === '*' && source[end + 1] === '/') {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      if (depth !== 0) throw new Error(`unterminated block comment at offset ${k}`);
      blank(k, end);
      k = end;
      continue;
    }
    if ((character === 'r' || character === 'b') && !WORD_CHAR.test(source[k - 1] || ' ')) {
      const raw = /^b?r(#*)"/.exec(source.slice(k, k + 40));
      if (raw) {
        const open = k + raw[0].length;
        const closer = `"${raw[1]}`;
        const end = source.indexOf(closer, open);
        if (end === -1) throw new Error(`unterminated raw string at offset ${k}`);
        fillShape(open, end);
        k = end + closer.length;
        continue;
      }
    }
    if (character === '"') {
      let end = k + 1;
      while (end < length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      if (end >= length) throw new Error(`unterminated string at offset ${k}`);
      fillShape(k + 1, end);
      k = end + 1;
      continue;
    }
    if (character === "'") {
      // A character literal, or the tick of a lifetime or loop label.
      const char = /^'(?:\\u\{[0-9a-fA-F_]+\}|\\x[0-9a-fA-F]{2}|\\.|[^\\'\n])'/.exec(
        source.slice(k, k + 14)
      );
      if (char) {
        fillShape(k + 1, k + char[0].length - 1);
        k += char[0].length;
        continue;
      }
    }
    k += 1;
  }
  return { code: code.join(''), shape: shape.join('') };
}

const OPENERS = '([{';
const CLOSERS = ')]}';

/** The index of the bracket that closes the one at `open`, in masked text. */
function matchClose(shape, open) {
  const stack = [];
  for (let k = open; k < shape.length; k += 1) {
    const character = shape[k];
    if (OPENERS.includes(character)) {
      stack.push(CLOSERS[OPENERS.indexOf(character)]);
    } else if (CLOSERS.includes(character)) {
      if (stack.pop() !== character) throw new Error(`mismatched ${character} at offset ${k}`);
      if (stack.length === 0) return k;
    }
  }
  throw new Error(`unterminated ${shape[open]} at offset ${open}`);
}

function trimSpan(shape, from, to) {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(shape[start])) start += 1;
  while (end > start && /\s/.test(shape[end - 1])) end -= 1;
  return [start, end];
}

/** The comma-separated elements between `open` and `close`, as trimmed [start, end) spans. */
function splitTopLevel(shape, open, close) {
  const spans = [];
  let depth = 0;
  let start = open + 1;
  for (let k = open + 1; k < close; k += 1) {
    const character = shape[k];
    if (OPENERS.includes(character)) depth += 1;
    else if (CLOSERS.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      spans.push([start, k]);
      start = k + 1;
    }
  }
  spans.push([start, close]);
  return spans.map(([from, to]) => trimSpan(shape, from, to)).filter(([from, to]) => to > from);
}

const excerpt = (source, start, end) =>
  JSON.stringify(source.slice(start, Math.min(end, start + 48)));

/**
 * The members of an object literal as a map from key to the [start, end) span
 * of its value. A shorthand or method member maps to null: it has a key and no
 * readable value. A spread or a computed key can carry any key, so it is an
 * error rather than something to step over.
 */
function readMembers(source, shape, open, close, where) {
  const members = new Map();
  for (const [start, end] of splitTopLevel(shape, open, close)) {
    const text = shape.slice(start, end);
    if (text.startsWith('...')) {
      throw new Error(`${where} spreads another object, which can carry any key`);
    }
    if (text.startsWith('[')) {
      throw new Error(`${where} has a computed key, which this reader cannot resolve`);
    }
    const named = /^(?:(['"])(_*)\1|([A-Za-z_$][\w$]*))\s*(:)?/.exec(text);
    if (!named) {
      throw new Error(
        `${where} has a member this reader does not understand: ${excerpt(source, start, end)}`
      );
    }
    const key = named[3] ?? source.slice(start + 1, start + 1 + named[2].length);
    if (members.has(key)) throw new Error(`${where} declares ${key} twice`);
    members.set(key, named[4] === ':' ? trimSpan(shape, start + named[0].length, end) : null);
  }
  return members;
}

/** An object literal's own span as [open, close], or an error naming `where`. */
function objectBounds(source, shape, [start, end], where) {
  if (shape[start] !== '{' || matchClose(shape, start) !== end - 1) {
    throw new Error(`${where} is not a single object literal: ${excerpt(source, start, end)}`);
  }
  return [start, end - 1];
}

/** The value of a plain string literal (no interpolation, no escape), or an error. */
function readStringLiteral(source, shape, span, where) {
  if (!span) throw new Error(`${where} is not a string literal`);
  const [start, end] = span;
  const text = shape.slice(start, end);
  if (!/^(['"])_*\1$/.test(text) && !/^`_*`$/.test(text)) {
    throw new Error(`${where} is not a plain string literal: ${excerpt(source, start, end)}`);
  }
  const value = source.slice(start + 1, end - 1);
  if (value.includes('\\')) throw new Error(`${where} contains an escape sequence`);
  return value;
}

// ---------------------------------------------------------------------------
// Source 1: the declared capability registry
// ---------------------------------------------------------------------------

/**
 * Parse the `CAPABILITIES` array literal: each entry's `id` and its `paths`
 * (`{ match: '/x' }` for an exact route, `{ pattern: /.../ }` for a
 * parameterised one). A pattern route is reported as its literal source text,
 * because the host table is exact-match only and a pattern lane can never be
 * satisfied by a host route, which is the point for `feeds_price_symbol` and
 * `compute_jobs_id`.
 *
 * The array is walked structurally, so the layout of an entry does not matter
 * (one line or many, `id` first or not, either quote). Every top-level element
 * has to become one record or the reader throws, and the count is checked
 * against an independent one: each entry names exactly one `featurePath`, which
 * is what the worker publishes for it.
 */
export function parseCapabilityRegistry(source, label = REGISTRY_PATH) {
  const shape = maskScript(source);
  const declaration = /\bconst\s+CAPABILITIES\s*=\s*\[/.exec(shape);
  if (!declaration) throw new Error(`${label}: the CAPABILITIES array was not found`);
  const open = declaration.index + declaration[0].length - 1;
  const close = matchClose(shape, open);

  const mutation =
    /\bCAPABILITIES\s*(?:\.\s*(?:push|unshift|splice|fill|copyWithin)\b|\[[^\]]*\]\s*=(?!=))/.exec(
      shape
    );
  if (mutation) {
    throw new Error(
      `${label}: CAPABILITIES is changed after its literal (${JSON.stringify(mutation[0])}); ` +
        `entries added that way are invisible to this reader`
    );
  }

  const capabilities = splitTopLevel(shape, open, close).map((span, index) => {
    const where = `${label}: CAPABILITIES entry ${index + 1}`;
    const [entryOpen, entryClose] = objectBounds(source, shape, span, where);
    const members = readMembers(source, shape, entryOpen, entryClose, where);
    const id = readStringLiteral(source, shape, members.get('id'), `${where}: id`);
    if (!/^[\w.-]+$/.test(id))
      throw new Error(`${where}: id ${JSON.stringify(id)} is not an identifier`);

    const pathsSpan = members.get('paths');
    const named = `${where} (${id})`;
    if (
      !pathsSpan ||
      shape[pathsSpan[0]] !== '[' ||
      matchClose(shape, pathsSpan[0]) !== pathsSpan[1] - 1
    ) {
      throw new Error(`${named}: paths is not an array literal, so its routes cannot be read`);
    }
    const exact = [];
    const patterns = [];
    for (const pathSpan of splitTopLevel(shape, pathsSpan[0], pathsSpan[1] - 1)) {
      const pathWhere = `${named}: paths element`;
      const [pathOpen, pathClose] = objectBounds(source, shape, pathSpan, pathWhere);
      const pathMembers = readMembers(source, shape, pathOpen, pathClose, pathWhere);
      if (pathMembers.has('match')) {
        exact.push(
          readStringLiteral(source, shape, pathMembers.get('match'), `${pathWhere} match`)
        );
      }
      if (pathMembers.has('pattern')) {
        const patternSpan = pathMembers.get('pattern');
        if (!patternSpan || !/^\/_*\/[a-z]*$/.test(shape.slice(patternSpan[0], patternSpan[1]))) {
          throw new Error(`${pathWhere} pattern is not a regular expression literal`);
        }
        patterns.push(source.slice(patternSpan[0], patternSpan[1]));
      }
    }
    const routes = [...exact, ...patterns];
    if (routes.length === 0) throw new Error(`${named} declares no route`);
    return { id, kind: patterns.length > 0 ? 'pattern' : 'exact', routes, exact, patterns };
  });

  if (capabilities.length === 0) throw new Error(`${label}: no capabilities were parsed`);
  const ids = capabilities.map((capability) => capability.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`${label}: capability id ${duplicate} is declared twice`);

  const featurePaths = (shape.slice(open, close).match(/\bfeaturePath\s*:/g) || []).length;
  if (featurePaths !== capabilities.length) {
    throw new Error(
      `${label}: read ${capabilities.length} capability entries but the CAPABILITIES array names ` +
        `${featurePaths} featurePath keys, so an entry or a key has a shape this reader does not understand`
    );
  }
  return capabilities;
}

export function readDeclaredCapabilities(root) {
  return parseCapabilityRegistry(readFileSync(join(root, REGISTRY_PATH), 'utf8'));
}

// ---------------------------------------------------------------------------
// Source 2: the measured host route table
// ---------------------------------------------------------------------------

const MATCHES_ROUTE = /matches_route\(\s*path\s*,\s*"(\/[^"]*)"\s*\)/g;

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/** The top-level `||` alternatives of a Rust condition (parentheses are opaque). */
function alternativesOf(condition) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < condition.length; k += 1) {
    if (condition[k] === '(') depth += 1;
    else if (condition[k] === ')') depth -= 1;
    else if (depth === 0 && condition[k] === '|' && condition[k + 1] === '|') {
      parts.push(condition.slice(from, k));
      from = k + 2;
      k += 1;
    }
  }
  parts.push(condition.slice(from));
  return parts;
}

/**
 * The `if` statements in [from, to) of `classify`, recording for every route a
 * condition names the methods that reach it. `inherited` is the method set of
 * the enclosing `if` (null: every method). A condition is read as a
 * conjunction: `method == "GET" && matches_route(path, "/x")` serves GET /x, and
 * `(method == "GET" || method == "POST") && ...` serves both. Anything that
 * would change that reading is an error, not a guess.
 */
function scanClassifyBlock({ code, shape }, from, to, inherited, served, label) {
  let k = from;
  while (k < to) {
    if (shape[k] === '{') {
      // A block that is not the body of an `if` is not read; the count check in
      // `parseClassify` catches a route that hides in one.
      k = matchClose(shape, k) + 1;
      continue;
    }
    const isIf =
      shape.startsWith('if', k) &&
      !WORD_CHAR.test(shape[k - 1] || ' ') &&
      !WORD_CHAR.test(shape[k + 2] || ' ');
    if (!isIf) {
      k += 1;
      continue;
    }
    let parens = 0;
    let open = k + 2;
    for (; open < to; open += 1) {
      if (shape[open] === '(') parens += 1;
      else if (shape[open] === ')') parens -= 1;
      else if (shape[open] === '{' && parens === 0) break;
    }
    if (open >= to) throw new Error(`${label}: an if in classify has no block`);
    const close = matchClose(shape, open);
    const condition = code.slice(k + 2, open);

    const own = [...condition.matchAll(/\bmethod\s*==\s*"([A-Za-z]+)"/g)].map((match) =>
      match[1].toUpperCase()
    );
    const mentionsMethod = /\bmethod\b/.test(condition);
    if (
      /\bmethod\s*!=|!\s*\(?\s*method\b/.test(condition) ||
      (mentionsMethod && own.length === 0)
    ) {
      throw new Error(
        `${label}: classify tests the method in a way this reader does not understand: ${JSON.stringify(condition.trim())}`
      );
    }
    const alternatives = alternativesOf(condition);
    if (
      alternatives.length > 1 &&
      alternatives.some((part) => /\bmethod\b/.test(part)) &&
      alternatives.some((part) => /matches_route/.test(part)) &&
      !alternatives.every(
        (part) =>
          /\bmethod\b/.test(part) === /\bmethod\b/.test(alternatives[0]) &&
          /matches_route/.test(part) === /matches_route/.test(alternatives[0])
      )
    ) {
      throw new Error(
        `${label}: classify condition mixes method and route alternatives: ${JSON.stringify(condition.trim())}`
      );
    }

    let effective = inherited;
    if (own.length > 0) {
      effective = inherited === null ? own : inherited.filter((method) => own.includes(method));
    }
    for (const match of condition.matchAll(MATCHES_ROUTE)) {
      const methods = served.get(match[1]) || new Set();
      for (const method of effective === null ? ['*'] : effective) methods.add(method);
      served.set(match[1], methods);
    }
    scanClassifyBlock({ code, shape }, open + 1, close, effective, served, label);
    k = close + 1;
    if (/^\s*else\b/.test(shape.slice(k, k + 24))) {
      throw new Error(`${label}: classify has an else branch, which this reader does not follow`);
    }
  }
}

/**
 * `classify(method, path)`: for every route it serves, the methods it serves it
 * for (`*` when no condition names one). A method mismatch falls through to
 * Target::NotFound, which is why GET /keys/derived is a 404.
 */
function parseClassify(masked, label) {
  const { code, shape } = masked;
  const fn = /\bpub\s+fn\s+classify\s*\(/.exec(shape);
  if (!fn) throw new Error(`${label}: the classify function was not found`);
  const open = shape.indexOf('{', matchClose(shape, shape.indexOf('(', fn.index)));
  if (open === -1) throw new Error(`${label}: the classify function has no body`);
  const close = matchClose(shape, open);

  const served = new Map();
  scanClassifyBlock(masked, open + 1, close, null, served, label);

  // The independent count: every route literal classify names, wherever it sits.
  const named = new Set([...code.slice(open, close).matchAll(MATCHES_ROUTE)].map((m) => m[1]));
  const unattributed = [...named].filter((route) => !served.has(route));
  if (unattributed.length > 0) {
    throw new Error(
      `${label}: classify names ${unattributed.join(', ')} where this reader cannot tell which ` +
        `methods reach it (outside an if condition it follows)`
    );
  }
  if (served.size === 0) throw new Error(`${label}: no routes were parsed from classify`);
  return served;
}

/**
 * The lanes the table classifies but whose handler refuses in the shipped
 * posture. It is derived by following the source: find the handler in `sign.rs`
 * that returns `blind_sign_disabled_error()`, then find the `Target::` arm in
 * `dispatch.rs` that calls it, then map that arm to its route. Reporting a
 * routed-but-refusing lane as dead is the difference between four dead proxies
 * by path and three.
 */
function deriveRetired({ routes, dispatch, sign }) {
  const retired = new Set();
  if (!sign.includes(RETIREMENT_GUARD)) return retired;
  // The handler is the function whose body returns the refusal.
  let handler = null;
  for (const match of sign.matchAll(/pub fn (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    if (match[2].includes(RETIREMENT_GUARD)) {
      handler = match[1];
      break;
    }
  }
  if (!handler) return retired;
  // The dispatch arm that calls the handler, and the route that arm serves.
  // Arms are split on `Target::X => {` rather than searched with a bounded
  // window: a window crosses arm boundaries and would attribute a refusal to
  // whichever earlier arm happens to sit within 400 characters of it. The `=>`
  // is what distinguishes an arm from the `Target::SignPayload` that appears as
  // a bare argument inside the `admit!` macro.
  const arms = [...dispatch.matchAll(/Target::(\w+)\s*=>\s*\{/g)];
  arms.forEach((arm, index) => {
    const end = index + 1 < arms.length ? arms[index + 1].index : dispatch.length;
    if (!new RegExp(`\\b${handler}\\s*\\(`).test(dispatch.slice(arm.index, end))) return;
    const canonical = routes.match(new RegExp(`Target::${arm[1]} => "([^"]+)"`));
    if (canonical) retired.add(canonical[1]);
  });
  return retired;
}

/**
 * Read the measured host route table from the three source texts. Returns the
 * routes served, the methods each is served for, and the retired lanes.
 */
export function parseHostRoutes({ routes: routesSource, dispatch, sign }) {
  const masked = maskRust(routesSource);
  const served = parseClassify(masked, HOST_ROUTES_PATH);
  const retired = deriveRetired({
    routes: masked.code,
    dispatch: maskRust(dispatch).code,
    sign: maskRust(sign).code,
  });
  const routes = [...served.keys()].sort();
  return {
    routes,
    methods: Object.fromEntries(routes.map((route) => [route, [...served.get(route)].sort()])),
    retired: [...retired].sort(),
  };
}

export function readHostRoutes(root) {
  return parseHostRoutes({
    routes: readFileSync(join(root, HOST_ROUTES_PATH), 'utf8'),
    dispatch: readFileSync(join(root, HOST_DISPATCH_PATH), 'utf8'),
    sign: readFileSync(join(root, HOST_SIGN_PATH), 'utf8'),
  });
}

// ---------------------------------------------------------------------------
// Source 3: the web proxy targets
// ---------------------------------------------------------------------------

/** The index of the backtick that closes the template literal opening at `start`. */
function templateEnd(shape, start) {
  let k = start + 1;
  while (k < shape.length) {
    if (shape[k] === '`') return k;
    k = shape[k] === '$' && shape[k + 1] === '{' ? matchClose(shape, k + 1) + 1 : k + 1;
  }
  throw new Error(`unterminated template literal at offset ${start}`);
}

/**
 * The host path a `proxyToNitro` call targets. The first argument must be one
 * quoted or template literal. In a template, an interpolation becomes `*` (the
 * host table is matched on literal paths, so a path only known at run time can
 * never equal one) and the query string is dropped, because the table is
 * matched on the path alone: `/keys/derived?role=${role}` targets
 * `/keys/derived`.
 */
function readProxyTarget(source, shape, [start, end], where) {
  const text = shape.slice(start, end);
  let value;
  if (/^(['"])_*\1$/.test(text)) {
    value = source.slice(start + 1, end - 1);
  } else if (shape[start] === '`' && templateEnd(shape, start) === end - 1) {
    value = '';
    for (let k = start + 1; k < end - 1; ) {
      if (shape[k] === '$' && shape[k + 1] === '{') {
        value += '*';
        k = matchClose(shape, k + 1) + 1;
      } else {
        value += source[k];
        k += 1;
      }
    }
  } else {
    throw new Error(
      `${where}: the target must be one quoted or template literal, got ${excerpt(source, start, end)}`
    );
  }
  if (value.includes('\\')) throw new Error(`${where}: the target contains an escape sequence`);
  const path = value.split(/[?#]/)[0];
  if (!path.startsWith('/')) {
    throw new Error(`${where}: the target ${JSON.stringify(value)} is not an absolute path`);
  }
  return path;
}

/**
 * The HTTP method a `proxyToNitro` call sends: the `method` literal of its init
 * object, or GET when there is none (`fetch` defaults to GET). An init that is
 * not an object literal, a spread, or a method that is not a literal could be
 * anything, so each is an error.
 */
function readProxyMethod(source, shape, span, where) {
  if (!span) return 'GET';
  if (shape.slice(span[0], span[1]) === 'undefined') return 'GET';
  const initWhere = `${where}: the init argument`;
  const [open, close] = objectBounds(source, shape, span, initWhere);
  const members = readMembers(source, shape, open, close, initWhere);
  if (!members.has('method')) return 'GET';
  return readStringLiteral(source, shape, members.get('method'), `${where}: method`).toUpperCase();
}

/**
 * Every `proxyToNitro(<path>, <init>)` call in one source file. Each reference to
 * the helper must be a direct call whose target and method can be read; an alias
 * (`import { proxyToNitro as p }`), a bare reference or a computed argument is an
 * error, because a proxy this reader cannot read is a proxy it cannot vouch for.
 */
export function parseProxyCalls(source, label) {
  const shape = maskScript(source);
  const imports = [...shape.matchAll(/\bimport\s*(?:[\w$*\s,{}]*?\bfrom\s*)?(['"])_*\1\s*;?/g)].map(
    (match) => [match.index, match.index + match[0].length]
  );
  const calls = [];
  for (const match of shape.matchAll(/\bproxyToNitro\b/g)) {
    const here = `${label}:${lineOf(source, match.index)}`;
    const importSpan = imports.find(([from, to]) => match.index >= from && match.index < to);
    if (importSpan) {
      if (/\bproxyToNitro\s+as\b/.test(shape.slice(importSpan[0], importSpan[1]))) {
        throw new Error(
          `${here}: proxyToNitro is imported under another name, so its calls cannot be found`
        );
      }
      continue;
    }
    let paren = match.index + match[0].length;
    while (/\s/.test(shape[paren] || '')) paren += 1;
    if (shape[paren] !== '(') {
      throw new Error(
        `${here}: proxyToNitro is used other than by a direct call, so its target cannot be read`
      );
    }
    const args = splitTopLevel(shape, paren, matchClose(shape, paren));
    if (args.length === 0) throw new Error(`${here}: proxyToNitro is called without a target`);
    calls.push({
      target: readProxyTarget(source, shape, args[0], `${here}: proxyToNitro`),
      method: readProxyMethod(source, shape, args[1], `${here}: proxyToNitro`),
    });
  }
  return calls;
}

const SKIPPED_WEB_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'public',
  '__tests__',
]);

const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * `proxyToNitro` is defined in apps/web/lib/nitro.ts and called from the route
 * files. A wrapper in another module would route requests to the host without
 * this gate ever reading its target, so a reference anywhere else is an error.
 */
function assertNoProxyOutsideRoutes(root) {
  const webDir = join(root, 'apps/web');
  if (!existsSync(webDir)) return;
  const apiDir = join(root, WEB_API_DIR);
  const definition = join(root, 'apps/web/lib/nitro.ts');
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_WEB_DIRECTORIES.has(entry.name)) walk(path);
        continue;
      }
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) {
        continue;
      }
      if (path === definition) continue;
      const insideRoutes = path.startsWith(apiDir + sep) && ROUTE_FILE.test(entry.name);
      if (!insideRoutes && readFileSync(path, 'utf8').includes('proxyToNitro')) {
        throw new Error(
          `${relative(root, path)} references proxyToNitro outside the route files under ${WEB_API_DIR}; ` +
            `a proxy called from there is invisible to this gate`
        );
      }
    }
  };
  walk(webDir);
}

/**
 * Read the web proxy targets: every `proxyToNitro(<path>, <init>)` call under
 * the Next.js API tree, with the public route it serves (the API directory
 * path, which is how a caller names the proxy), the host path it targets and the
 * method it sends.
 */
export function readWebProxyTargets(root) {
  const apiDir = join(root, WEB_API_DIR);
  if (!existsSync(apiDir)) throw new Error(`${WEB_API_DIR}: the web API tree was not found`);
  assertNoProxyOutsideRoutes(root);
  const proxies = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!ROUTE_FILE.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      if (!source.includes('proxyToNitro')) continue;
      const directory = relative(apiDir, dir).split(sep).join('/');
      const route = directory ? `/api/${directory}` : '/api';
      for (const call of parseProxyCalls(source, relative(root, path))) {
        proxies.push({ route, ...call });
      }
    }
  };
  walk(apiDir);
  return proxies.sort(
    (a, b) =>
      a.route.localeCompare(b.route) ||
      a.target.localeCompare(b.target) ||
      a.method.localeCompare(b.method)
  );
}

// ---------------------------------------------------------------------------
// Source 4: the edge gateway's host-bound passthrough
// ---------------------------------------------------------------------------

/**
 * The paths the edge gateway forwards to the runtime box (the enclave host) with
 * the caller's own method: the `RUNTIME_BOX_PASSTHROUGH` list in the Cloudflare
 * worker. Every other path the edge serves is answered from apps/web or refused
 * with a 503, so this list is the edge's whole set of host targets. Each element
 * must be a plain string literal, and the list may not be changed after its
 * literal, or a target would go unread.
 */
export function parseEdgePassthrough(source, label = EDGE_WORKER_PATH) {
  const shape = maskScript(source);
  const declaration = /\bconst\s+RUNTIME_BOX_PASSTHROUGH\s*=\s*\[/.exec(shape);
  if (!declaration) throw new Error(`${label}: the RUNTIME_BOX_PASSTHROUGH list was not found`);
  const open = declaration.index + declaration[0].length - 1;
  const close = matchClose(shape, open);
  const mutation = /\bRUNTIME_BOX_PASSTHROUGH\s*\.\s*(?:push|unshift|splice)\b/.exec(shape);
  if (mutation) {
    throw new Error(
      `${label}: RUNTIME_BOX_PASSTHROUGH is changed after its literal, so a target would go unread`
    );
  }
  return splitTopLevel(shape, open, close).map((span, index) => {
    const where = `${label}: RUNTIME_BOX_PASSTHROUGH element ${index + 1}`;
    const path = readStringLiteral(source, shape, span, where);
    if (!path.startsWith('/')) throw new Error(`${where} is not an absolute path`);
    return path;
  });
}

export function readEdgePassthrough(root) {
  return parseEdgePassthrough(readFileSync(join(root, EDGE_WORKER_PATH), 'utf8'));
}

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

/** Milliseconds since the epoch for a real calendar date written YYYY-MM-DD, else null. */
export function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    return null;
  }
  return milliseconds;
}

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validate the shape of a baseline. Every entry needs an id (or route), a
 * reason, an owner and an expiry that is a real calendar date, the same
 * "absence without a record is a hard failure" rule the KMS attestation pins
 * follow. A proxy entry also records the target and the method it was recorded
 * with, so the record can say when a proxy has moved to a different dead lane.
 */
export function loadBaseline(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('baseline must be a JSON object');
  }
  const problems = [];
  const check = (key, nameKey, label, extra) => {
    const entries = raw[key];
    if (!Array.isArray(entries)) {
      problems.push(`baseline.${key} must be an array`);
      return;
    }
    const seen = new Set();
    for (const entry of entries) {
      const name = entry && typeof entry[nameKey] === 'string' ? entry[nameKey] : '';
      if (!name) {
        problems.push(`baseline ${label} entry ${JSON.stringify(entry)} has no ${nameKey}`);
        continue;
      }
      const identity = extra ? `${name} ${entry.method} ${entry.target}` : name;
      if (seen.has(identity)) problems.push(`baseline ${label} ${name} is listed twice`);
      seen.add(identity);
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        problems.push(`baseline ${label} ${name} has no reason`);
      }
      if (typeof entry.owner !== 'string' || !entry.owner.trim()) {
        problems.push(`baseline ${label} ${name} has no owner`);
      }
      if (parseIsoDate(entry.expires) === null) {
        problems.push(
          `baseline ${label} ${name} has no real calendar date as expiry (expires: "YYYY-MM-DD", got ${JSON.stringify(entry.expires)})`
        );
      }
      if (extra) extra(entry, name);
    }
  };
  check('dead_capability_ids', 'id', 'capability id');
  check('dead_web_proxies', 'route', 'web proxy', (entry, name) => {
    if (typeof entry.target !== 'string' || !entry.target.startsWith('/')) {
      problems.push(`baseline web proxy ${name} has no target path`);
    }
    if (typeof entry.method !== 'string' || !/^[A-Z]+$/.test(entry.method)) {
      problems.push(`baseline web proxy ${name} has no HTTP method (upper case, e.g. GET)`);
    }
  });
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return raw;
}

function readBaselineFile(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return null;
  return loadBaseline(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * The single place the dead-lane rules live, so the summary line and the
 * findings can never disagree about what counts as dead.
 *
 * `routed` - the host table has an entry for the route. This is the test for a
 * declared capability id: `sign_payload` is routed (Target::SignPayload) even
 * though its lane is closed. The registry names no method, so ids are judged on
 * the path alone.
 *
 * A web proxy is dead when the host cannot answer what it sends: the route is
 * not in the table, or the lane is retired, or the host serves the route for
 * other methods only. That is why the proxy counts exceed the id counts.
 */
export function partition({ declared, host, proxies }) {
  if (!host.methods) {
    throw new Error('host.methods is missing: the route table was read without its methods');
  }
  const hostRoutes = new Set(host.routes);
  const retiredRoutes = new Set(host.retired);
  const routed = (route) => hostRoutes.has(route);
  const live = (route) => hostRoutes.has(route) && !retiredRoutes.has(route);
  const verdict = (proxy) => {
    if (!hostRoutes.has(proxy.target)) return 'the host has no such route';
    if (retiredRoutes.has(proxy.target)) return 'the host classifies it but the lane is retired';
    const methods = host.methods[proxy.target] || [];
    if (!methods.includes('*') && !methods.includes(proxy.method)) {
      return `the host serves it for ${methods.join(', ')} only, not ${proxy.method}`;
    }
    return null;
  };
  const judged = proxies.map((proxy) => ({ ...proxy, why: verdict(proxy) }));
  return {
    routed,
    live,
    deadIds: declared.filter((capability) => !capability.routes.some(routed)),
    retiredIds: declared.filter(
      (capability) => capability.routes.some(routed) && !capability.routes.some(live)
    ),
    liveIds: declared.filter((capability) => capability.routes.some(live)),
    deadProxies: judged.filter((proxy) => proxy.why !== null),
    liveProxies: judged.filter((proxy) => proxy.why === null),
  };
}

const describeProxy = (proxy) => `${proxy.route} -> ${proxy.method} ${proxy.target}`;

/**
 * The comparison against the tree. Returns a list of human-readable problems;
 * empty means the tree is at or below the recorded debt. Only `options.today`
 * moves the clock, and only for a caller that holds the function: the CLI has
 * no flag for it.
 */
export function auditRouteParity(
  { declared, host, proxies, baseline, edge = { passthrough: [] } },
  options = {}
) {
  const today = options.today ?? utcToday();
  if (parseIsoDate(today) === null) {
    throw new Error(`today must be a real YYYY-MM-DD date, got ${JSON.stringify(today)}`);
  }
  // Both dead-lane rules live in `partition`, so the summary line a green run
  // prints and the findings a red run prints can never disagree.
  const { deadIds, deadProxies, live } = partition({ declared, host, proxies });

  // The edge forwards these paths to the host with the caller's own method, so each
  // has to be a route the host serves and has not retired. There is no baseline for
  // them: an edge target the host cannot answer is fixed in the edge.
  const edgeProblems = edge.passthrough
    .filter((path) => !live(path))
    .map(
      (path) =>
        `edge gateway passthrough ${path} ` +
        (host.retired.includes(path)
          ? 'targets a host lane that is retired'
          : 'targets a route the host does not have') +
        `. Remove it from RUNTIME_BOX_PASSTHROUGH in ${EDGE_WORKER_PATH}, or give the host the route.`
    );

  if (!baseline) {
    return [
      `no baseline at ${BASELINE_PATH}. The gate cannot pass without a dated, owned record of the ` +
        `known dead lanes; without it the tree is ${deadIds.length} declared capability ids without a ` +
        `host route and ${deadProxies.length} web proxies targeting a route the host cannot answer. ` +
        `Dead capability ids: ${deadIds.map((c) => c.id).join(', ') || 'none'}. ` +
        `Dead web proxies: ${deadProxies.map(describeProxy).join(', ') || 'none'}.`,
      ...edgeProblems,
    ];
  }

  const problems = [...edgeProblems];
  const idEntries = baseline.dead_capability_ids;
  const proxyEntries = baseline.dead_web_proxies;

  // 1. Every dead id must already be baselined. A newly declared lane with no
  //    host route is the exact failure this gate exists to catch.
  for (const capability of deadIds) {
    if (!idEntries.some((entry) => entry.id === capability.id)) {
      problems.push(
        `capability id ${capability.id} is declared (${capability.routes.join(', ')}) but the host ` +
          `serves no such route, and it is not in the baseline. Add a host route, or land CU-149.`
      );
    }
  }

  // 2. Every dead proxy must already be baselined, with the target and method it
  //    was recorded with: re-pointing a baselined proxy at another dead route is
  //    a new finding, not the old debt.
  for (const proxy of deadProxies) {
    const recorded = proxyEntries.filter((entry) => entry.route === proxy.route);
    if (recorded.length === 0) {
      problems.push(
        `web proxy ${describeProxy(proxy)} is dead (${proxy.why}) and it is not in the baseline. ` +
          `Remove the proxy, or land CU-149.`
      );
    } else if (
      !recorded.some((entry) => entry.target === proxy.target && entry.method === proxy.method)
    ) {
      problems.push(
        `web proxy ${proxy.route} now sends ${proxy.method} ${proxy.target} (${proxy.why}), but the ` +
          `baseline records ${recorded.map((entry) => `${entry.method} ${entry.target}`).join(' or ')}. ` +
          `Re-pointing a baselined proxy at another dead route is a new finding: fix the proxy.`
      );
    }
  }

  // 2b. A declared id whose only route is retired is NOT a finding of its own:
  //     it is why the proxies above are dead, and it is baselined as such (the
  //     /api/sign/payload entry). `describe` reports it on a green run so the
  //     reader still sees that the lane exists and is closed.

  // 3. The baseline is shrink-only: an entry that is no longer dead is stale
  //    debt and fails, so the record cannot be widened to admit anything.
  for (const entry of idEntries) {
    if (!deadIds.some((capability) => capability.id === entry.id)) {
      const known = declared.some((capability) => capability.id === entry.id);
      problems.push(
        known
          ? `baseline capability id ${entry.id} is not dead - the host now serves its route. ` +
              `Delete the entry (that is how the baseline shrinks).`
          : `baseline capability id ${entry.id} is not dead and not declared. Delete the entry.`
      );
    }
  }
  for (const entry of proxyEntries) {
    if (!deadProxies.some((proxy) => proxy.route === entry.route)) {
      problems.push(
        `baseline web proxy ${entry.route} is not dead. Delete the entry (that is how the baseline shrinks).`
      );
    }
  }

  // 4. Debt may not be renewed by moving a date. `expires` is the first day an
  //    entry no longer holds, and no entry may be dated beyond the horizon.
  const horizon = addDays(today, MAX_EXPIRY_HORIZON_DAYS);
  for (const entry of [...idEntries, ...proxyEntries]) {
    const name = entry.id || entry.route;
    if (today >= entry.expires) {
      problems.push(
        `baseline entry ${name} expired on ${entry.expires} (owner: ${entry.owner}). ` +
          `Fix the lane and delete the entry. A date is not moved in the baseline: --base rejects a later ` +
          `expires on a pull request, so a renewal is a recorded decision in this gate, as the topology ` +
          `gate's renewed exception is.`
      );
    } else if (entry.expires > horizon) {
      problems.push(
        `baseline entry ${name} expires on ${entry.expires}, more than ${MAX_EXPIRY_HORIZON_DAYS} days ` +
          `after ${today}; the latest date accepted today is ${horizon}. A date that far out is not a deadline.`
      );
    }
  }

  return problems;
}

/**
 * The shrink-only rule against history: `current` may only keep entries that
 * `base` already had, with an `expires` no later and, for a proxy, the same
 * target and method. `base` is the baseline at the pull request's base commit.
 */
export function auditBaselineShrink({ base, current, ref }) {
  const problems = [];
  const later = (entry, before, name) => {
    if (parseIsoDate(before.expires) === null) {
      problems.push(
        `baseline entry ${name} has no real expiry at ${ref}, so it cannot be compared`
      );
    } else if (entry.expires > before.expires) {
      problems.push(
        `baseline entry ${name} was extended from ${before.expires} to ${entry.expires} since ${ref}. ` +
          `Debt is not renewed by editing a date: fix the lane, or record the decision in this gate.`
      );
    }
  };
  for (const entry of current.dead_capability_ids) {
    const before = base.dead_capability_ids.find((candidate) => candidate.id === entry.id);
    if (!before) {
      problems.push(
        `baseline capability id ${entry.id} was added since ${ref}. The baseline only shrinks: ` +
          `give the lane a host route, or do not declare it.`
      );
    } else {
      later(entry, before, entry.id);
    }
  }
  for (const entry of current.dead_web_proxies) {
    const name = `${entry.route} (${entry.method} ${entry.target})`;
    const sameRoute = base.dead_web_proxies.filter((candidate) => candidate.route === entry.route);
    if (sameRoute.length === 0) {
      problems.push(
        `baseline web proxy ${name} was added since ${ref}. The baseline only shrinks: ` +
          `remove the proxy, or give the host the route.`
      );
      continue;
    }
    const before = sameRoute.find(
      (candidate) => candidate.target === entry.target && candidate.method === entry.method
    );
    if (!before) {
      problems.push(
        `baseline web proxy ${entry.route} was re-pointed since ${ref}: it recorded ` +
          `${sameRoute.map((candidate) => `${candidate.method} ${candidate.target}`).join(' or ')} and now ` +
          `records ${entry.method} ${entry.target}. Another dead route is a new finding, not the old debt.`
      );
    } else {
      later(entry, before, name);
    }
  }
  return problems;
}

const GIT_ENVIRONMENT_TO_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

/**
 * The baseline as it was at `ref`, or null when the file did not exist there
 * (the pull request that introduces the gate). A ref that is not a commit in
 * this checkout is an error, not an empty baseline: comparing against nothing
 * would let every entry through.
 */
export function readBaselineAtRef(root, ref) {
  const env = { ...process.env };
  for (const name of GIT_ENVIRONMENT_TO_DROP) delete env[name];
  const git = (args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(
      `--base ${ref} is not a commit in this checkout. On a pull request, fetch it first: ` +
        `git fetch --no-tags --depth=1 origin ${ref}`
    );
  }
  try {
    git(['cat-file', '-e', `${ref}:${BASELINE_PATH}`]);
  } catch {
    return null;
  }
  const raw = JSON.parse(git(['show', `${ref}:${BASELINE_PATH}`]));
  for (const key of ['dead_capability_ids', 'dead_web_proxies']) {
    if (!Array.isArray(raw?.[key])) {
      throw new Error(`the baseline at ${ref} has no ${key} array, so it cannot be compared`);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE =
  'Usage: node scripts/check-capability-route-parity.mjs [--root <dir>] [--base <git ref>]';

export function parseArgs(argv) {
  const args = { root: REPO_ROOT, base: null };
  const valueOf = (index, flag) => {
    if (index >= argv.length || argv[index].startsWith('--')) {
      throw new UsageError(`${flag} needs a value`);
    }
    return argv[index];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = resolve(valueOf((i += 1), arg));
    else if (arg.startsWith('--root=')) args.root = resolve(arg.slice('--root='.length));
    else if (arg === '--base') args.base = valueOf((i += 1), arg);
    else if (arg.startsWith('--base=')) args.base = arg.slice('--base='.length);
    else throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (args.base !== null && !/^[0-9A-Za-z][0-9A-Za-z._/~^@-]*$/.test(args.base)) {
    throw new UsageError(`--base ${JSON.stringify(args.base)} is not a plausible git ref`);
  }
  return args;
}

/** A short report for the passing case, so a green run still says what it saw. */
function describe({ declared, host, proxies, edge }, today) {
  const { deadIds, deadProxies, liveProxies, liveIds, retiredIds } = partition({
    declared,
    host,
    proxies,
  });
  return [
    `Capability route-parity gate: ${declared.length} declared capability ids ` +
      `(${liveIds.length} with a live host route, ${deadIds.length} baselined as dead` +
      (retiredIds.length > 0 ? `, ${retiredIds.length} routed but retired` : '') +
      `), ${proxies.length} web proxies (${liveProxies.length} live, ${deadProxies.length} baselined as dead).`,
    ...(retiredIds.length > 0
      ? [
          `Routed but retired (the host classifies these and answers 503 in the shipped ` +
            `posture, so every proxy aimed at them is dead): ${retiredIds.map((c) => c.id).join(', ')}.`,
        ]
      : []),
    ...(edge.passthrough.length > 0
      ? [
          `Edge gateway: ${edge.passthrough.length} host-bound passthrough routes, all live on the host ` +
            `(${edge.passthrough.join(', ')}).`,
        ]
      : []),
    `Baseline: ${BASELINE_PATH} (checked ${today}).`,
  ];
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`Capability route-parity gate: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const today = utcToday();

  let declared;
  let host;
  let proxies;
  let edge;
  let baseline;
  let before;
  try {
    declared = readDeclaredCapabilities(args.root);
    host = readHostRoutes(args.root);
    proxies = readWebProxyTargets(args.root);
    edge = { passthrough: readEdgePassthrough(args.root) };
    baseline = readBaselineFile(args.root);
    if (args.base !== null) before = readBaselineAtRef(args.root, args.base);
  } catch (error) {
    console.error(`Capability route-parity gate could not read its sources: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const problems = auditRouteParity({ declared, host, proxies, baseline, edge }, { today });
  if (baseline && before) {
    problems.push(...auditBaselineShrink({ base: before, current: baseline, ref: args.base }));
  }

  if (problems.length > 0) {
    const { deadIds, deadProxies } = partition({ declared, host, proxies });
    const byPath = deadProxies.filter((proxy) => !/serves it for/.test(proxy.why));
    console.error('Capability route-parity gate failed:');
    console.error(
      `- ${deadIds.length} declared capability ids without a host route: ${deadIds.map((c) => c.id).join(', ') || 'none'}`
    );
    console.error(
      `- ${deadProxies.length} web proxies target a route the host cannot answer` +
        (byPath.length === deadProxies.length
          ? ''
          : ` (${byPath.length} by path, ${deadProxies.length - byPath.length} by method)`) +
        `: ${deadProxies.map(describeProxy).join(', ') || 'none'}`
    );
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  for (const line of describe({ declared, host, proxies, edge }, today)) console.log(line);
  if (args.base !== null) {
    console.log(
      before
        ? `Baseline shrink check against ${args.base}: no entry added, none extended, no proxy re-pointed.`
        : `Baseline shrink check against ${args.base}: the baseline does not exist there, so this change introduces it and there is nothing to compare.`
    );
  }
  console.log('Capability route-parity gate passed.');
}

// A symlinked path (macOS /tmp, a worktree under a link) makes argv[1] and
// import.meta.url name the same file differently; comparing real paths keeps the
// gate from deciding it was imported and exiting 0 without checking anything.
const invokedDirectly = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await main();
}

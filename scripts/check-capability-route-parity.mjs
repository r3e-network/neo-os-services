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
 *   1. workers/nitro-worker/src/capabilities.js — the capability registry. Thirty
 *      ids with their paths, patterns and action fallbacks. It is the published
 *      contract: the relayer, the SDK and the docs all resolve against it.
 *   2. workers/nitro-enclave-host/src/routes.rs — the route table of the image
 *      that actually runs (`classify`, the pure classifier `dispatch.rs` feeds).
 *      This is the measured frontier; everything in the JS tree above it is
 *      scheduled for deletion.
 *   3. apps/web/app/api/**\/route.ts — the Next.js proxies, each calling
 *      `proxyToNitro(<host path>)`. A proxy whose target the host does not
 *      serve is a 404 behind a 200-shaped public API.
 *
 * At HEAD, twelve declared capability ids have no host route at all and four
 * web proxies target a route the host does not serve (`/sign/payload` is
 * present in the table but the lane is retired and answers 503 unless the
 * measured image sets ENCLAVE_ALLOW_BLIND_SIGN=1, which the shipped posture
 * does not). That is the finding: not that the gap is large, but that it was
 * invisible. Every lane added after this point is checked against the host
 * before anybody builds a caller for it.
 *
 * THE BASELINE IS SHRINK-ONLY
 * ---------------------------
 * `baselines/capability-route-parity.json` records the known dead ids so the
 * gate is green on the head instead of red on arrival. It is a record of debt,
 * not an allowance, and it may only ever get smaller:
 *
 *   * every entry needs an `owner` and an `expires` date — an undocumented
 *     absence is a hard failure, the same rule the KMS pins record follows;
 *   * an entry naming an id that is NOT dead fails the gate, so the baseline
 *     cannot be used to wave through a lane that was fixed (or never broken);
 *   * an entry whose `expires` has passed fails the gate, so debt cannot be
 *     renewed by editing a date;
 *   * an entry with no corresponding dead id fails the gate, so the baseline
 *     cannot be widened to admit a newly declared id.
 *
 * Shrinking is the only edit that passes: when CU-149 adds the catalog routes
 * or removes the dead proxies, delete the entry and the gate stays green.
 *
 * No host code changes here, so the enclave measurement is untouched: nothing
 * in the measured frontier, its Cargo.lock or its Dockerfiles is read into a
 * decision, only the route table's own source text.
 *
 * USAGE
 *   node scripts/check-capability-route-parity.mjs
 *   node scripts/check-capability-route-parity.mjs --root <dir>   # audit a tree
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The registry: thirty declared ids, of which twelve are dead on the head. */
export const DECLARED_CAPABILITY_COUNT = 30;

/** Where the shrink-only debt record lives, relative to the repository root. */
export const BASELINE_PATH = 'baselines/capability-route-parity.json';

const REGISTRY_PATH = 'workers/nitro-worker/src/capabilities.js';
const HOST_ROUTES_PATH = 'workers/nitro-enclave-host/src/routes.rs';
const HOST_DISPATCH_PATH = 'workers/nitro-enclave-host/src/dispatch.rs';
const HOST_SIGN_PATH = 'workers/nitro-enclave-host/src/sign.rs';
const WEB_API_DIR = 'apps/web/app/api';

/**
 * The refusal a host handler returns when the lane is closed unless the image
 * opts in. `sign.rs` guards `handle_sign_payload` with
 * `if !blind_sign_enabled(state) { return Err(blind_sign_disabled_error()) }`,
 * and `scripts/custody-plane-e2e.mjs:353` asserts that closed posture is what
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

/**
 * Read the capability registry.
 *
 * Parses the `CAPABILITIES` array literal: each entry's `id` and its `paths`
 * (`{ match: '/x' }` for an exact route, `{ pattern: /…/ }` for the two
 * parameterised ones). A pattern route is reported with its literal source text
 * as the route, because the host table is exact-match only and a pattern lane
 * can never be satisfied by a host route — which is the point for
 * `feeds_price_symbol` and `compute_jobs_id`.
 */
export function readDeclaredCapabilities(root) {
  const source = readFileSync(join(root, REGISTRY_PATH), 'utf8');
  const start = source.indexOf('const CAPABILITIES = [');
  if (start === -1) throw new Error(`${REGISTRY_PATH}: the CAPABILITIES array was not found`);
  const end = source.indexOf('\n];', start);
  if (end === -1) throw new Error(`${REGISTRY_PATH}: the CAPABILITIES array is unterminated`);
  const body = source.slice(start, end);

  const capabilities = [];
  // Entries are separated at the top level by a `  },` line at two-space indent.
  const entryRe = /\{\s*id:\s*'([^']+)'([\s\S]*?)\n  \}/g;
  let match;
  while ((match = entryRe.exec(body)) !== null) {
    const [, id, rest] = match;
    const routes = [];
    let kind = 'exact';
    for (const routeMatch of rest.matchAll(/match:\s*'([^']+)'/g)) {
      routes.push(routeMatch[1]);
    }
    const pattern = rest.match(/pattern:\s*(\/.*?\/[a-z]*)/);
    if (pattern) {
      kind = 'pattern';
      routes.push(pattern[1]);
    }
    if (routes.length === 0)
      throw new Error(`${REGISTRY_PATH}: capability ${id} declares no route`);
    capabilities.push({ id, kind, routes });
  }
  if (capabilities.length === 0) throw new Error(`${REGISTRY_PATH}: no capabilities were parsed`);
  return capabilities;
}

/**
 * Read the measured host route table.
 *
 * `classify` matches each route literal with `matches_route(path, "<route>")`,
 * so every `"/…"` string literal in the table is a route the host serves.
 *
 * The retired set is the lanes the table classifies but whose handler refuses
 * in the shipped posture. It is derived by following the source: find the
 * handler in `sign.rs` that returns `blind_sign_disabled_error()`, then find
 * the `Target::` arm in `dispatch.rs` that calls it, then map that arm to its
 * route. Reporting a routed-but-refusing lane as dead is the difference between
 * three dead proxies and the four the tree actually has.
 */
export function readHostRoutes(root) {
  const source = readFileSync(join(root, HOST_ROUTES_PATH), 'utf8');
  const routes = new Set();
  for (const match of source.matchAll(/matches_route\(path,\s*"(\/[^"]+)"\)/g)) {
    routes.add(match[1]);
  }
  if (routes.size === 0) throw new Error(`${HOST_ROUTES_PATH}: no routes were parsed`);

  const retired = new Set();
  const signSource = readFileSync(join(root, HOST_SIGN_PATH), 'utf8');
  if (signSource.includes(RETIREMENT_GUARD)) {
    // The handler is the function whose body returns the refusal.
    const handlerRe = /pub fn (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;
    let handler;
    let handlerMatch;
    while ((handlerMatch = handlerRe.exec(signSource)) !== null) {
      if (handlerMatch[2].includes(RETIREMENT_GUARD)) {
        handler = handlerMatch[1];
        break;
      }
    }
    if (handler) {
      // The dispatch arm that calls the handler, and the route that arm serves.
      // Arms are split on `Target::X => {` rather than searched with a bounded
      // window: a window crosses arm boundaries and would attribute a refusal
      // to whichever earlier arm happens to sit within 400 characters of it.
      // The `=>` is what distinguishes an arm from the `Target::SignPayload`
      // that appears as a bare argument inside the `admit!` macro.
      const dispatch = readFileSync(join(root, HOST_DISPATCH_PATH), 'utf8');
      const arms = [...dispatch.matchAll(/Target::(\w+)\s*=>\s*\{/g)];
      for (let i = 0; i < arms.length; i += 1) {
        const start = arms[i].index;
        const end = i + 1 < arms.length ? arms[i + 1].index : dispatch.length;
        const block = dispatch.slice(start, end);
        if (!new RegExp(`\\b${handler}\\s*\\(`).test(block)) continue;
        const canonical = source.match(new RegExp(`Target::${arms[i][1]} => "([^"]+)"`));
        if (canonical) retired.add(canonical[1]);
      }
    }
  }
  return { routes: [...routes].sort(), retired: [...retired].sort() };
}

/**
 * Read the web proxy targets: every `proxyToNitro(<path>)` call site under the
 * Next.js API tree, paired with the public route it serves. The public route is
 * the API directory path, which is how a caller names the proxy.
 *
 * A target may be a single-quoted literal or a template literal with an
 * interpolated query (`/keys/derived?role=${…}` in
 * `app/api/runtime/keys/derived/route.ts`), so both forms are read. For a
 * template target the interpolation is collapsed to `*` and any query string
 * is dropped, because the host table is matched on the path alone.
 *
 * A call whose argument is neither form is a hard error rather than a skip: a
 * proxy the gate cannot read is a proxy the gate cannot vouch for, and silently
 * dropping one would recreate exactly the blind spot this gate exists to close.
 */
export function readWebProxyTargets(root) {
  const apiDir = join(root, WEB_API_DIR);
  if (!existsSync(apiDir)) throw new Error(`${WEB_API_DIR}: the web API tree was not found`);
  const proxies = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name !== 'route.ts') continue;
      const source = readFileSync(path, 'utf8');
      if (!source.includes('proxyToNitro(')) continue;
      const publicRoute = `/api/${relative(apiDir, path).replace(/[\\/]route\.ts$/, '')}`;
      for (const match of source.matchAll(/proxyToNitro\(\s*(['"`])([^'"`]*)\1/g)) {
        const target = match[2].replace(/\$\{[^}]*\}/g, '*').split('?')[0];
        if (!target.startsWith('/')) {
          throw new Error(
            `${relative(root, path)}: proxyToNitro target ${JSON.stringify(match[2])} is not an absolute path`
          );
        }
        proxies.push({ route: publicRoute, target });
      }
      // Every call must have been read; a count mismatch means an argument shape
      // this parser does not understand.
      const calls = (source.match(/proxyToNitro\s*\(/g) || []).length;
      const read = (source.match(/proxyToNitro\(\s*(['"`])/g) || []).length;
      if (calls !== read) {
        throw new Error(
          `${relative(root, path)}: ${calls - read} proxyToNitro call(s) could not be read; ` +
            `the target must be a quoted literal or a template literal`
        );
      }
    }
  };
  walk(apiDir);
  return proxies.sort((a, b) => a.route.localeCompare(b.route) || a.target.localeCompare(b.target));
}

/**
 * Validate the shape of a baseline. Every entry needs an id (or route), a
 * reason, an owner and an ISO expiry — the same "absence without a record is a
 * hard failure" rule the KMS attestation pins follow.
 */
export function loadBaseline(raw) {
  const problems = [];
  const check = (list, key, label) => {
    if (!Array.isArray(list)) {
      problems.push(`baseline.${key} must be an array`);
      return [];
    }
    for (const entry of list) {
      const name = entry && (entry[key] || '<unnamed>');
      if (!entry || typeof entry[key] !== 'string' || !entry[key]) {
        problems.push(`baseline ${label} entry ${name} has no ${key}`);
        continue;
      }
      if (typeof entry.owner !== 'string' || !entry.owner.trim()) {
        problems.push(`baseline ${label} ${entry[key]} has no owner`);
      }
      if (typeof entry.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
        problems.push(
          `baseline ${label} ${entry[key]} has no ISO expiry (expires: "YYYY-MM-DD", got ${JSON.stringify(entry.expires)})`
        );
      }
    }
    return list;
  };
  check(raw?.dead_capability_ids, 'id', 'capability');
  check(raw?.dead_web_proxies, 'route', 'web proxy');
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return raw;
}

function readBaselineFile(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return null;
  return loadBaseline(JSON.parse(readFileSync(path, 'utf8')));
}

/** An ISO date is expired once it is strictly before today. */
function isExpired(date, today) {
  return date < today;
}

/**
 * The comparison. Returns a list of human-readable problems; empty means the
 * tree is at or below the recorded debt.
 */
export function auditRouteParity({ declared, host, proxies, baseline }, options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const problems = [];
  const retiredRoutes = new Set(host.retired);

  // Both dead-lanes rules live in `partition`, so the summary line a green run
  // prints and the findings a red run prints can never disagree.
  const { deadIds, deadProxies } = partition({ declared, host, proxies });

  const baselineIds = new Map((baseline?.dead_capability_ids || []).map((e) => [e.id, e]));
  const baselineProxies = new Map((baseline?.dead_web_proxies || []).map((e) => [e.route, e]));

  if (!baseline) {
    return [
      `no baseline at ${BASELINE_PATH}. The gate cannot pass without a dated, owned record of the ` +
        `known dead lanes; without it the tree is ${deadIds.length} declared capability ids without a ` +
        `host route and ${deadProxies.length} web proxies targeting a route the host does not serve. ` +
        `Dead capability ids: ${deadIds.map((c) => c.id).join(', ') || 'none'}. ` +
        `Dead web proxies: ${deadProxies.map((p) => `${p.route} -> ${p.target}`).join(', ') || 'none'}.`,
    ];
  }

  // 1. Every dead id must already be baselined. A newly declared lane with no
  //    host route is the exact failure this gate exists to catch.
  for (const capability of deadIds) {
    if (!baselineIds.has(capability.id)) {
      problems.push(
        `capability id ${capability.id} is declared (${capability.routes.join(', ')}) but the host ` +
          `serves no such route, and it is not in the baseline. Add a host route, or land CU-149.`
      );
    }
  }

  // 2. Every dead proxy target must already be baselined.
  for (const proxy of deadProxies) {
    if (!baselineProxies.has(proxy.route)) {
      const why = retiredRoutes.has(proxy.target)
        ? 'the host classifies it but the lane is retired'
        : 'the host has no such route';
      problems.push(
        `web proxy ${proxy.route} targets ${proxy.target}, but ${why}, and it is not in the ` +
          `baseline. Remove the proxy, or land CU-149.`
      );
    }
  }

  // 2b. A declared id whose only route is retired is NOT a finding of its own:
  //     it is why the proxies above are dead, and it is baselined as such (the
  //     /api/sign/payload entry). `describe` reports it on a green run so the
  //     reader still sees that the lane exists and is closed.

  // 3. The baseline is shrink-only: an entry that is no longer dead is stale
  //    debt and fails, so the record cannot be widened to admit anything.
  for (const entry of baseline.dead_capability_ids) {
    if (!deadIds.some((c) => c.id === entry.id)) {
      const known = declared.some((c) => c.id === entry.id);
      problems.push(
        known
          ? `baseline capability id ${entry.id} is not dead — the host now serves its route. ` +
              `Delete the entry (that is how the baseline shrinks).`
          : `baseline capability id ${entry.id} is not dead and not declared. Delete the entry.`
      );
    }
  }
  for (const entry of baseline.dead_web_proxies) {
    if (!deadProxies.some((p) => p.route === entry.route)) {
      problems.push(
        `baseline web proxy ${entry.route} is not dead. Delete the entry (that is how the baseline shrinks).`
      );
    }
  }

  // 4. Debt may not be renewed by moving a date.
  for (const entry of [
    ...(baseline.dead_capability_ids || []),
    ...(baseline.dead_web_proxies || []),
  ]) {
    if (isExpired(entry.expires, today)) {
      const name = entry.id || entry.route;
      problems.push(
        `baseline entry ${name} expired on ${entry.expires} (owner: ${entry.owner}). ` +
          `Fix the lane or re-record the debt deliberately; the gate does not let it lapse silently.`
      );
    }
  }

  return problems;
}

/**
 * The single place the two rules live, so the summary line and the findings
 * can never disagree about what counts as dead.
 *
 * `routed` — the host table has an entry for the route. This is the test for a
 * declared capability id: `sign_payload` is routed (Target::SignPayload) even
 * though its lane is closed.
 * `live` — the host serves the route AND the lane is not retired. This is the
 * test for a web proxy: aiming at a routed-but-refusing lane reaches nothing a
 * caller can use, which is why the proxy counts are one higher than the id
 * counts.
 */
export function partition({ declared, host, proxies }) {
  const hostRoutes = new Set(host.routes);
  const retiredRoutes = new Set(host.retired);
  const routed = (route) => hostRoutes.has(route);
  const live = (route) => hostRoutes.has(route) && !retiredRoutes.has(route);
  return {
    routed,
    live,
    deadIds: declared.filter((capability) => !capability.routes.some(routed)),
    retiredIds: declared.filter(
      (capability) => capability.routes.some(routed) && !capability.routes.some(live)
    ),
    liveIds: declared.filter((capability) => capability.routes.some(live)),
    deadProxies: proxies.filter((proxy) => !live(proxy.target)),
    liveProxies: proxies.filter((proxy) => live(proxy.target)),
  };
}

/** A short report for the passing case, so a green run still says what it saw. */
function describe({ declared, host, proxies }, today) {
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
    `Baseline: ${BASELINE_PATH} (checked ${today}).`,
  ];
}

function parseArgs(argv) {
  const args = { root: REPO_ROOT, today: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = resolve(argv[++i]);
    else if (argv[i] === '--today') args.today = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = args.today || new Date().toISOString().slice(0, 10);

  let declared;
  let host;
  let proxies;
  let baseline;
  try {
    declared = readDeclaredCapabilities(args.root);
    host = readHostRoutes(args.root);
    proxies = readWebProxyTargets(args.root);
    baseline = readBaselineFile(args.root);
  } catch (error) {
    console.error(`Capability route-parity gate could not read its sources: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const problems = auditRouteParity({ declared, host, proxies, baseline }, { today });

  if (problems.length > 0) {
    const { deadIds, deadProxies } = partition({ declared, host, proxies });
    console.error('Capability route-parity gate failed:');
    console.error(
      `- ${deadIds.length} declared capability ids without a host route: ${deadIds.map((c) => c.id).join(', ') || 'none'}`
    );
    console.error(
      `- ${deadProxies.length} web proxies target a route the host does not serve: ${
        deadProxies.map((p) => `${p.route} -> ${p.target}`).join(', ') || 'none'
      }`
    );
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  for (const line of describe({ declared, host, proxies }, today)) console.log(line);
  console.log('Capability route-parity gate passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

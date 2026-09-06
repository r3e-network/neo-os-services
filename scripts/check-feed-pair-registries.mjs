#!/usr/bin/env node
/**
 * Feed pair registry agreement check.
 *
 * The feed pair set is projected into several places that had drifted apart.
 * The Rust delivery path is authoritative; the Node registries remain checked
 * compatibility mirrors while migration consumers still import them:
 *
 *   1. `workers/nitro-enclave-host/src/feed_sign.rs` — authoritative `/feed/sign`
 *      TwelveData mapping used by the Rust N3 and NeoX writers
 *   2. `crates/neo-os-compute/src/oracle/feed_registry.rs` — Rust compute defaults,
 *      provider transforms, and retirement registry
 *   3. `apps/web/lib/feed-defaults.ts` — advertised set (`/api/feeds/status`)
 *   4. `deploy/nitro/morpheus.env.example` — runtime `MORPHEUS_FEED_SYMBOLS`
 *   5. `deploy/feed-pusher/feed-pusher.mjs` and
 *      `workers/nitro-worker/src/oracle/feed-registry.js` — Node compatibility mirrors
 *
 * When they disagree the health signal stops meaning anything, and that is not a
 * theoretical worry — it is what happened:
 *
 *   - BRENT/NATGAS/WHEAT/SOY were advertised but absent from the pusher, so they
 *     could never be fresh; they sat 75 days stale and `/api/feeds/status` read
 *     "degraded" permanently.
 *   - CORN-USD was pushed with the wrong provider symbol (bare `CORN`, the Teucrium
 *     Corn Fund ETF at ~$18.9, against an on-chain CBOT futures series at ~479
 *     cents/bushel), so every cycle was correctly rejected by the deviation guard.
 *   - FLM-USD was pushed but advertised nowhere.
 *
 * A permanently-degraded signal is a signal nobody reads, and that is how a 22-day
 * outage looked healthy. This check fails the build while any of that is true.
 *
 * Usage:
 *   node scripts/check-feed-pair-registries.mjs            # static registries only
 *   node scripts/check-feed-pair-registries.mjs --onchain  # also read MorpheusDataFeed
 *   node scripts/check-feed-pair-registries.mjs --json     # machine-readable report
 *
 * `--onchain` is additive: it reads the mainnet MorpheusDataFeed over public RPC and
 * additionally fails when an advertised pair is missing or stale on chain, or when an
 * on-chain pair is neither advertised nor explicitly retired. It never writes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WEB_DEFAULTS = 'apps/web/lib/feed-defaults.ts';
const PUSHER = 'deploy/feed-pusher/feed-pusher.mjs';
const WORKER_REGISTRY = 'workers/nitro-worker/src/oracle/feed-registry.js';
const RUST_FEED_REGISTRY = 'crates/neo-os-compute/src/oracle/feed_registry.rs';
const RUST_FEED_SIGN = 'workers/nitro-enclave-host/src/feed_sign.rs';
const RUNTIME_ENV_EXAMPLE = 'deploy/nitro/morpheus.env.example';
const PUSHER_ENV_EXAMPLE = 'deploy/feed-pusher/feed-pusher.env.example';
const MONITOR = 'deploy/feed-pusher/feed-monitor.mjs';

const DEFAULT_RPCS = [
  'https://mainnet1.neo.coz.io:443',
  'https://rpc10.n3.nspcc.ru:10331',
  'https://api.n3index.dev/mainnet',
];
const DATAFEED_HASH = '0x03013f49c42a14546c8bbe58f9d434c3517fccab';
// Matches feedStaleAfterSeconds() in apps/web/lib/feed-freshness.ts
// (MORPHEUS_FEED_MAX_STALE_SEC 1800 + FEED_STALE_MARGIN_SECONDS 900).
const STALE_AFTER_SECONDS = 2700;
// Matches DEFAULT_TRADFI_WEEKEND_AGE_SECONDS; applied only to TradFi pairs while a
// weekend close is in effect, exactly as the serving path does.
const TRADFI_WEEKEND_AGE_SECONDS = 270_000;

function parseArgs(argv = process.argv.slice(2)) {
  return {
    onchain: argv.includes('--onchain'),
    json: argv.includes('--json'),
  };
}

/** Fail loudly rather than silently passing when a source file stops parsing. */
function required(value, what, file) {
  if (value === null || value === undefined) {
    throw new Error(
      `could not read ${what} from ${file} — the check cannot verify agreement, so it fails rather than passing blind`
    );
  }
  return value;
}

function parseStringArray(source, constName, file) {
  const match = source.match(new RegExp(`${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  const body = required(match && match[1], `${constName}`, file);
  const values = [...body.matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  if (!values.length) throw new Error(`${constName} in ${file} parsed as empty`);
  return values;
}

/** Pull `pair -> sourceSymbol` out of the TS descriptor table without a TS toolchain. */
function parseDescriptorSourceSymbols(source, file) {
  const match = source.match(
    /const BARE_FEED_DESCRIPTORS: Record<string, FeedDescriptor> = \{([\s\S]*?)\n\};/
  );
  const body = required(match && match[1], 'BARE_FEED_DESCRIPTORS', file);
  const out = new Map();
  for (const entry of body.matchAll(/'([A-Z0-9]+-USD)':\s*\{([\s\S]*?)\n  \},/g)) {
    const symbol = entry[2].match(/sourceSymbol:\s*'([^']+)'/);
    out.set(entry[1], required(symbol && symbol[1], `sourceSymbol for ${entry[1]}`, file));
  }
  if (!out.size) throw new Error(`BARE_FEED_DESCRIPTORS in ${file} parsed as empty`);
  return out;
}

/**
 * Returns null when the retired-pair block is absent entirely, so the caller can
 * report that as a substantive failure alongside everything else it found rather
 * than aborting the whole report on the first missing section.
 */
function parseWebRetiredPairs(source) {
  const match = source.match(
    /export const RETIRED_FEED_PAIRS: Record<string, RetiredFeedPair> = \{([\s\S]*?)\n\};/
  );
  if (!match) return null;
  return new Set([...match[1].matchAll(/^ {2}'([A-Z0-9]+-USD)':\s*\{/gm)].map((entry) => entry[1]));
}

/**
 * Return the body between one balanced pair of braces. Strings and Rust/JS
 * comments are skipped so provider maps can be parsed without executing source.
 */
function balancedBraceBody(source, openingIndex, what, file) {
  if (source[openingIndex] !== '{') {
    throw new Error(`could not locate opening brace for ${what} in ${file}`);
  }
  let depth = 0;
  let state = 'code';
  for (let index = openingIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'string') {
      if (current === '\\') {
        index += 1;
      } else if (current === '"') {
        state = 'code';
      }
      continue;
    }
    if (current === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
    } else if (current === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else if (current === '"') {
      state = 'string';
    } else if (current === '{') {
      depth += 1;
    } else if (current === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingIndex + 1, index);
    }
  }
  throw new Error(`could not locate closing brace for ${what} in ${file}`);
}

function rustFunctionBody(source, functionName, file) {
  const signature = new RegExp(`(?:pub\\s+)?fn\\s+${functionName}\\s*\\(`).exec(source);
  const start = required(signature && signature.index, `${functionName} function`, file);
  const openingIndex = source.indexOf('{', start);
  return balancedBraceBody(source, openingIndex, `${functionName} function`, file);
}

function rustJsonMacroBody(functionBody, functionName, file) {
  const macroIndex = functionBody.indexOf('json!');
  required(macroIndex >= 0 ? macroIndex : null, `json! body in ${functionName}`, file);
  const openingIndex = functionBody.indexOf('{', macroIndex);
  return balancedBraceBody(functionBody, openingIndex, `json! body in ${functionName}`, file);
}

/** Parse Rust `default_feed_pairs()` without compiling or evaluating repository code. */
export function parseRustFeedRegistry(source, file = RUST_FEED_REGISTRY) {
  const body = rustJsonMacroBody(
    rustFunctionBody(source, 'default_feed_pairs', file),
    'default_feed_pairs',
    file
  );
  const starts = [...body.matchAll(/^\s*"([A-Z0-9]+-USD)"\s*:\s*\{/gm)];
  if (!starts.length) throw new Error(`default_feed_pairs in ${file} parsed as empty`);
  const pairs = new Map();
  for (let index = 0; index < starts.length; index += 1) {
    const pair = starts[index][1];
    const segment = body.slice(starts[index].index, starts[index + 1]?.index ?? body.length);
    const symbol = segment.match(/"twelvedata"\s*:\s*\{\s*"symbol"\s*:\s*"([^"]+)"/);
    if (pairs.has(pair)) throw new Error(`${pair} is duplicated in ${file}`);
    pairs.set(pair, {
      symbol: required(symbol && symbol[1], `TwelveData symbol for ${pair}`, file),
      priceTransform: segment.match(/"price_transform"\s*:\s*"([^"]+)"/)?.[1] || null,
    });
  }
  return pairs;
}

export function parseRustRetiredPairs(source, file = RUST_FEED_REGISTRY) {
  const body = rustJsonMacroBody(
    rustFunctionBody(source, 'retired_feed_pairs', file),
    'retired_feed_pairs',
    file
  );
  const pairs = new Set([...body.matchAll(/^\s*"([A-Z0-9]+-USD)"\s*:/gm)].map((entry) => entry[1]));
  if (!pairs.size) throw new Error(`retired_feed_pairs in ${file} parsed as empty`);
  return pairs;
}

/** Parse the fixed map used by the Rust host's N3 and NeoX `/feed/sign` path. */
export function parseRustFeedSignMapping(source, file = RUST_FEED_SIGN) {
  required(
    /impl\s+PriceSource\s+for\s+TwelveDataPrices[\s\S]*?to_twelve_data_symbol\(symbol\)/.test(
      source
    )
      ? true
      : null,
    'TwelveDataPrices use of to_twelve_data_symbol',
    file
  );
  const body = rustFunctionBody(source, 'to_twelve_data_symbol', file);
  required(/_\s*=>\s*None/.test(body) ? true : null, 'fail-closed unmapped-symbol arm', file);
  const pairs = new Map();
  for (const entry of body.matchAll(/^\s*"([A-Z0-9]+-USD)"\s*=>\s*Some\("([^"]+)"\),?\s*$/gm)) {
    if (pairs.has(entry[1])) throw new Error(`${entry[1]} is duplicated in ${file}`);
    pairs.set(entry[1], entry[2]);
  }
  if (!pairs.size) throw new Error(`to_twelve_data_symbol in ${file} parsed as empty`);
  return pairs;
}

function parseEnvSymbols(source, key, file) {
  const match =
    source.match(new RegExp(`"${key}":"([^"]*)"`)) ||
    source.match(new RegExp(`^${key}=(.*)$`, 'm'));
  const raw = required(match && match[1], key, file);
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/^TWELVEDATA:/, ''))
    .filter(Boolean);
}

function sorted(values) {
  return [...values].sort();
}

function diff(left, right) {
  const rightSet = new Set(right);
  return sorted([...new Set(left)].filter((entry) => !rightSet.has(entry)));
}

export function sameTwelveDataInstrument(authoritativeSymbol, registryConfig) {
  if (!registryConfig) return false;
  if (!registryConfig.priceTransform) return registryConfig.symbol === authoritativeSymbol;
  if (registryConfig.priceTransform !== 'inverse') return false;
  const parts = registryConfig.symbol.split('/');
  return parts.length === 2 && `${parts[1]}/${parts[0]}` === authoritativeSymbol;
}

async function neoRpc(method, params) {
  let lastError;
  for (const url of DEFAULT_RPCS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const parsed = await response.json();
      if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 160));
      return parsed.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readOnchainRecords() {
  const result = await neoRpc('invokefunction', [DATAFEED_HASH, 'getAllFeedRecords', []]);
  if (!result || result.state !== 'HALT') throw new Error('getAllFeedRecords did not HALT');
  const now = Math.floor(Date.now() / 1000);
  const records = new Map();
  for (const record of result.stack?.[0]?.value || []) {
    const fields = record?.value;
    if (!Array.isArray(fields) || fields.length < 4) continue;
    const pair = Buffer.from(String(fields[0].value || ''), 'base64').toString('utf8');
    if (!pair) continue;
    const timestamp = Number(fields[3].value || 0);
    records.set(pair.replace(/^TWELVEDATA:/, ''), {
      pair,
      price: Number(fields[2].value || 0) / 1e6,
      timestamp,
      age_seconds: now - timestamp,
    });
  }
  return records;
}

function isTradFiMarketClosed(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

async function main() {
  const args = parseArgs();
  const read = (relative) => fs.readFile(path.join(REPO_ROOT, relative), 'utf8');

  const webSource = await read(WEB_DEFAULTS);
  const advertised = parseStringArray(webSource, 'DEFAULT_FEED_BASE_SYMBOLS', WEB_DEFAULTS);
  const descriptorSymbols = parseDescriptorSourceSymbols(webSource, WEB_DEFAULTS);
  const webRetired = parseWebRetiredPairs(webSource);

  // The Node pusher remains an executable compatibility source;
  // FEED_PUSHER_SKIP_MAIN stops the import from running a push cycle. Nothing here
  // transacts, and importing it does not make it the production authority.
  process.env.FEED_PUSHER_SKIP_MAIN = '1';
  const pusher = await import(pathToFileURL(path.join(REPO_ROOT, PUSHER)).href);
  const pushed = [...required(pusher.TD_SYMBOLS, 'TD_SYMBOLS', PUSHER).keys()];
  const pusherRetired = pusher.RETIRED_FEED_PAIRS
    ? new Set(pusher.RETIRED_FEED_PAIRS.keys())
    : null;

  const worker = await import(pathToFileURL(path.join(REPO_ROOT, WORKER_REGISTRY)).href);
  const workerPairs = Object.keys(
    required(worker.DEFAULT_FEED_PAIRS, 'DEFAULT_FEED_PAIRS', WORKER_REGISTRY)
  );
  const workerRetired = worker.RETIRED_FEED_PAIRS
    ? new Set(Object.keys(worker.RETIRED_FEED_PAIRS))
    : null;

  const rustRegistrySource = await read(RUST_FEED_REGISTRY);
  const rustRegistry = parseRustFeedRegistry(rustRegistrySource);
  const rustRegistryPairs = [...rustRegistry.keys()];
  const rustRetired = parseRustRetiredPairs(rustRegistrySource);
  const rustFeedSignMapping = parseRustFeedSignMapping(await read(RUST_FEED_SIGN));
  const rustFeedSignPairs = [...rustFeedSignMapping.keys()];

  const runtimePairs = parseEnvSymbols(
    await read(RUNTIME_ENV_EXAMPLE),
    'MORPHEUS_FEED_SYMBOLS',
    RUNTIME_ENV_EXAMPLE
  );
  const pusherEnvPairs = parseEnvSymbols(
    await read(PUSHER_ENV_EXAMPLE),
    'SYMBOLS',
    PUSHER_ENV_EXAMPLE
  );

  const failures = [];
  const fail = (message) => failures.push(message);

  // ── 1. every projection must name the authoritative Rust writer set ───────
  // Node entries are migration compatibility mirrors, never the authority used
  // to bless a change to the Rust delivery path.
  const sets = [
    [`${RUST_FEED_REGISTRY} default_feed_pairs`, rustRegistryPairs],
    [`${WEB_DEFAULTS} advertised pairs`, advertised],
    ['runtime MORPHEUS_FEED_SYMBOLS', runtimePairs],
    [`Node compatibility ${PUSHER} TD_SYMBOLS`, pushed],
    [`Node compatibility ${WORKER_REGISTRY} DEFAULT_FEED_PAIRS`, workerPairs],
    ['Node compatibility pusher env SYMBOLS', pusherEnvPairs],
  ];
  for (const [label, values] of sets) {
    for (const pair of diff(rustFeedSignPairs, values)) {
      fail(`${pair} is supported by authoritative ${RUST_FEED_SIGN} but missing from ${label}`);
    }
    for (const pair of diff(values, rustFeedSignPairs)) {
      fail(
        `${pair} is in ${label} but absent from authoritative ${RUST_FEED_SIGN} — add it to the Rust writer or retire it`
      );
    }
  }

  // ── 2. provider symbols must agree pair by pair ───────────────────────────
  // The Rust host is the live N3/NeoX writer. Web metadata and the old Node pusher
  // must mirror that fixed map exactly. This catches the CORN-USD class of fault
  // (`CORN` the ETF vs `C_1` the futures contract).
  for (const pair of rustFeedSignPairs) {
    const authoritativeSymbol = rustFeedSignMapping.get(pair);
    const descriptor = descriptorSymbols.get(pair);
    if (!descriptor) {
      fail(`${pair} is authoritative but has no FEED_DESCRIPTORS entry in ${WEB_DEFAULTS}`);
    } else if (descriptor !== authoritativeSymbol) {
      fail(
        `${pair} provider symbol disagrees: authoritative ${RUST_FEED_SIGN} fetches '${authoritativeSymbol}' but ${WEB_DEFAULTS} advertises '${descriptor}'`
      );
    }
    const pusherSymbol = pusher.TD_SYMBOLS.get(pair);
    if (!pusherSymbol) {
      fail(`${pair} has no TwelveData symbol in Node compatibility ${PUSHER}`);
    } else if (pusherSymbol !== authoritativeSymbol) {
      fail(
        `${pair} provider symbol disagrees: authoritative ${RUST_FEED_SIGN} fetches '${authoritativeSymbol}' but Node compatibility ${PUSHER} fetches '${pusherSymbol}'`
      );
    }
  }

  // The compute registry may legitimately use a different provider symbol only
  // when an explicit transform makes it the same instrument (USD/JPY inverted vs
  // JPY/USD direct). The Node worker is a compatibility mirror of that Rust model,
  // including the transform, and therefore must match it exactly.
  for (const pair of rustFeedSignPairs) {
    const authoritativeSymbol = rustFeedSignMapping.get(pair);
    const rustConfig = rustRegistry.get(pair);
    if (!sameTwelveDataInstrument(authoritativeSymbol, rustConfig)) {
      fail(
        `${pair} provider semantics disagree: authoritative ${RUST_FEED_SIGN} uses '${authoritativeSymbol}', while ${RUST_FEED_REGISTRY} uses '${rustConfig?.symbol || ''}' with price_transform '${rustConfig?.priceTransform || ''}'`
      );
    }
    const config = worker.DEFAULT_FEED_PAIRS[pair];
    const workerSymbol = config?.providers?.twelvedata?.symbol;
    if (!workerSymbol) {
      fail(`${pair} has no TwelveData symbol in Node compatibility ${WORKER_REGISTRY}`);
    } else if (rustConfig && workerSymbol !== rustConfig.symbol) {
      fail(
        `${pair} provider symbol disagrees: ${RUST_FEED_REGISTRY} uses '${rustConfig.symbol}' but Node compatibility ${WORKER_REGISTRY} uses '${workerSymbol}'`
      );
    }
    const workerTransform = config?.price_transform || null;
    if (rustConfig && workerTransform !== rustConfig.priceTransform) {
      fail(
        `${pair} price_transform disagrees: ${RUST_FEED_REGISTRY} uses '${rustConfig.priceTransform || ''}' but Node compatibility ${WORKER_REGISTRY} uses '${workerTransform || ''}'`
      );
    }
  }

  // ── 3. retirement must be consistent and must actually retire ─────────────
  // The box monitor keeps its own retired-pair default (it runs standalone on the
  // instance and cannot import the web or worker registries). Parse it so it cannot
  // drift: a pair retired everywhere else but not here makes the monitor
  // permanently red, and a pair retired only here silences a real outage.
  const monitorSource = await read(MONITOR);
  const monitorMatch = monitorSource.match(/process\.env\.RETIRED_PAIRS \|\|\s*'([^']*)'/);
  const monitorRetired = monitorMatch
    ? new Set(
        monitorMatch[1]
          .split(',')
          .map((entry) => entry.trim().toUpperCase())
          .filter(Boolean)
      )
    : null;

  const retiredLists = [
    [`${RUST_FEED_REGISTRY} retired_feed_pairs`, rustRetired],
    [`${WEB_DEFAULTS} RETIRED_FEED_PAIRS`, webRetired],
    [`Node compatibility ${PUSHER} RETIRED_FEED_PAIRS`, pusherRetired],
    [`Node compatibility ${WORKER_REGISTRY} RETIRED_FEED_PAIRS`, workerRetired],
    [`${MONITOR} RETIRED_PAIRS`, monitorRetired],
  ];
  // A registry with no retired-pair list at all cannot record WHY a pair is gone,
  // which is how "temporarily broken" quietly becomes "permanently stale".
  for (const [label, values] of retiredLists) {
    if (!values) fail(`${label} is missing — every registry must record its retired pairs and why`);
  }
  const retiredUnion = new Set(retiredLists.flatMap(([, values]) => (values ? [...values] : [])));
  for (const [label, values] of retiredLists) {
    if (!values) continue;
    for (const pair of diff([...retiredUnion], [...values])) {
      fail(`${pair} is retired elsewhere but missing from ${label}`);
    }
  }
  for (const pair of retiredUnion) {
    for (const [label, values] of [
      [`authoritative ${RUST_FEED_SIGN}`, rustFeedSignPairs],
      ...sets,
    ]) {
      if (values.includes(pair)) {
        fail(
          `${pair} is retired but still present in ${label} — retirement must remove it everywhere`
        );
      }
    }
    if (descriptorSymbols.has(pair)) {
      fail(`${pair} is retired but still has a FEED_DESCRIPTORS entry in ${WEB_DEFAULTS}`);
    }
  }

  // ── 4. on-chain reconciliation (opt-in, read-only) ────────────────────────
  const onchainReport = { checked: false, pairs: 0 };
  if (args.onchain) {
    const records = await readOnchainRecords();
    onchainReport.checked = true;
    onchainReport.pairs = records.size;
    const tradfi = new Set(
      (
        process.env.MORPHEUS_FEED_TRADFI_PAIRS ||
        'EUR-USD,GBP-USD,JPY-USD,CNY-USD,WTI-USD,BRENT-USD,NATGAS-USD,WHEAT-USD,CORN-USD,SOY-USD'
      )
        .split(',')
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean)
    );
    const marketClosed = isTradFiMarketClosed(new Date());
    for (const pair of advertised) {
      const record = records.get(pair);
      if (!record) {
        fail(`${pair} is advertised but has no on-chain record`);
        continue;
      }
      const budget =
        tradfi.has(pair) && marketClosed
          ? Math.max(STALE_AFTER_SECONDS, TRADFI_WEEKEND_AGE_SECONDS)
          : STALE_AFTER_SECONDS;
      if (record.age_seconds > budget) {
        fail(
          `${pair} is advertised but stale on chain: age=${record.age_seconds}s limit=${budget}s (price ${record.price})`
        );
      }
    }
    for (const [pair] of records) {
      if (advertised.includes(pair) || retiredUnion.has(pair)) continue;
      fail(
        `${pair} exists on chain but is neither advertised nor listed as retired — record it in RETIRED_FEED_PAIRS or advertise it`
      );
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    read_only: true,
    status: failures.length ? 'fail' : 'pass',
    rust_feed_sign_pair_count: rustFeedSignPairs.length,
    rust_registry_pair_count: rustRegistryPairs.length,
    advertised_pair_count: advertised.length,
    node_pusher_compat_pair_count: pushed.length,
    node_worker_compat_pair_count: workerPairs.length,
    pushed_pair_count: pushed.length,
    worker_pair_count: workerPairs.length,
    runtime_pair_count: runtimePairs.length,
    retired_pairs: sorted(retiredUnion),
    onchain: onchainReport,
    failures,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (failures.length) {
    console.error(`[feed-pair-registries] FAIL — ${failures.length} disagreement(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      `\nrust_feed_sign=${rustFeedSignPairs.length} rust_registry=${rustRegistryPairs.length} advertised=${advertised.length} runtime=${runtimePairs.length} node_pusher_compat=${pushed.length} node_worker_compat=${workerPairs.length} retired=${retiredUnion.size}`
    );
  } else {
    console.log(
      `[feed-pair-registries] PASS — ${rustFeedSignPairs.length} pairs agree across authoritative Rust /feed/sign, the Rust compute registry, advertised/runtime projections, and Node compatibility mirrors` +
        (onchainReport.checked ? `, and against ${onchainReport.pairs} on-chain records` : '') +
        `; ${retiredUnion.size} retired.`
    );
  }
  if (failures.length) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(
      `[feed-pair-registries] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}

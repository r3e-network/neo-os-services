// Read-only introspection + validation over the relayer config schema.
//
// This module does NOT change how createRelayerConfig() resolves env vars. It
// re-implements ONLY the *observation* of env() precedence (process.env first
// across all aliases, then the packed MORPHEUS_RUNTIME_CONFIG_JSON object) so an
// operator can see which alias actually won, whether a setting is set or relying
// on its default, and whether any MORPHEUS_*/NITRO_* variable looks like
// a typo of a known alias. The resolution it mirrors lives in config.js#env().

import { createRelayerConfig } from './config.js';
import {
  CONFIG_SCHEMA,
  DIRECT_CONTROL_ENV_KEYS,
  isSecretEnvName,
  knownEnvAliases,
} from './config-schema.js';

const REDACTED = '«redacted»';

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Mirror of config.js getRuntimeConfig() — parse the packed JSON env fallback.
function parseRuntimeConfig(env) {
  const raw = trim(env.MORPHEUS_RUNTIME_CONFIG_JSON || '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Mirror of config.js env(...): first non-empty process.env across ALL aliases,
// then the first non-empty packed runtime-config entry. Returns the winning
// alias name + source so callers can show explicit precedence.
function resolveAlias(aliases, env, runtimeConfig) {
  for (const name of aliases) {
    const direct = trim(env[name]);
    if (direct) return { value: direct, alias: name, source: 'env' };
  }
  for (const name of aliases) {
    const packed = runtimeConfig[name];
    if (packed !== undefined && packed !== null && `${packed}`.trim()) {
      return { value: `${packed}`.trim(), alias: name, source: 'runtime_config_json' };
    }
  }
  return { value: '', alias: null, source: 'default' };
}

function isSecretSetting(setting) {
  if (setting.secret === true) return true;
  return setting.aliases.some((alias) => isSecretEnvName(alias));
}

// Levenshtein distance (small inputs; bounded by env-name length) for the
// typo-suggestion heuristic.
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function closestAlias(name, knownList) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of knownList) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Only treat as a likely typo when within a small edit distance and the
  // distance is small relative to the name length (avoids matching unrelated
  // long names that merely share a prefix).
  if (best && bestDistance <= 3 && bestDistance <= Math.ceil(name.length / 3)) {
    return { suggestion: best, distance: bestDistance };
  }
  return null;
}

// Resolve every schema setting against an env-like object, returning a
// redaction-safe per-setting report.
export function resolveConfigReport(env = process.env) {
  const runtimeConfig = parseRuntimeConfig(env);
  const settings = CONFIG_SCHEMA.map((setting) => {
    const resolved = resolveAlias(setting.aliases, env, runtimeConfig);
    const secret = isSecretSetting(setting);
    const set = resolved.source !== 'default';
    return {
      key: setting.key,
      required: Boolean(setting.required),
      secret,
      set,
      source: resolved.source,
      winningAlias: resolved.alias,
      aliases: setting.aliases,
      default: setting.default,
      description: setting.description,
      // Never expose secret values. For non-secrets, show the resolved value so
      // an operator can eyeball it; for secrets, show only set/unset.
      value: set ? (secret ? REDACTED : resolved.value) : null,
    };
  });
  return { settings };
}

// Detect MORPHEUS_*/NITRO_* variables present in the environment that do
// not match any known alias (likely typos / stale vars that are silently
// ignored by config.js).
export function detectUnknownEnvVars(env = process.env) {
  const known = knownEnvAliases();
  const knownList = [...known];
  const prefixes = ['MORPHEUS_', 'NITRO_'];
  const unknown = [];
  for (const name of Object.keys(env)) {
    if (DIRECT_CONTROL_ENV_KEYS.includes(name)) continue;
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (known.has(name)) continue;
    if (!trim(env[name])) continue; // ignore empty/unset
    const closest = closestAlias(name, knownList);
    unknown.push({
      name,
      secret: isSecretEnvName(name),
      suggestion: closest?.suggestion ?? null,
      distance: closest?.distance ?? null,
    });
  }
  return unknown.sort((a, b) => a.name.localeCompare(b.name));
}

// Layer conditional required-ness on top of the built config object. The static
// schema marks signer/contract/rpc settings required:false because their
// necessity depends on mode + active chains; this resolves those conditions
// against the actual built config so validate can report real missing-required
// errors without changing runtime behavior.
function dynamicRequirements(config) {
  const requirements = [];
  const neoActive = Array.isArray(config.activeChains)
    ? config.activeChains.includes('neo_n3')
    : false;
  const neoxActive = Array.isArray(config.activeChains)
    ? config.activeChains.includes('neox')
    : false;
  const requestsLane = config.mode !== 'feed_only';

  if (neoActive && requestsLane) {
    requirements.push({
      key: 'neo_n3.oracleContract',
      present: Boolean(trim(config.neo_n3?.oracleContract)),
      reason: 'neo_n3 is active and mode is not feed_only',
    });
    if (!config.useDerivedKeys) {
      const hasSigner = Boolean(
        trim(config.neo_n3?.updaterWif) || trim(config.neo_n3?.updaterPrivateKey)
      );
      requirements.push({
        key: 'neo_n3.updaterSigner',
        present: hasSigner,
        reason: 'neo_n3 is active, mode is not feed_only, and derived keys are off',
      });
    }
  }

  if (neoxActive && requestsLane) {
    requirements.push({
      key: 'neox.oracleContract',
      present: Boolean(trim(config.neox?.oracleContract)),
      reason: 'neox is active and mode is not feed_only',
    });
    requirements.push({
      key: 'neox.updaterPrivateKey',
      present: Boolean(trim(config.neox?.updaterPrivateKey)),
      reason: 'neox is active and mode is not feed_only',
    });
  }

  return requirements;
}

// Build a full validation result: static required settings + conditional
// (config-derived) requirements + unknown/typo warnings. Pure over the supplied
// env + config so it is unit-testable.
export function validateRelayerConfig({ env = process.env, config } = {}) {
  const report = resolveConfigReport(env);
  const reportByKey = new Map(report.settings.map((entry) => [entry.key, entry]));

  const errors = [];

  // Building the config can itself throw — e.g. when the pinned Neo N3 updater
  // signer material is required but missing/malformed (strict role resolution).
  // Surface that as a validation error against the responsible setting instead
  // of letting the exception escape, so the operator gets an actionable report.
  let builtConfig = config;
  if (!builtConfig) {
    try {
      builtConfig = createRelayerConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        key: 'neo_n3.updaterSigner',
        message: `config could not be built: ${message}`,
      });
      // Without a built config we can only report the static + build errors and
      // the unknown-var warnings; conditional requirements need the config.
      const unknownVars = detectUnknownEnvVars(env);
      return {
        ok: false,
        network: null,
        mode: null,
        activeChains: null,
        errors: errors.concat(
          report.settings
            .filter((setting) => setting.required && !setting.set)
            .map((setting) => ({
              key: setting.key,
              message: `required setting "${setting.key}" is not set (aliases: ${setting.aliases.join(
                ', '
              )})`,
            }))
        ),
        warnings: unknownVars.map((item) => ({
          name: item.name,
          message: item.suggestion
            ? `unknown env var "${item.name}" does not match any known alias — did you mean "${item.suggestion}"? (it is currently ignored)`
            : `unknown env var "${item.name}" does not match any known alias — it is currently ignored`,
        })),
        unknownEnvVars: unknownVars,
      };
    }
  }

  // Static required settings (those declared required:true in the schema).
  for (const setting of report.settings) {
    if (setting.required && !setting.set) {
      errors.push({
        key: setting.key,
        message: `required setting "${setting.key}" is not set (aliases: ${setting.aliases.join(
          ', '
        )})`,
      });
    }
  }

  // Conditional requirements derived from the built config.
  for (const requirement of dynamicRequirements(builtConfig)) {
    if (!requirement.present) {
      const entry = reportByKey.get(requirement.key);
      const aliasHint = entry ? ` (aliases: ${entry.aliases.join(', ')})` : '';
      errors.push({
        key: requirement.key,
        message: `required setting "${requirement.key}" is not set — ${requirement.reason}${aliasHint}`,
      });
    }
  }

  const unknownEnvVars = detectUnknownEnvVars(env);
  const warnings = unknownEnvVars.map((item) => ({
    name: item.name,
    message: item.suggestion
      ? `unknown env var "${item.name}" does not match any known alias — did you mean "${item.suggestion}"? (it is currently ignored)`
      : `unknown env var "${item.name}" does not match any known alias — it is currently ignored`,
  }));

  return {
    ok: errors.length === 0,
    network: builtConfig.network,
    mode: builtConfig.mode,
    activeChains: builtConfig.activeChains,
    errors,
    warnings,
    unknownEnvVars,
  };
}

// Render a human-readable dump (used by the `config:dump` CLI subcommand).
// Secrets are shown only as set/unset. The winning alias + source make the
// precedence explicit.
export function formatConfigDump(env = process.env) {
  const report = resolveConfigReport(env);
  const lines = [];
  lines.push('# Morpheus relayer — resolved configuration');
  lines.push('# (secrets redacted; "source" shows which alias won)');
  lines.push('');
  const keyWidth = Math.max(...report.settings.map((entry) => entry.key.length));
  for (const setting of report.settings) {
    const paddedKey = setting.key.padEnd(keyWidth);
    let display;
    if (!setting.set) {
      display = `(default: ${setting.default})`;
    } else if (setting.secret) {
      display = `${REDACTED} [set]`;
    } else {
      display = setting.value;
    }
    const via =
      setting.source === 'default' ? 'default' : `${setting.winningAlias} via ${setting.source}`;
    const flag = setting.required ? ' [required]' : '';
    lines.push(`${paddedKey}  = ${display}    (${via})${flag}`);
  }
  return lines.join('\n');
}

export const __testing = { editDistance, closestAlias, resolveAlias, parseRuntimeConfig };

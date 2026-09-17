// One-shot generator: emit the Rust static CONFIG_SCHEMA table from the JS
// oracle so the manifest is transcribed without hand-copy errors.
// Run: node scripts/gen-config-schema-rust.mjs > /tmp/config_schema_table.rs
import {
  CONFIG_SCHEMA,
  DIRECT_CONTROL_ENV_KEYS,
} from '../workers/morpheus-relayer/src/config-schema.js';

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// Rust's durable delivery and automation controls have no JS runtime equivalent.
const RUST_DIRECT_CONTROL_ENV_KEYS = [
  'MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION',
  'MORPHEUS_DELIVERY_PROTOCOL',
  'MORPHEUS_N3_RECONCILIATION_ARCHIVE_RPC_URLS',
  'MORPHEUS_ALLOW_LEGACY_LOCAL',
];

const out = [];
out.push(`/// Direct-control env keys consumed outside env() alias chains`);
out.push(`/// (JS direct controls plus Rust-only controls owned by this generator).`);
out.push(`pub static DIRECT_CONTROL_ENV_KEYS: &[&str] = &[`);
for (const k of new Set([...DIRECT_CONTROL_ENV_KEYS, ...RUST_DIRECT_CONTROL_ENV_KEYS])) {
  out.push(`    "${esc(k)}",`);
}
out.push(`];`);
out.push(``);
out.push(`/// Declarative manifest of every env var createRelayerConfig() reads`);
out.push(`/// (port of config-schema.js CONFIG_SCHEMA — generated, do not hand-edit).`);
out.push(`pub static CONFIG_SCHEMA: &[ConfigSetting] = &[`);
for (const s of CONFIG_SCHEMA) {
  out.push(`    ConfigSetting {`);
  out.push(`        key: "${esc(s.key)}",`);
  out.push(`        aliases: &[${s.aliases.map((a) => `"${esc(a)}"`).join(', ')}],`);
  out.push(`        default: "${esc(s.default)}",`);
  out.push(`        required: ${s.required ? 'true' : 'false'},`);
  out.push(`        secret: ${s.secret ? 'true' : 'false'},`);
  out.push(`        description: "${esc(s.description)}",`);
  out.push(`    },`);
}
out.push(`];`);
process.stdout.write(out.join('\n') + '\n');

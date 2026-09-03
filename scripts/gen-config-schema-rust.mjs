// One-shot generator: emit the Rust static CONFIG_SCHEMA table from the JS
// oracle so the 109-entry manifest is transcribed without hand-copy errors.
// Run: node scripts/gen-config-schema-rust.mjs > /tmp/config_schema_table.rs
import { CONFIG_SCHEMA, DIRECT_CONTROL_ENV_KEYS } from '../workers/morpheus-relayer/src/config-schema.js';

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const out = [];
out.push(`/// Direct-control env keys consumed outside env() alias chains`);
out.push(`/// (port of config-schema.js DIRECT_CONTROL_ENV_KEYS).`);
out.push(`pub static DIRECT_CONTROL_ENV_KEYS: &[&str] = &[`);
for (const k of DIRECT_CONTROL_ENV_KEYS) out.push(`    "${esc(k)}",`);
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

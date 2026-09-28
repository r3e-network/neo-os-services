// FUZZ_SEED handling shared by fuzz-security.mjs and fuzz-os-infra.mjs, and
// mirrored by fuzz-testing/run-daily-fuzz.sh: every input a harness generates
// comes from a PRNG seeded with this value, so a run replays exactly from the
// seed it prints.

// Fixed so scheduled runs are comparable.
export const DEFAULT_FUZZ_SEED = 20260928;

// Returns FUZZ_SEED as an integer from 1 to 4294967295 (zero is excluded
// because it is a fixed point of xorshift32), or the default when it is unset.
// Anything else ends the process with status 2: falling back to the default
// would silently run a different seed from the one that was asked for.
export function readFuzzSeed(env = process.env) {
  const raw = env.FUZZ_SEED;
  if (raw === undefined || raw === '') return DEFAULT_FUZZ_SEED;
  const value = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (value >= 1 && value <= 0xffffffff) return value;
  console.error(
    `FUZZ_SEED must be a decimal integer from 1 to 4294967295, got ${JSON.stringify(raw)}`
  );
  process.exit(2);
}

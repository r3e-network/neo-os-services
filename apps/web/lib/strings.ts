// Strict string trim: returns '' for any non-string input — NO coercion.
//
// Deliberately distinct from the shared package's coercion trimString
// (`String(value ?? '').trim()`). API route handlers and their server-side lib
// modules parse untrusted JSON, where a numeric field (e.g. `target_chain: 123`)
// must normalize to '' rather than the coerced token '123'. Keep the two helpers
// separate; do NOT merge this with @r3e-network/neo-os-services-shared's trimString.
export function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

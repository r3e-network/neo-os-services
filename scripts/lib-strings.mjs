// Strict string trim: returns '' for any non-string input — NO coercion. Shared by
// the scripts/ operator CLIs and lib-*.mjs helpers, mirroring apps/web/lib/strings.ts.
//
// Deliberately distinct from @r3e-network/neo-os-services-shared's coercion trimString
// (String(value ?? '').trim()): these scripts read env/JSON where a non-string must
// normalize to '' rather than a coerced token. Kept scripts-local (not the shared
// package) so no script gains a cross-package dependency.
export function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

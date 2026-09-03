function isHostSignerField(name: string) {
  const compact = name.replace(/[_-]/g, '').toLowerCase();
  return (
    compact.includes('privatekey') ||
    compact === 'wif' ||
    compact.startsWith('wif') ||
    compact.endsWith('wif')
  );
}

function carriesValue(value: unknown) {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}

/**
 * Return JSON paths containing host-side signing material. The walk is bounded
 * and cycle-safe so it can be used directly on untrusted route bodies.
 */
export function findHostSignerMaterialPaths(value: unknown): string[] {
  const findings: string[] = [];
  const seen = new WeakSet<object>();
  let visited = 0;
  let scanLimitExceeded = false;

  function visit(current: unknown, path: string, depth: number) {
    if (!current || typeof current !== 'object') return;
    if (visited >= 256 || depth > 8) {
      scanLimitExceeded = true;
      return;
    }
    const object = current as object;
    if (seen.has(object)) return;
    seen.add(object);
    visited += 1;

    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (isHostSignerField(key) && carriesValue(entry)) {
        findings.push(nextPath);
        continue;
      }
      visit(entry, nextPath, depth + 1);
    }
  }

  visit(value, '$', 0);
  if (scanLimitExceeded) findings.push('$.__host_key_scan_limit_exceeded__');
  return findings.sort();
}

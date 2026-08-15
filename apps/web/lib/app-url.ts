const DEFAULT_METADATA_BASE = 'http://localhost:3000';

export function resolveMetadataBase(rawUrl: string | undefined): URL {
  const candidate = rawUrl?.trim() || DEFAULT_METADATA_BASE;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return new URL(DEFAULT_METADATA_BASE);
    }
    return new URL(parsed.origin);
  } catch {
    return new URL(DEFAULT_METADATA_BASE);
  }
}

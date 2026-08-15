import { describe, expect, it } from 'vitest';
import { resolveMetadataBase } from '../lib/app-url';

describe('resolveMetadataBase', () => {
  it('falls back to localhost when NEXT_PUBLIC_APP_URL is unset or malformed', () => {
    expect(resolveMetadataBase(undefined).toString()).toBe('http://localhost:3000/');
    expect(resolveMetadataBase('   ').toString()).toBe('http://localhost:3000/');
    expect(resolveMetadataBase('not a url').toString()).toBe('http://localhost:3000/');
    expect(resolveMetadataBase('javascript:alert(1)').toString()).toBe('http://localhost:3000/');
    expect(resolveMetadataBase('ftp://oracle.r3e.network').toString()).toBe(
      'http://localhost:3000/'
    );
  });

  it('normalizes valid app URLs to their origin', () => {
    expect(resolveMetadataBase('https://oracle.r3e.network/docs?x=1').toString()).toBe(
      'https://oracle.r3e.network/'
    );
    expect(resolveMetadataBase('https://user:pass@oracle.r3e.network:8443/docs').toString()).toBe(
      'https://oracle.r3e.network:8443/'
    );
  });
});

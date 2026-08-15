import { describe, expect, it } from 'vitest';
import { getServiceProblemDetail } from '../lib/service-health';

describe('getServiceProblemDetail', () => {
  it('returns null for healthy payloads', () => {
    expect(getServiceProblemDetail({ status: 'ok', service: 'morpheus-web' })).toBeNull();
    expect(
      getServiceProblemDetail({ ok: true, network: 'testnet', neo_n3: { error: null } })
    ).toBeNull();
    expect(getServiceProblemDetail({ providers: [] })).toBeNull();
    expect(getServiceProblemDetail(null)).toBeNull();
    expect(getServiceProblemDetail('plain text')).toBeNull();
  });

  it('flags ok:false payloads with the chain error detail', () => {
    expect(
      getServiceProblemDetail({
        ok: false,
        network: 'testnet',
        neo_n3: { oracle: null, datafeed: null, error: 'rpc request failed with status 502' },
      })
    ).toBe('rpc request failed with status 502');
    expect(getServiceProblemDetail({ ok: false })).toBe('service reported ok: false');
  });

  it('flags error strings and degraded flags carried inside 200 bodies', () => {
    expect(getServiceProblemDetail({ error: 'upstream unavailable' })).toBe('upstream unavailable');
    expect(
      getServiceProblemDetail({ degraded: true, reason: 'runtime_control_plane_disabled' })
    ).toBe('runtime_control_plane_disabled');
    expect(getServiceProblemDetail({ degraded: true })).toBe('service reported degraded: true');
  });

  it('flags explicit failure status strings', () => {
    expect(getServiceProblemDetail({ status: 'error' })).toBe('service status: error');
    expect(getServiceProblemDetail({ status: 'unhealthy' })).toBe('service status: unhealthy');
  });
});

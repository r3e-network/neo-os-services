import { json } from '../platform/core.js';
import { buildSignedResultEnvelope, buildLaneSignedEnvelope } from '../chain/index.js';

export async function handleVrf(payload) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const randomness = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const signed = await buildSignedResultEnvelope({ randomness }, payload);
  // signed.tee_attestation already binds signed.output_hash (sha256 of the result);
  // reuse it instead of a second /attest call with the same report_data.
  return json(200, {
    request_id: payload.request_id || crypto.randomUUID(),
    randomness,
    // D5: emit the canonical signed-result envelope (now including output_hash,
    // which the VRF lane previously dropped) so verification is uniform across
    // every fulfillment lane. Lane-specific fields are kept.
    ...buildLaneSignedEnvelope(signed),
    timestamp: Math.floor(Date.now() / 1000),
    vrf_method: 'csprng-signed',
  });
}

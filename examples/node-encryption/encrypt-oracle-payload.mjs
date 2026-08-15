import { encryptWithOracleKey } from '../scripts/common.mjs';

async function fetchOracleKey(baseUrl, token) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/oracle/public-key`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(`failed to fetch oracle key: ${response.status}`);
  }
  return response.json();
}

// MORPHEUS_API_URL / MORPHEUS_API_TOKEN are the env names for the AWS Nitro runtime.
const baseUrl = process.env.MORPHEUS_API_URL || '';
const token = process.env.MORPHEUS_API_TOKEN || '';

if (!baseUrl) {
  throw new Error('MORPHEUS_API_URL is required');
}

const oracleKey = await fetchOracleKey(baseUrl, token);

const encryptedToken = await encryptWithOracleKey(
  oracleKey.public_key,
  'Bearer my-private-api-token'
);

const encryptedPayload = await encryptWithOracleKey(
  oracleKey.public_key,
  JSON.stringify({
    mode: 'builtin',
    function: 'math.modexp',
    input: { base: '2', exponent: '10', modulus: '17' },
    target_chain: 'neo_n3',
  })
);

console.log(
  JSON.stringify(
    {
      algorithm: oracleKey.algorithm,
      encrypted_token: encryptedToken,
      encrypted_payload: encryptedPayload,
    },
    null,
    2
  )
);

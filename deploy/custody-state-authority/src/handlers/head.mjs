import { makeHandler } from '../http.mjs';
import { getAuthority } from '../runtime.mjs';

export const handler = makeHandler({
  method: 'GET',
  route: '/v1/vaults/{vaultId}/profiles/{profileId}/head',
  session: true,
  async invoke({ path, token, proof }) {
    const result = await (
      await getAuthority()
    ).getHead({
      vaultId: path.vaultId,
      profileId: path.profileId,
      token,
      proof,
    });
    return { statusCode: 200, body: result };
  },
});

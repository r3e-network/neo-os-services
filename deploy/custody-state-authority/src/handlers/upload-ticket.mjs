import { makeHandler } from '../http.mjs';
import { getAuthority } from '../runtime.mjs';

export const handler = makeHandler({
  method: 'POST',
  route: '/v1/vaults/{vaultId}/profiles/{profileId}/upload-tickets',
  body: true,
  session: true,
  async invoke({ input, path, token, proof }) {
    const result = await (
      await getAuthority()
    ).createUploadTicket({
      vaultId: path.vaultId,
      profileId: path.profileId,
      token,
      input,
      proof,
    });
    return { statusCode: result.idempotent ? 200 : 201, body: result };
  },
});

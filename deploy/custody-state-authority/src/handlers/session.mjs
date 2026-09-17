import { makeHandler } from '../http.mjs';
import { getAuthority } from '../runtime.mjs';

export const handler = makeHandler({
  method: 'POST',
  body: true,
  async invoke({ input }) {
    const result = await (await getAuthority()).createSession(input);
    return { statusCode: 201, body: result };
  },
});

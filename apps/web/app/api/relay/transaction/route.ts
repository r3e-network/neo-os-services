import { proxyToNitro } from '@/lib/nitro';
import { recordOperationLog } from '@/lib/operation-logs';
import { isAuthorizedAdminRequest } from '@/lib/server-supabase';
import { trimString } from '@/lib/strings';

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request, 'relay_transaction')) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = { raw_body: body };
  }
  const targetChain =
    parsed && typeof parsed === 'object'
      ? trimString(
          (parsed as Record<string, unknown>).target_chain ||
            (parsed as Record<string, unknown>).targetChain ||
            ''
        )
      : '';
  if (targetChain && targetChain !== 'neo_n3') {
    await recordOperationLog({
      route: '/api/relay/transaction',
      method: 'POST',
      category: 'relay',
      requestPayload: parsed,
      responsePayload: { error: 'target_chain must be neo_n3' },
      httpStatus: 400,
      error: 'target_chain must be neo_n3',
    });
    return Response.json({ error: 'target_chain must be neo_n3' }, { status: 400 });
  }
  return proxyToNitro(
    '/relay/transaction',
    { method: 'POST', body },
    {
      route: '/api/relay/transaction',
      category: 'relay',
      requestPayload: parsed,
    }
  );
}

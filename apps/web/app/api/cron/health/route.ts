import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { sendHeartbeat } from '@/lib/heartbeat';
import { recordOperationLog } from '@/lib/operation-logs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    // The heartbeat exists to prove the cron schedule is alive; an
    // unauthenticated crawler or uptime monitor must not be able to fire it.
    const body = { error: 'unauthorized' };
    void recordOperationLog({
      route: '/api/cron/health',
      method: 'GET',
      category: 'system',
      responsePayload: body,
      httpStatus: 401,
      error: 'unauthorized',
    });
    return Response.json(body, { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  const heartbeatSent = await sendHeartbeat(
    process.env.MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL || '',
    { status: 'ok', service: 'morpheus-cron' }
  );
  const body = { status: 'ok', service: 'morpheus-cron', heartbeat_sent: heartbeatSent };
  void recordOperationLog({
    route: '/api/cron/health',
    method: 'GET',
    category: 'system',
    responsePayload: body,
    httpStatus: 200,
  });
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}

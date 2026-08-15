import { recordOperationLog } from '@/lib/operation-logs';

export async function GET() {
  const body = { status: 'ok', service: 'morpheus-web' };
  // Fire-and-forget: the health probe must not couple its latency (or its
  // success) to a Supabase insert. recordOperationLog already swallows errors.
  void recordOperationLog({
    route: '/api/health',
    method: 'GET',
    category: 'system',
    responsePayload: body,
    httpStatus: 200,
  });
  return Response.json(body);
}

import { resolveRuntimeRequestNetwork } from '@/lib/runtime-health';
import { buildRuntimeStatusSnapshotForNetwork } from '@/lib/runtime-status';

// Re-homed (2026-06): synthesize the public runtime status from trustless sources —
// the attested box /health (liveness), the configured enclave identity, and the
// static workflow catalog — via the shared snapshot assembler (kept unchanged so
// apps/web and the edge worker stay byte-compatible). No retired-runtime proxy.
export async function GET(request: Request) {
  const network = resolveRuntimeRequestNetwork(request);
  const snapshot = await buildRuntimeStatusSnapshotForNetwork(network);

  return Response.json(snapshot, {
    status: snapshot.runtime.status === 'down' ? 503 : 200,
    headers: { 'cache-control': 'no-store' },
  });
}

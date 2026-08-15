import { getPublicWorkflowCatalog } from '@/lib/workflow-runtime';

export async function GET() {
  return Response.json(getPublicWorkflowCatalog(), {
    headers: {
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
}

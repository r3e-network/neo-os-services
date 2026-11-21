export type RuntimeProbeSnapshotInput = {
  ok: boolean;
  status: number;
  body: unknown;
};

export type PublicRuntimeCatalogSummary = {
  envelope: Record<string, unknown>;
  topology: Record<string, unknown>;
  risk: Record<string, unknown>;
  automation: Record<string, unknown>;
  workflows: {
    count: number;
    ids: string[];
  };
  links: {
    catalog: '/api/runtime/catalog';
    workflows: '/api/workflows';
    policies: '/api/policies';
  };
};

export type PublicRuntimeStatusSnapshot = {
  checkedAt: string;
  catalog: PublicRuntimeCatalogSummary;
  runtime: {
    status: 'operational' | 'degraded' | 'down';
    health: {
      ok: boolean;
      statusCode: number;
      state: 'ok' | 'degraded' | 'down';
      detail: string | null;
    };
    info: {
      ok: boolean;
      statusCode: number;
      appId: string | null;
      composeHash: string | null;
      clientKind: string | null;
      version: string | null;
      detail: string | null;
    };
  };
};

export const PUBLIC_RUNTIME_DISCOVERY_LINKS: {
  catalog: '/api/runtime/catalog';
  workflows: '/api/workflows';
  policies: '/api/policies';
};

export function buildPublicRuntimeCatalogSummary(
  catalog: Record<string, unknown>
): PublicRuntimeCatalogSummary;

export function buildPublicRuntimeStatusSnapshot(input: {
  catalog: Record<string, unknown>;
  checkedAt?: string;
  health: RuntimeProbeSnapshotInput;
  info: RuntimeProbeSnapshotInput;
}): PublicRuntimeStatusSnapshot;

export function getPublicRuntimeStatusNotes(snapshot: PublicRuntimeStatusSnapshot): string[];

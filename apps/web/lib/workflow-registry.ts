import { trimString } from './strings';

/**
 * Developer self-serve workflow registry domain logic (P0-1).
 *
 * Pure validation/state-machine helpers shared by the workflow registry API
 * routes. Platform workflows remain in the static public catalog; user-owned
 * workflows live in `morpheus_workflow_registry` and use the
 * `user.<network>.<slug>.<name>` id namespace so they can never collide with
 * platform workflow ids, nor with the same slug on another network (project
 * slugs are only unique per-network).
 */

export const WORKFLOW_TRIGGER_KINDS = ['request', 'cron', 'http', 'chain_event'] as const;
export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];

export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'deleted'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const MAX_HANDLER_SOURCE_LENGTH = 64 * 1024; // 64 KiB, aligned with worker script limits
export const MAX_NAME_LENGTH = 96;
export const MAX_TRIGGER_CONFIG_BYTES = 16 * 1024;
export const MIN_CRON_INTERVAL_SECONDS = 30; // mirrors the CRE floor (cron >= 30s)

/** Lowercase and reduce a free-form string to a safe `[a-z0-9._-]` id segment. */
export function sanitizeIdSegment(value: string): string {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Namespaced user workflow id: `user.<network>.<project-slug>.<workflow-name>`.
 * Including the network keeps ids globally unique even though project slugs
 * are only unique per-network (prevents cross-network squatting).
 */
export function buildUserWorkflowId(projectSlug: string, name: string, network: string): string {
  const net = sanitizeIdSegment(network);
  const slug = sanitizeIdSegment(projectSlug);
  const namePart = sanitizeIdSegment(name);
  return `user.${net}.${slug}.${namePart}`;
}

const ALLOWED_STATUS_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  draft: ['draft', 'active', 'deleted'],
  active: ['active', 'paused', 'deleted'],
  paused: ['active', 'deleted'],
  deleted: [], // terminal: soft-deleted workflows cannot be resurrected
};

export function isAllowedStatusTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isWorkflowTriggerKind(value: unknown): value is WorkflowTriggerKind {
  return typeof value === 'string' && (WORKFLOW_TRIGGER_KINDS as readonly string[]).includes(value);
}

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === 'string' && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a trigger config for the given kind. Returns an error message or null. */
export function validateTriggerConfig(kind: WorkflowTriggerKind, config: unknown): string | null {
  if (!isPlainObject(config)) return 'trigger_config must be a JSON object';
  if (JSON.stringify(config).length > MAX_TRIGGER_CONFIG_BYTES) {
    return `trigger_config exceeds ${MAX_TRIGGER_CONFIG_BYTES} bytes`;
  }
  switch (kind) {
    case 'request':
      return null; // chain request trigger needs no extra config
    case 'cron': {
      const interval = Number(config.interval_seconds);
      if (Number.isFinite(interval) && interval >= MIN_CRON_INTERVAL_SECONDS) return null;
      const cronExpr = trimString(config.cron);
      if (!cronExpr) {
        return `cron trigger requires "cron" or "interval_seconds" (>= ${MIN_CRON_INTERVAL_SECONDS}s)`;
      }
      return cronExpr.split(/\s+/).filter(Boolean).length === 5
        ? null
        : 'cron trigger requires a 5-field cron expression';
    }
    case 'http': {
      const method = String(config.method || 'POST').toUpperCase();
      if (!['GET', 'POST'].includes(method)) return 'http trigger method must be GET or POST';
      const path = trimString(config.path || config.url_path);
      if (!path || !/^\/[a-zA-Z0-9._\-\/]*$/.test(path) || path.split('/').includes('..')) {
        return 'http trigger requires a "path" starting with "/" without ".." segments';
      }
      return null;
    }
    case 'chain_event': {
      const event = trimString(config.event_name);
      if (!event || event.length > 128) {
        return 'chain_event trigger requires a non-empty "event_name" (<= 128 chars)';
      }
      return null;
    }
    default:
      return `unknown trigger_kind: ${String(kind)}`;
  }
}

/** Validate a user-supplied JS handler source. Returns an error message or null. */
export function validateHandlerSource(source: unknown): string | null {
  if (source === undefined || source === null || source === '') return null; // optional for `request` triggers
  if (typeof source !== 'string') return 'handler_source must be a string';
  if (source.length > MAX_HANDLER_SOURCE_LENGTH) {
    return `handler_source exceeds ${MAX_HANDLER_SOURCE_LENGTH} characters`;
  }
  // The TEE worker enforces its own sandbox policy; the registry only performs
  // basic shape checks so bad payloads fail fast at the API boundary.
  if (!/\b(function\s+[a-zA-Z_$][\w$]*|=>|async\b)/.test(source)) {
    return 'handler_source must define a function (e.g. `function run(input) { ... }`)';
  }
  return null;
}

export type WorkflowRegistryRow = {
  id: string;
  project_id: string;
  workflow_id: string;
  name: string;
  version: number;
  status: WorkflowStatus;
  trigger_kind: WorkflowTriggerKind;
  trigger_config: Record<string, unknown>;
  handler_source: string | null;
  target_chain: string;
  network: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export function toPublicWorkflowRecord(row: WorkflowRegistryRow) {
  return {
    id: row.workflow_id,
    version: row.version,
    status: row.status,
    // `kind` comes last so a user-supplied trigger_config.kind can never
    // spoof the stored, validated trigger kind.
    trigger: { ...row.trigger_config, kind: row.trigger_kind },
    target_chain: row.target_chain,
    network: row.network,
    source: 'user_registry',
    updated_at: row.updated_at,
  };
}

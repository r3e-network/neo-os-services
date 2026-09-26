import { json, getClientIp } from '@r3e-network/neo-os-services-shared/utils';
import { handleRootRoute, handleHealthRoute, JOB_ROUTE_CONFIG } from './lib/health.js';
import {
  resolveNetworkRoute,
  resolveJobMetadata,
  resolveRequeueLimit,
  resolveStaleProcessingMs,
  resolveMaxBodyBytes,
} from './lib/config.js';
import { validateAuth, applyRateLimit } from './lib/auth.js';
import { insertJob, loadJob, patchJob } from './lib/jobs.js';
import { enqueueJob, listRecoverableJobs, requeueJob } from './lib/recovery.js';
import {
  dispatchWorkflowInstance,
  isWorkflowRouteConfig,
  loadWorkflowInstanceDetails,
} from './lib/workflows.js';
import {
  processExecutionJob,
  processFeedTickJob,
  processDeadLetterJob,
} from './lib/queue-consumer.js';
import { buildWorkflowDispatchMetadata } from './lib/workflow-dispatch.js';
import { CallbackBroadcastWorkflow, AutomationExecuteWorkflow } from './lib/workflows-impl.js';

export { CallbackBroadcastWorkflow, AutomationExecuteWorkflow };

const RECOVERABLE_NETWORKS = ['mainnet', 'testnet'];

async function recoverNetworkJobs(env, network) {
  const limit = resolveRequeueLimit(env);
  const staleProcessingMs = resolveStaleProcessingMs(env);
  const jobs = await listRecoverableJobs(env, network, limit, staleProcessingMs);
  const requeued = [];
  const skipped = [];
  const failed = [];
  const deadLettered = [];
  for (const job of jobs) {
    try {
      const outcome = await requeueJob(env, job);
      const entry = {
        id: job.id,
        route: job.route,
        previous_status: job.status,
        action: outcome?.action || 'queue_requeued',
        workflow_instance_id: outcome?.workflow_instance_id || null,
        workflow_status: outcome?.workflow_status || null,
      };
      if (entry.action === 'queue_requeued' || entry.action === 'workflow_redispatched') {
        requeued.push(entry);
      } else if (entry.action === 'dead_lettered') {
        deadLettered.push(entry);
      } else {
        skipped.push(entry);
      }
    } catch (error) {
      failed.push({
        id: job.id,
        route: job.route,
        previous_status: job.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    network,
    scanned: jobs.length,
    requeued_count: requeued.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    dead_lettered_count: deadLettered.length,
    requeued,
    skipped,
    failed,
    dead_lettered: deadLettered,
  };
}

export default {
  async fetch(request, env) {
    const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
    const rid = { 'x-request-id': requestId };
    const authFailure = validateAuth(request, env);
    if (authFailure) return authFailure;

    const url = new URL(request.url);
    const routing = resolveNetworkRoute(url);
    if (!routing.ok) {
      if (routing.status === 400) {
        return json(400, { error: 'unsupported Neo network', network: routing.network }, rid);
      }
      return json(404, { error: 'not found', path: routing.routePath }, rid);
    }

    if (routing.routePath === '/' || routing.routePath === '') {
      return handleRootRoute(routing.network);
    }

    if (routing.routePath === '/health') {
      return handleHealthRoute(routing.network, env);
    }

    if (routing.routePath === '/jobs/recover') {
      if (request.method !== 'POST') {
        return json(405, { error: 'method_not_allowed' }, rid);
      }
      try {
        return json(200, await recoverNetworkJobs(env, routing.network), rid);
      } catch (error) {
        return json(500, { error: error instanceof Error ? error.message : String(error) }, rid);
      }
    }

    const jobMatch = routing.routePath.match(/^\/jobs\/([0-9a-f-]+)$/i);
    if (request.method === 'GET' && jobMatch) {
      try {
        const job = await loadJob(env, jobMatch[1], routing.network);
        if (!job) return json(404, { error: 'job not found' }, rid);
        const jobConfig = JOB_ROUTE_CONFIG[job.route];
        if (job?.metadata?.workflow_instance_id && isWorkflowRouteConfig(jobConfig)) {
          try {
            const workflow = await loadWorkflowInstanceDetails(
              env,
              jobConfig,
              job.metadata.workflow_instance_id
            );
            return json(
              200,
              {
                ...job,
                workflow: {
                  instance_id: workflow.id,
                  status: workflow.details,
                },
              },
              rid
            );
          } catch {
            // fall back to stored job only
          }
        }
        return json(200, job, rid);
      } catch (error) {
        return json(500, { error: error instanceof Error ? error.message : String(error) }, rid);
      }
    }

    const jobConfig = JOB_ROUTE_CONFIG[routing.routePath];
    if (!jobConfig) {
      return json(404, { error: 'not found', path: routing.routePath }, rid);
    }
    if (request.method !== 'POST') {
      return json(405, { error: 'method_not_allowed' }, rid);
    }

    // Feed publication is owned by the self-scheduling Rust relayer. This edge
    // trigger is retired: return Gone rather than a success no-op so cron
    // monitoring cannot claim that an on-chain update occurred.
    if (routing.routePath === '/feeds/tick') {
      return json(
        410,
        { ok: false, status: 'retired', reason: 'feed_publication_owned_by_rust_relayer' },
        rid
      );
    }

    // The on-chain callback IS the relayer's fulfillRequest broadcast (the box
    // relayer is a complete reconciler: it scans pending requests by id, signs
    // IN-TEE, and has its own retry + dead-letter). The control-plane
    // callbacks/broadcast lane only RE-broadcasts an already-signed fulfillment
    // host-side and has no in-repo producer of that signed input — it is redundant,
    // and the kernel's "request already fulfilled" assert makes any duplicate
    // harmless. Short-circuit it so no duplicate host-signed broadcast is enqueued.
    // (The internal /api/internal/control-plane/callback-broadcast primitive stays
    // intact for a manual operator re-broadcast if ever needed.)
    if (routing.routePath === '/callbacks/broadcast') {
      return json(
        200,
        { ok: true, status: 'noop', reason: 'callback_lane_redundant_relayer_authoritative' },
        rid
      );
    }

    // The legacy edge workflow signs host-side and must never become a fallback for
    // the Rust custody architecture. Rust automation delivery is deliberately
    // fail-closed until its durable claim/execute/commit protocol ships, so this
    // route must report unavailability rather than falsely acknowledging execution.
    // automation_register / automation_cancel are Supabase-only and unaffected.
    if (routing.routePath === '/automation/execute') {
      return json(
        503,
        { ok: false, status: 'unavailable', reason: 'rust_automation_delivery_unavailable' },
        rid
      );
    }

    const rateLimited = await applyRateLimit(request, env, jobConfig.queue);
    if (rateLimited) return rateLimited;

    const maxBodyBytes = resolveMaxBodyBytes(env);
    // Reject oversized bodies up front via the declared content-length so we
    // never buffer + JSON.parse an arbitrarily large payload (memory/CPU DoS).
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return json(413, { error: 'request_body_too_large', max_bytes: maxBodyBytes }, rid);
    }

    const rawBody = await request.text();
    // content-length can be absent or spoofed; enforce the cap on the actual
    // received byte length too (UTF-8, matching how the body arrives over HTTP).
    const actualLength =
      typeof TextEncoder === 'function' ? new TextEncoder().encode(rawBody).length : rawBody.length;
    if (actualLength > maxBodyBytes) {
      return json(413, { error: 'request_body_too_large', max_bytes: maxBodyBytes }, rid);
    }
    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return json(400, { error: 'invalid JSON body' }, rid);
    }

    const metadata = resolveJobMetadata(routing.routePath, payload);
    const workflowMetadata =
      buildWorkflowDispatchMetadata(
        routing.routePath,
        { ...payload, ...metadata },
        routing.network
      ) ||
      (metadata.workflow_id
        ? {
            workflow_id: metadata.workflow_id,
            workflow_version: metadata.workflow_version || 1,
            execution_id: metadata.execution_id || crypto.randomUUID(),
            legacy_route: routing.routePath,
          }
        : null);
    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const baseRecord = {
      id: jobId,
      network: routing.network,
      queue: jobConfig.queue,
      route: routing.routePath,
      target_chain: metadata.target_chain,
      project_slug: metadata.project_slug,
      request_id: metadata.request_id,
      status: 'queued',
      dedupe_key: metadata.dedupe_key,
      payload,
      metadata: {
        ingress_route: url.pathname,
        source: 'cloudflare-control-plane',
        client_ip: getClientIp(request),
        delivery_mode: jobConfig.delivery || 'queue',
        request_id: requestId,
        ...(workflowMetadata || {}),
      },
      retry_count: 0,
      created_at: createdAt,
      updated_at: createdAt,
    };

    try {
      const inserted = await insertJob(env, baseRecord);
      let updated = inserted;
      if (isWorkflowRouteConfig(jobConfig)) {
        const workflow = await dispatchWorkflowInstance(env, inserted, jobConfig);
        updated =
          (await patchJob(env, jobId, routing.network, {
            status: 'dispatched',
            metadata: {
              ...(inserted.metadata || {}),
              workflow_name: workflow.workflow_name,
              workflow_binding: workflow.workflow_binding,
              workflow_instance_id: workflow.id,
              workflow_status: workflow.details || null,
              workflow_dispatch_count: workflow.workflow_dispatch_count,
              workflow_id: workflow.workflow_id,
              workflow_version: workflow.workflow_version,
              execution_id: workflow.execution_id,
              legacy_route: workflow.legacy_route,
            },
          }).catch(() => null)) || inserted;
      } else {
        await enqueueJob(env, jobConfig.binding, {
          job_id: jobId,
          network: routing.network,
          queue: jobConfig.queue,
          route: routing.routePath,
          payload,
          target_chain: metadata.target_chain,
          project_slug: metadata.project_slug,
          request_id: metadata.request_id,
          ...(workflowMetadata || {}),
          created_at: createdAt,
        });
        updated =
          (await patchJob(env, jobId, routing.network, {
            status: 'dispatched',
          }).catch(() => null)) || inserted;
      }
      return json(202, updated, rid);
    } catch (error) {
      await patchJob(env, jobId, routing.network, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completed_at: new Date().toISOString(),
      }).catch(() => null);
      return json(
        503,
        {
          error: error instanceof Error ? error.message : String(error),
          job_id: jobId,
        },
        rid
      );
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      if (batch.queue === 'morpheus-oracle-request') {
        await processExecutionJob(message, env);
        continue;
      }
      if (batch.queue === 'morpheus-feed-tick') {
        await processFeedTickJob(message, env);
        continue;
      }
      // Dead-letter queues: finalize the poison job's Supabase row terminal so
      // the cron recovery path stops re-requeuing it.
      if (
        batch.queue === 'morpheus-oracle-request-dlq' ||
        batch.queue === 'morpheus-feed-tick-dlq'
      ) {
        await processDeadLetterJob(message, env);
        continue;
      }
      message.ack();
    }
  },

  // Cron safety net for the operator-driven POST /<network>/jobs/recover flow.
  // Queue messages that exhaust max_retries are routed to the dead-letter
  // queue by Cloudflare, but the corresponding Supabase rows would otherwise
  // stay stuck in queued/processing until an operator notices; this trigger
  // runs the same recovery path automatically.
  async scheduled(_controller, env) {
    const summaries = [];
    for (const network of RECOVERABLE_NETWORKS) {
      try {
        const summary = await recoverNetworkJobs(env, network);
        summaries.push(summary);
        if (summary.scanned > 0) {
          console.log(
            `[control-plane] cron recovery ${network}: scanned=${summary.scanned} requeued=${summary.requeued_count} skipped=${summary.skipped_count} failed=${summary.failed_count}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summaries.push({ network, error: message });
        console.error(`[control-plane] cron recovery ${network} failed: ${message}`);
      }
    }
    return summaries;
  },
};

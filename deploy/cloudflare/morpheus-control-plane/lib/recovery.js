import { parseTimestampMs, trimString } from '@r3e-network/neo-os-services-shared/utils';
import { supabaseFetch } from './supabase.js';
import { normalizeJobStatus, REQUEUE_GRACE_MS, patchJob } from './jobs.js';
import { isStaleProcessing, resolveMaxRequeueAttempts } from './config.js';
import { JOB_ROUTE_CONFIG } from './health.js';
import { isWorkflowRouteConfig, requeueWorkflowJob } from './workflows.js';

// The number of times a job has already been re-driven by the recovery path.
// We use the larger of the recovery-tracked `requeue_attempts` and the
// workflow-tracked `workflow_dispatch_count` so workflow and queue jobs share
// one ceiling. The initial (ingress) dispatch is dispatch_count 1, so a job
// that was dispatched once and never re-driven reports 0 prior recovery
// attempts here.
function resolvePriorRequeueAttempts(job) {
  const metadata = job?.metadata || {};
  const requeueAttempts = Number(metadata.requeue_attempts || 0);
  const dispatchCount = Number(metadata.workflow_dispatch_count || 0);
  const priorDispatchRetries = dispatchCount > 1 ? dispatchCount - 1 : 0;
  return Math.max(Number.isFinite(requeueAttempts) ? requeueAttempts : 0, priorDispatchRetries);
}

async function deadLetterJob(env, job, attempts) {
  const nowIso = new Date().toISOString();
  await patchJob(env, job.id, job.network, {
    status: 'dead_lettered',
    error:
      trimString(job.error) ||
      `dead-lettered after ${attempts} recovery requeue attempts (poison job)`,
    run_after: null,
    completed_at: nowIso,
    metadata: {
      ...(job.metadata || {}),
      requeue_attempts: attempts,
      dead_letter_source: 'control-plane-recover-ceiling',
      dead_lettered_at: nowIso,
    },
  });
  return {
    action: 'dead_lettered',
    requeue_attempts: attempts,
  };
}

async function listRecoverableJobs(env, network, limit, staleProcessingMs) {
  const response = await supabaseFetch(
    env,
    `/morpheus_control_plane_jobs?network=eq.${network}&select=*&status=in.(queued,processing,failed,dispatched)&order=created_at.asc&limit=${limit}`
  );
  if (!response.ok) {
    throw new Error(`recoverable job list failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json().catch(() => []);
  const nowMs = Date.now();
  return (Array.isArray(rows) ? rows : []).filter((job) => {
    const status = normalizeJobStatus(job.status);
    const jobConfig = JOB_ROUTE_CONFIG[job.route];
    const workflowManaged = isWorkflowRouteConfig(jobConfig);
    if (status === 'queued') {
      const runAfterMs = parseTimestampMs(job.run_after);
      const updatedMs = parseTimestampMs(job.updated_at);
      if (runAfterMs && runAfterMs > nowMs) return false;
      if (updatedMs && nowMs - updatedMs < REQUEUE_GRACE_MS) return false;
      return true;
    }
    if (status === 'processing') {
      return isStaleProcessing(job, nowMs, staleProcessingMs);
    }
    if (status === 'failed' && workflowManaged) {
      const updatedMs = parseTimestampMs(job.updated_at);
      if (updatedMs && nowMs - updatedMs < REQUEUE_GRACE_MS) return false;
      return true;
    }
    if (status === 'dispatched' && workflowManaged) {
      const updatedMs = parseTimestampMs(job.updated_at);
      if (!updatedMs) return false;
      return nowMs - updatedMs >= staleProcessingMs;
    }
    return false;
  });
}

async function enqueueJob(env, bindingName, message) {
  const binding = env[bindingName];
  if (!binding || typeof binding.send !== 'function') {
    throw new Error(`queue binding ${bindingName} is not configured`);
  }
  await binding.send(message);
}

async function requeueJob(env, job) {
  const jobConfig = JOB_ROUTE_CONFIG[job.route];
  if (!jobConfig) {
    throw new Error(`route ${job.route} is not configured`);
  }
  const nowIso = new Date().toISOString();
  const maxAttempts = resolveMaxRequeueAttempts(env);
  const priorAttempts = resolvePriorRequeueAttempts(job);

  if (isWorkflowRouteConfig(jobConfig)) {
    // For workflow routes, let requeueWorkflowJob run its active/complete
    // short-circuits first (a still-running workflow must NOT be dead-lettered).
    // When it would otherwise start a *fresh* redispatch but the ceiling is hit,
    // it finalizes the job dead_lettered instead (blockRedispatch).
    return await requeueWorkflowJob(env, job, jobConfig, {
      blockRedispatch: priorAttempts >= maxAttempts,
      requeueAttempts: priorAttempts,
    });
  }

  // Queue (non-workflow) routes: apply the ceiling before re-enqueuing.
  if (priorAttempts >= maxAttempts) {
    return await deadLetterJob(env, job, priorAttempts);
  }

  const nextAttempts = priorAttempts + 1;
  await patchJob(env, job.id, job.network, {
    status: 'dispatched',
    error: null,
    run_after: null,
    started_at: null,
    completed_at: null,
    metadata: {
      ...(job.metadata || {}),
      last_requeued_at: nowIso,
      requeue_source: 'control-plane-recover',
      requeue_attempts: nextAttempts,
    },
  });
  await enqueueJob(env, jobConfig.binding, {
    job_id: job.id,
    network: job.network,
    queue: job.queue,
    route: job.route,
    payload: job.payload || {},
    target_chain: job.target_chain,
    project_slug: job.project_slug,
    request_id: job.request_id,
    dedupe_key: job.dedupe_key,
    created_at: job.created_at,
    requeued_at: nowIso,
  });
  return {
    action: 'queue_requeued',
  };
}

export { listRecoverableJobs, requeueJob, enqueueJob };

import { trimString, parseTimestampMs } from '@r3e-network/neo-os-services-shared/utils';
import { claimJob, loadJob, patchJob, normalizeJobStatus } from './jobs.js';
import { resolveStaleProcessingMs, computeRetryDelaySeconds, isStaleProcessing } from './config.js';
import { isRetryableStatus } from './execution-plane.js';
import { callExecutionPlane, callExecutionFeedPlane } from './execution-plane.js';
import {
  buildWorkflowDispatchMetadata,
  buildWorkflowExecutionPayload,
} from './workflow-dispatch.js';

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'dead_lettered', 'cancelled']);

function resolveWorkflowMetadata(job, network, fallbackExecutionId) {
  return buildWorkflowDispatchMetadata(
    job.route,
    {
      ...(job.metadata || {}),
      ...(job.payload || {}),
    },
    network,
    {
      executionId: trimString(job?.metadata?.execution_id || fallbackExecutionId || ''),
    }
  );
}

function mergeJobMetadata(job, workflowMetadata, extra = {}) {
  return {
    ...(job.metadata || {}),
    ...(workflowMetadata || {}),
    ...extra,
  };
}

async function claimQueueJob(message, env, job, network, queueName) {
  const attempts = Number(message.attempts || 1);
  const workflowMetadata = resolveWorkflowMetadata(job, network, job.id);
  try {
    const claimedJob = await claimJob(env, job, {
      status: 'processing',
      retry_count: Math.max(attempts - 1, 0),
      started_at: new Date().toISOString(),
      metadata: mergeJobMetadata(job, workflowMetadata, {
        queue_message_id: message.id,
        queue_attempts: attempts,
        queue_name: queueName,
      }),
    });
    if (!claimedJob) {
      message.ack();
      return null;
    }
    return { job: claimedJob, attempts, workflowMetadata };
  } catch {
    message.retry({ delaySeconds: computeRetryDelaySeconds(attempts, env) });
    return null;
  }
}

async function processExecutionJob(message, env) {
  const body = message.body && typeof message.body === 'object' ? message.body : {};
  const jobId = trimString(body.job_id);
  const network = trimString(body.network) === 'mainnet' ? 'mainnet' : 'testnet';
  if (!jobId) {
    message.ack();
    return;
  }

  let job = await loadJob(env, jobId, network);
  if (!job) {
    message.ack();
    return;
  }

  const nowMs = Date.now();
  const staleProcessingMs = resolveStaleProcessingMs(env);
  const jobStatus = normalizeJobStatus(job.status);
  if (TERMINAL_JOB_STATUSES.has(jobStatus)) {
    message.ack();
    return;
  }
  if (jobStatus === 'processing' && !isStaleProcessing(job, nowMs, staleProcessingMs)) {
    message.ack();
    return;
  }
  if (jobStatus === 'queued') {
    const runAfterMs = parseTimestampMs(job.run_after);
    if (runAfterMs && runAfterMs > nowMs) {
      const delaySeconds = Math.min(Math.max(Math.ceil((runAfterMs - nowMs) / 1000), 1), 300);
      message.retry({ delaySeconds });
      return;
    }
  }

  const claim = await claimQueueJob(message, env, job, network, body.queue || 'oracle_request');
  if (!claim) return;
  job = claim.job;
  const { attempts, workflowMetadata } = claim;

  try {
    const result = await callExecutionPlane(env, {
      ...job,
      payload: buildWorkflowExecutionPayload(
        job.route,
        job.payload || {},
        job.metadata || {},
        network,
        {
          executionId: workflowMetadata?.execution_id || jobId,
        }
      ),
    });
    if (result.ok) {
      await patchJob(env, jobId, network, {
        status: 'succeeded',
        result: result.body,
        error: null,
        completed_at: new Date().toISOString(),
        run_after: null,
        metadata: mergeJobMetadata(job, workflowMetadata, {
          execution_status: result.status,
          execution_base_url: result.execution_base_url,
        }),
      }).catch(() => null);
      message.ack();
      return;
    }

    if (!isRetryableStatus(result.status)) {
      await patchJob(env, jobId, network, {
        status: 'failed',
        result: result.body,
        error:
          trimString(result.body?.error || result.body?.message || '') ||
          `execution failed with status ${result.status}`,
        completed_at: new Date().toISOString(),
        run_after: null,
        metadata: mergeJobMetadata(job, workflowMetadata, {
          execution_status: result.status,
          execution_base_url: result.execution_base_url,
        }),
      }).catch(() => null);
      message.ack();
      return;
    }

    const delaySeconds = computeRetryDelaySeconds(attempts, env);
    await patchJob(env, jobId, network, {
      status: 'queued',
      result: null,
      error:
        trimString(result.body?.error || result.body?.message || '') ||
        `execution temporarily failed with status ${result.status}`,
      retry_count: attempts,
      run_after: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      metadata: mergeJobMetadata(job, workflowMetadata, {
        execution_status: result.status,
        execution_base_url: result.execution_base_url,
      }),
    }).catch(() => null);
    message.retry({ delaySeconds });
  } catch (error) {
    const delaySeconds = computeRetryDelaySeconds(attempts, env);
    await patchJob(env, jobId, network, {
      status: 'queued',
      result: null,
      error: error instanceof Error ? error.message : String(error),
      retry_count: attempts,
      run_after: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      metadata: mergeJobMetadata(job, workflowMetadata, {
        last_queue_error: error instanceof Error ? error.message : String(error),
      }),
    }).catch(() => null);
    message.retry({ delaySeconds });
  }
}

async function processFeedTickJob(message, env) {
  const body = message.body && typeof message.body === 'object' ? message.body : {};
  const jobId = trimString(body.job_id);
  const network = trimString(body.network) === 'mainnet' ? 'mainnet' : 'testnet';
  if (!jobId) {
    message.ack();
    return;
  }
  let job = await loadJob(env, jobId, network);
  if (!job) {
    message.ack();
    return;
  }
  const nowMs = Date.now();
  const staleProcessingMs = resolveStaleProcessingMs(env);
  const jobStatus = normalizeJobStatus(job.status);
  if (TERMINAL_JOB_STATUSES.has(jobStatus)) {
    message.ack();
    return;
  }
  if (jobStatus === 'processing' && !isStaleProcessing(job, nowMs, staleProcessingMs)) {
    message.ack();
    return;
  }
  if (jobStatus === 'queued') {
    const runAfterMs = parseTimestampMs(job.run_after);
    if (runAfterMs && runAfterMs > nowMs) {
      const delaySeconds = Math.min(Math.max(Math.ceil((runAfterMs - nowMs) / 1000), 1), 300);
      message.retry({ delaySeconds });
      return;
    }
  }
  const claim = await claimQueueJob(message, env, job, network, body.queue || 'feed_tick');
  if (!claim) return;
  job = claim.job;
  const { attempts, workflowMetadata } = claim;

  try {
    const result = await callExecutionFeedPlane(env, {
      ...job,
      network,
      payload: buildWorkflowExecutionPayload(
        job.route,
        job.payload || {},
        job.metadata || {},
        network,
        {
          executionId: workflowMetadata?.execution_id || jobId,
        }
      ),
    });
    if (result.ok) {
      await patchJob(env, jobId, network, {
        status: 'succeeded',
        result: result.body,
        error: null,
        completed_at: new Date().toISOString(),
        run_after: null,
        metadata: mergeJobMetadata(job, workflowMetadata, {
          execution_status: result.status,
          execution_base_url: result.execution_base_url,
        }),
      }).catch(() => null);
      message.ack();
      return;
    }

    if (!isRetryableStatus(result.status)) {
      await patchJob(env, jobId, network, {
        status: 'failed',
        result: result.body,
        error:
          trimString(result.body?.error || result.body?.message || '') ||
          `feed tick failed with status ${result.status}`,
        completed_at: new Date().toISOString(),
        run_after: null,
        metadata: mergeJobMetadata(job, workflowMetadata, {
          execution_status: result.status,
          execution_base_url: result.execution_base_url,
        }),
      }).catch(() => null);
      message.ack();
      return;
    }

    const delaySeconds = computeRetryDelaySeconds(attempts, env);
    await patchJob(env, jobId, network, {
      status: 'queued',
      error:
        trimString(result.body?.error || result.body?.message || '') ||
        `feed tick temporarily failed with status ${result.status}`,
      retry_count: attempts,
      run_after: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      metadata: mergeJobMetadata(job, workflowMetadata, {
        execution_status: result.status,
        execution_base_url: result.execution_base_url,
      }),
    }).catch(() => null);
    message.retry({ delaySeconds });
  } catch (error) {
    const delaySeconds = computeRetryDelaySeconds(attempts, env);
    await patchJob(env, jobId, network, {
      status: 'queued',
      error: error instanceof Error ? error.message : String(error),
      retry_count: attempts,
      run_after: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      metadata: mergeJobMetadata(job, workflowMetadata, {
        last_queue_error: error instanceof Error ? error.message : String(error),
      }),
    }).catch(() => null);
    message.retry({ delaySeconds });
  }
}

/**
 * Dead-letter consumer: a message lands here only after the primary consumer has
 * exhausted `max_retries`, so the underlying Supabase job row is a poison job
 * that must be finalized. Without this, the row stays in queued/processing and
 * the cron recovery path (POST /jobs/recover + scheduled) re-requeues it
 * forever. We mark it `dead_lettered` (already permitted by the 0010 CHECK
 * constraint and already in TERMINAL_JOB_STATUSES) so recovery stops listing it.
 *
 * The DLQ message body carries the same {job_id, network} the primary consumer
 * enqueued; we read those, load the row, and (unless it has since reached a
 * terminal state) patch it terminal. We always ack so the message leaves the
 * DLQ — there is no further retry lane beyond dead-letter.
 */
async function processDeadLetterJob(message, env) {
  const body = message.body && typeof message.body === 'object' ? message.body : {};
  const jobId = trimString(body.job_id);
  const network = trimString(body.network) === 'mainnet' ? 'mainnet' : 'testnet';
  if (!jobId) {
    message.ack();
    return;
  }

  try {
    const job = await loadJob(env, jobId, network);
    if (!job) {
      message.ack();
      return;
    }
    const jobStatus = normalizeJobStatus(job.status);
    if (TERMINAL_JOB_STATUSES.has(jobStatus)) {
      message.ack();
      return;
    }
    await patchJob(env, jobId, network, {
      status: 'dead_lettered',
      error:
        trimString(job.error) ||
        `dead-lettered after exhausting queue retries (queue=${trimString(body.queue) || 'unknown'})`,
      completed_at: new Date().toISOString(),
      run_after: null,
      metadata: {
        ...(job.metadata || {}),
        dead_letter_source: 'queue-dlq-consumer',
        dead_lettered_at: new Date().toISOString(),
        dead_letter_queue_message_id: message.id,
      },
    }).catch(() => null);
  } catch {
    // Even if the Supabase patch fails we ack: re-driving the DLQ message would
    // not change the outcome (the cron path is the durable backstop), and a
    // wedged DLQ is worse than a row the cron will mark on its next pass via the
    // requeue ceiling in recovery.js.
  }
  message.ack();
}

export { processExecutionJob, processFeedTickJob, processDeadLetterJob, TERMINAL_JOB_STATUSES };

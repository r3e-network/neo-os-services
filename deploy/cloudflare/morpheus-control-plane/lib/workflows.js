import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import { patchJob } from './jobs.js';

const ACTIVE_WORKFLOW_STATUSES = new Set([
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingforpause',
]);
const SUCCESSFUL_WORKFLOW_STATUSES = new Set(['complete']);

function isWorkflowBindingAvailable(env, bindingName) {
  const binding = env?.[bindingName];
  return Boolean(
    binding && typeof binding.create === 'function' && typeof binding.get === 'function'
  );
}

function isWorkflowRouteConfig(config) {
  return config?.delivery === 'workflow';
}

function normalizeWorkflowStatus(details) {
  const raw =
    typeof details === 'string'
      ? details
      : typeof details?.status === 'string'
        ? details.status
        : '';
  return raw.toLowerCase().replace(/[^a-z]/g, '');
}

async function loadWorkflowInstanceDetails(env, jobConfig, instanceId) {
  if (!isWorkflowRouteConfig(jobConfig)) return null;
  if (!isWorkflowBindingAvailable(env, jobConfig.workflowBinding)) return null;
  const binding = env[jobConfig.workflowBinding];
  const instance = await binding.get(instanceId);
  return {
    id: instance.id,
    details: typeof instance.status === 'function' ? await instance.status() : null,
  };
}

function buildWorkflowInstanceId(job, jobConfig) {
  const dispatchCount = Math.max(Number(job?.metadata?.workflow_dispatch_count || 0) + 1, 1);
  const workflowKey = trimString(job?.metadata?.workflow_id || '') || jobConfig.workflowName;
  return `${workflowKey}:${job.network}:${job.id}:${dispatchCount}`;
}

async function dispatchWorkflowInstance(env, job, jobConfig) {
  if (!jobConfig?.workflowBinding || !jobConfig?.workflowName) {
    throw new Error(`route ${job.route} is not configured for workflows`);
  }
  const binding = env[jobConfig.workflowBinding];
  if (!binding || typeof binding.create !== 'function') {
    throw new Error(`workflow binding ${jobConfig.workflowBinding} is not configured`);
  }
  const instanceId = buildWorkflowInstanceId(job, jobConfig);
  const workflowId = trimString(job?.metadata?.workflow_id || '') || jobConfig.workflowName;
  const workflowVersion = Math.max(Number(job?.metadata?.workflow_version || 1), 1);
  const executionId = trimString(job?.metadata?.execution_id || '') || instanceId;
  const legacyRoute = trimString(job?.metadata?.legacy_route || job.route || '') || null;
  const instance = await binding.create({
    id: instanceId,
    params: {
      job_id: job.id,
      network: job.network,
      payload: job.payload || {},
      workflow_id: workflowId,
      workflow_version: workflowVersion,
      execution_id: executionId,
      legacy_route: legacyRoute,
    },
  });
  return {
    id: instance.id,
    details: typeof instance.status === 'function' ? await instance.status() : null,
    workflow_binding: jobConfig.workflowBinding,
    workflow_name: jobConfig.workflowName,
    workflow_dispatch_count: Math.max(Number(job?.metadata?.workflow_dispatch_count || 0) + 1, 1),
    workflow_id: workflowId,
    workflow_version: workflowVersion,
    execution_id: executionId,
    legacy_route: legacyRoute,
  };
}

async function requeueWorkflowJob(env, job, jobConfig, options = {}) {
  const nowIso = new Date().toISOString();
  const existingWorkflowInstanceId = trimString(job?.metadata?.workflow_instance_id || '');
  if (existingWorkflowInstanceId) {
    try {
      const existingWorkflow = await loadWorkflowInstanceDetails(
        env,
        jobConfig,
        existingWorkflowInstanceId
      );
      const workflowStatus = normalizeWorkflowStatus(existingWorkflow?.details);
      if (ACTIVE_WORKFLOW_STATUSES.has(workflowStatus)) {
        const patchedStatus = workflowStatus === 'queued' ? 'dispatched' : 'processing';
        await patchJob(env, job.id, job.network, {
          status: patchedStatus,
          error: null,
          metadata: {
            ...(job.metadata || {}),
            workflow_name: jobConfig.workflowName,
            workflow_binding: jobConfig.workflowBinding,
            workflow_instance_id: existingWorkflow.id,
            workflow_status: existingWorkflow.details || null,
            workflow_last_checked_at: nowIso,
          },
        });
        return {
          action: 'workflow_active',
          workflow_instance_id: existingWorkflow.id,
          workflow_status: existingWorkflow.details || null,
        };
      }
      if (SUCCESSFUL_WORKFLOW_STATUSES.has(workflowStatus)) {
        await patchJob(env, job.id, job.network, {
          status: 'succeeded',
          result:
            existingWorkflow?.details &&
            typeof existingWorkflow.details === 'object' &&
            'output' in existingWorkflow.details
              ? existingWorkflow.details.output
              : job.result || null,
          error: null,
          completed_at: nowIso,
          metadata: {
            ...(job.metadata || {}),
            workflow_name: jobConfig.workflowName,
            workflow_binding: jobConfig.workflowBinding,
            workflow_instance_id: existingWorkflow.id,
            workflow_status: existingWorkflow.details || null,
            workflow_last_checked_at: nowIso,
          },
        });
        return {
          action: 'workflow_complete',
          workflow_instance_id: existingWorkflow.id,
          workflow_status: existingWorkflow.details || null,
        };
      }
    } catch (error) {
      job = {
        ...job,
        metadata: {
          ...(job.metadata || {}),
          workflow_status_check_error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // Redispatch ceiling: the workflow is not active/complete and would be
  // re-dispatched, but it has already been re-driven up to the limit. Finalize
  // it terminal instead of starting another poison cycle. The active/complete
  // syncs above already ran, so we only block a *fresh* dispatch here.
  if (options.blockRedispatch) {
    await patchJob(env, job.id, job.network, {
      status: 'dead_lettered',
      error:
        trimString(job.error) ||
        `dead-lettered after ${options.requeueAttempts || 0} recovery requeue attempts (poison workflow job)`,
      run_after: null,
      completed_at: nowIso,
      metadata: {
        ...(job.metadata || {}),
        requeue_attempts: options.requeueAttempts || 0,
        dead_letter_source: 'control-plane-recover-ceiling',
        dead_lettered_at: nowIso,
      },
    });
    return {
      action: 'dead_lettered',
      requeue_attempts: options.requeueAttempts || 0,
    };
  }

  const workflow = await dispatchWorkflowInstance(env, job, jobConfig);
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
  });
  return {
    action: 'workflow_redispatched',
    workflow_instance_id: workflow.id,
    workflow_status: workflow.details || null,
  };
}

export {
  isWorkflowBindingAvailable,
  isWorkflowRouteConfig,
  normalizeWorkflowStatus,
  loadWorkflowInstanceDetails,
  dispatchWorkflowInstance,
  requeueWorkflowJob,
  ACTIVE_WORKFLOW_STATUSES,
  SUCCESSFUL_WORKFLOW_STATUSES,
};

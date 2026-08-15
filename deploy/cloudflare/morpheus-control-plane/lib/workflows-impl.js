import { WorkflowEntrypoint } from '../workflow-runtime.mjs';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import { patchJob, loadJob } from './jobs.js';
import { callAppBackend } from './execution-plane.js';

function normalizeWorkflowVersion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.trunc(numeric);
}

function resolveWorkflowContext(payload, job, fallbackWorkflowId) {
  return {
    workflowId: trimString(payload.workflow_id || job?.metadata?.workflow_id || fallbackWorkflowId),
    workflowVersion: normalizeWorkflowVersion(
      payload.workflow_version || job?.metadata?.workflow_version || 1
    ),
    executionId: trimString(payload.execution_id || job?.metadata?.execution_id || job?.id || ''),
    legacyRoute:
      trimString(payload.legacy_route || job?.metadata?.legacy_route || job?.route || '') || null,
  };
}

export class CallbackBroadcastWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const jobId = trimString(payload.job_id || '');
    const network = trimString(payload.network) === 'mainnet' ? 'mainnet' : 'testnet';
    if (!jobId) {
      throw new Error('job_id is required');
    }

    const job = await step.do('load callback broadcast job', async () =>
      loadJob(this.env, jobId, network)
    );
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }
    const workflow = resolveWorkflowContext(payload, job, 'callback_broadcast');

    await step.do('mark callback broadcast processing', async () =>
      patchJob(this.env, jobId, network, {
        status: 'processing',
        error: null,
        started_at: job.started_at || new Date().toISOString(),
        metadata: {
          ...(job.metadata || {}),
          workflow_name: 'callback_broadcast',
          workflow_binding: 'CALLBACK_BROADCAST_WORKFLOW',
          workflow_runtime: 'cloudflare-workflows',
          workflow_id: workflow.workflowId,
          workflow_version: workflow.workflowVersion,
          execution_id: workflow.executionId,
          legacy_route: workflow.legacyRoute,
        },
      })
    );

    try {
      // CP-01: do NOT resolve or forward the Neo N3 signing WIF from the edge. The
      // app backend resolves the updater signer from its OWN env (neo-control-plane.ts
      // createNeoN3Account), so the control plane holds no signing key — keeping it off
      // the Cloudflare edge. (Full in-TEE signing is a separate follow-up.)
      const result = await step.do(
        'execute callback broadcast',
        {
          retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
        },
        async () =>
          callAppBackend(this.env, '/api/internal/control-plane/callback-broadcast', {
            ...(job.payload || {}),
            network,
            workflow_id: workflow.workflowId,
            workflow_version: workflow.workflowVersion,
            execution_id: workflow.executionId,
            legacy_route: workflow.legacyRoute,
          })
      );

      if (!result.ok) {
        throw new Error(
          trimString(result.body?.error || result.body?.message || '') ||
            `callback broadcast failed with status ${result.status}`
        );
      }

      await step.do('mark callback broadcast success', async () =>
        patchJob(this.env, jobId, network, {
          status: 'succeeded',
          result: result.body,
          error: null,
          completed_at: new Date().toISOString(),
          metadata: {
            ...(job.metadata || {}),
            backend_status: result.status,
            backend_url: result.backend_url,
            workflow_name: 'callback_broadcast',
            workflow_binding: 'CALLBACK_BROADCAST_WORKFLOW',
            workflow_runtime: 'cloudflare-workflows',
            workflow_id: workflow.workflowId,
            workflow_version: workflow.workflowVersion,
            execution_id: workflow.executionId,
            legacy_route: workflow.legacyRoute,
          },
        })
      );

      return {
        ok: true,
        workflow: workflow.workflowId || 'callback_broadcast',
        job_id: jobId,
        network,
        result: result.body,
      };
    } catch (error) {
      await step.do('mark callback broadcast failure', async () =>
        patchJob(this.env, jobId, network, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completed_at: new Date().toISOString(),
          metadata: {
            ...(job.metadata || {}),
            workflow_name: 'callback_broadcast',
            workflow_binding: 'CALLBACK_BROADCAST_WORKFLOW',
            workflow_runtime: 'cloudflare-workflows',
            workflow_id: workflow.workflowId,
            workflow_version: workflow.workflowVersion,
            execution_id: workflow.executionId,
            legacy_route: workflow.legacyRoute,
          },
        })
      );
      throw error;
    }
  }
}

export class AutomationExecuteWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const jobId = trimString(payload.job_id || '');
    const network = trimString(payload.network) === 'mainnet' ? 'mainnet' : 'testnet';
    if (!jobId) {
      throw new Error('job_id is required');
    }

    const job = await step.do('load automation execute job', async () =>
      loadJob(this.env, jobId, network)
    );
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }
    const workflow = resolveWorkflowContext(payload, job, 'automation_execute');

    await step.do('mark automation execute processing', async () =>
      patchJob(this.env, jobId, network, {
        status: 'processing',
        error: null,
        started_at: job.started_at || new Date().toISOString(),
        metadata: {
          ...(job.metadata || {}),
          workflow_name: 'automation_execute',
          workflow_binding: 'AUTOMATION_EXECUTE_WORKFLOW',
          workflow_runtime: 'cloudflare-workflows',
          workflow_id: workflow.workflowId,
          workflow_version: workflow.workflowVersion,
          execution_id: workflow.executionId,
          legacy_route: workflow.legacyRoute,
        },
      })
    );

    try {
      const automationId = trimString(job.payload?.automation_id || job.payload?.id || '');
      if (!automationId) {
        throw new Error('automation_id is required');
      }
      // CP-01: no edge-held signing key — the app backend resolves the updater signer
      // from its own env. Do not forward a WIF from the control plane.
      const result = await step.do(
        'execute automation queueing',
        {
          retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
        },
        async () =>
          callAppBackend(this.env, '/api/internal/control-plane/automation-execute', {
            automation_id: automationId,
            network,
            workflow_id: workflow.workflowId,
            workflow_version: workflow.workflowVersion,
            execution_id: workflow.executionId,
            legacy_route: workflow.legacyRoute,
          })
      );

      if (!result.ok) {
        throw new Error(
          trimString(result.body?.error || result.body?.message || '') ||
            `automation execute failed with status ${result.status}`
        );
      }

      await step.do('mark automation execute success', async () =>
        patchJob(this.env, jobId, network, {
          status: 'succeeded',
          result: result.body,
          error: null,
          completed_at: new Date().toISOString(),
          metadata: {
            ...(job.metadata || {}),
            backend_status: result.status,
            backend_url: result.backend_url,
            workflow_name: 'automation_execute',
            workflow_binding: 'AUTOMATION_EXECUTE_WORKFLOW',
            workflow_runtime: 'cloudflare-workflows',
            workflow_id: workflow.workflowId,
            workflow_version: workflow.workflowVersion,
            execution_id: workflow.executionId,
            legacy_route: workflow.legacyRoute,
          },
        })
      );

      return {
        ok: true,
        workflow: workflow.workflowId || 'automation_execute',
        job_id: jobId,
        network,
        result: result.body,
      };
    } catch (error) {
      await step.do('mark automation execute failure', async () =>
        patchJob(this.env, jobId, network, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completed_at: new Date().toISOString(),
          metadata: {
            ...(job.metadata || {}),
            workflow_name: 'automation_execute',
            workflow_binding: 'AUTOMATION_EXECUTE_WORKFLOW',
            workflow_runtime: 'cloudflare-workflows',
            workflow_id: workflow.workflowId,
            workflow_version: workflow.workflowVersion,
            execution_id: workflow.executionId,
            legacy_route: workflow.legacyRoute,
          },
        })
      );
      throw error;
    }
  }
}

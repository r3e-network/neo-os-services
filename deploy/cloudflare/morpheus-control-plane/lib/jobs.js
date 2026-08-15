import { trimString } from '@r3e-network/neo-os-services-shared/utils';

const REQUEUE_GRACE_MS = 60_000;

function normalizeJobStatus(value) {
  return trimString(value).toLowerCase();
}

async function insertJob(env, record) {
  const { supabaseFetch } = await import('./supabase.js');
  const response = await supabaseFetch(env, '/morpheus_control_plane_jobs', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(record),
  });
  if (!response.ok) {
    throw new Error(`job insert failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function patchJob(env, jobId, network, fields) {
  const { supabaseFetch } = await import('./supabase.js');
  const response = await supabaseFetch(
    env,
    `/morpheus_control_plane_jobs?id=eq.${jobId}&network=eq.${network}`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        ...fields,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`job patch failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : rows;
}

// Claim a queue message with an optimistic version check. The consumer first
// reads a row, so the PATCH must prove that both the status and updated_at are
// still the values it observed. PostgREST translates this into one conditional
// SQL UPDATE; concurrent consumers therefore cannot both receive a row back.
async function claimJob(env, job, fields) {
  const { supabaseFetch } = await import('./supabase.js');
  const jobId = trimString(job?.id);
  const network = trimString(job?.network);
  const status = normalizeJobStatus(job?.status);
  if (!jobId || !network || !status) return null;

  const updatedAt = trimString(job?.updated_at);
  const versionFilter = updatedAt
    ? `updated_at=eq.${encodeURIComponent(updatedAt)}`
    : 'updated_at=is.null';
  const response = await supabaseFetch(
    env,
    `/morpheus_control_plane_jobs?id=eq.${encodeURIComponent(jobId)}&network=eq.${encodeURIComponent(network)}&status=eq.${encodeURIComponent(status)}&${versionFilter}`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        ...fields,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`job claim failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function loadJob(env, jobId, network) {
  const { supabaseFetch } = await import('./supabase.js');
  const response = await supabaseFetch(
    env,
    `/morpheus_control_plane_jobs?id=eq.${jobId}&network=eq.${network}&select=*`
  );
  if (!response.ok) {
    throw new Error(`job fetch failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export { insertJob, patchJob, claimJob, loadJob, normalizeJobStatus, REQUEUE_GRACE_MS };

import { after } from 'next/server';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';

function resolveConfig() {
  const ingestingHost = trimString(process.env.MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST);
  const sourceToken = trimString(process.env.MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN);
  if (!ingestingHost || !sourceToken) return null;
  return {
    url: `https://${ingestingHost}`,
    sourceToken,
    timeoutMs: Math.max(Number(process.env.MORPHEUS_BETTERSTACK_LOG_TIMEOUT_MS || 2000), 250),
  };
}

async function postLog(record: Record<string, unknown>) {
  const config = resolveConfig();
  if (!config) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.sourceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        {
          dt: new Date().toISOString(),
          service: 'morpheus-web',
          ...record,
        },
      ]),
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function emitBetterStackOperationLog(record: Record<string, unknown>) {
  if (!resolveConfig()) return;
  try {
    after(async () => {
      await postLog(record);
    });
  } catch {
    void postLog(record);
  }
}

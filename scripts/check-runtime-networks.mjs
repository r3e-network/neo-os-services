import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  runtime: 'https://runtime.meshmini.app',
  oracle: 'https://oracle.meshmini.app',
  edge: 'https://edge.meshmini.app',
  web: 'https://www.morpheus-matrix.dev',
};

function baseUrl(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Runtime probe bases must be HTTPS origins (HTTP loopback allowed), without credentials or paths'
    );
  }
  return url.origin;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_body');
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 65536) {
        await reader.cancel();
        throw new Error('response_limit');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}

export async function probeRuntimeNetworks({
  origins = {},
  fetchImpl = fetch,
  timeoutMs = 8000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error('Invalid probe timeout');
  const bases = Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, value]) => [key, baseUrl(origins[key] ?? value)])
  );
  const routes = Object.entries(bases).flatMap(([surface, base]) =>
    ['mainnet', 'testnet'].map((network) => ({
      surface,
      network,
      url:
        surface === 'web'
          ? `${base}/api/runtime/health?network=${network}`
          : `${base}/${network}/health`,
    }))
  );
  const results = await Promise.all(
    routes.map(async (route) => {
      try {
        const response = await fetchImpl(route.url, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await readJson(response);
        const actualNetwork = typeof body?.network === 'string' ? body.network : null;
        const ready = body?.ready === true && (body?.status === undefined || body.status === 'ok');
        const ok = response.status === 200 && actualNetwork === route.network && ready;
        return {
          ...route,
          ok,
          status: response.status,
          actualNetwork,
          ready: typeof body?.ready === 'boolean' ? body.ready : null,
          reason: ok
            ? null
            : response.status !== 200
              ? 'http_not_200'
              : actualNetwork !== route.network
                ? 'network_mismatch_or_missing'
                : 'runtime_not_ready',
        };
      } catch {
        // Do not serialize transport exceptions: origin credentials, internal URLs,
        // and provider messages do not belong in operator evidence or CI logs.
        return {
          ...route,
          ok: false,
          status: null,
          actualNetwork: null,
          reason: 'transport_or_invalid_body',
        };
      }
    })
  );
  return {
    at: new Date().toISOString(),
    readOnly: true,
    ok: results.every((result) => result.ok),
    results,
  };
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  const args = process.argv.slice(2);
  const origins = {};
  let output;
  for (const argument of args) {
    const match = /^--(runtime|oracle|edge|web|output)=(.+)$/.exec(argument);
    if (!match)
      throw new Error(
        'Use --runtime=ORIGIN --oracle=ORIGIN --edge=ORIGIN --web=ORIGIN --output=PATH'
      );
    if (match[1] === 'output') output = match[2];
    else origins[match[1]] = match[2];
  }
  const report = { tlsVerified: true, ...(await probeRuntimeNetworks({ origins })) };
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Runtime network probe failed; check arguments and output path.');
    process.exitCode = 1;
  });
}

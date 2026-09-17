import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function loopbackOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Runtime upstreams must be explicit http://127.0.0.1:PORT origins');
  }
  return url.origin;
}

export function renderRuntimeNetworkGateway(template, { mainnet, testnet }) {
  const mainnetOrigin = loopbackOrigin(mainnet);
  const testnetOrigin = loopbackOrigin(testnet);
  if (mainnetOrigin === testnetOrigin)
    throw new Error('Two networks cannot share one single-network runtime listener');
  const upstream = 'proxy_pass http://127.0.0.1:8787';
  if (template.split(upstream).length !== 5 || template.includes('$morpheus_runtime_origin')) {
    throw new Error('Gateway template changed; review all upstream locations before rendering');
  }
  // Nginx receives numeric loopback origins; there is no runtime DNS resolver or
  // client-controlled upstream. Existing route and Cloudflare allowlists remain.
  const mapping =
    `# Generated only after both isolated loopback runtimes passed identity checks.\n` +
    `map $uri $morpheus_runtime_origin {\n` +
    `    default ${mainnetOrigin};\n` +
    `    ~^/testnet/ ${testnetOrigin};\n}\n\n`;
  return mapping + template.replaceAll(upstream, 'proxy_pass $morpheus_runtime_origin');
}

export async function verifyRuntimeUpstream(origin, network, fetchImpl = fetch) {
  const base = loopbackOrigin(origin);
  const response = await fetchImpl(`${base}/${network}/health`, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(8000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${network} runtime is not ready`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Runtime health body is missing');
  let bytes = 0,
    text = '';
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 65536) {
        await reader.cancel();
        throw new Error('Runtime health body exceeds limit');
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(text);
  if (
    body?.network !== network ||
    body?.ready !== true ||
    (body?.status !== undefined && body.status !== 'ok')
  ) {
    throw new Error(`${network} runtime identity or readiness is unverified`);
  }
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const match = /^--(mainnet|testnet|output)=(.+)$/.exec(argument);
      if (!match) throw new Error('Invalid arguments');
      return [match[1], match[2]];
    })
  );
  if (!args.output) throw new Error('An output file is required');
  const template = await readFile(
    new URL('../deploy/nitro/runtime-gateway.nginx.conf', import.meta.url),
    'utf8'
  );
  const rendered = renderRuntimeNetworkGateway(template, args);
  await verifyRuntimeUpstream(args.mainnet, 'mainnet');
  await verifyRuntimeUpstream(args.testnet, 'testnet');
  // Never overwrite an installed or previously reviewed file implicitly.
  await writeFile(args.output, rendered, { flag: 'wx', mode: 0o600 });
  console.log(
    'Verified both runtime identities and wrote candidate gateway; installation and nginx validation are separate.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      'Gateway preparation refused: verify isolated runtime listeners, arguments, and unused output path.'
    );
    process.exitCode = 1;
  });
}

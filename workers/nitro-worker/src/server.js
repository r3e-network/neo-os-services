import http from 'node:http';
import handler from './worker.js';

// Example: replace the console.error/console.log calls below with the shared
// structured logger:
// import { createLogger } from '@r3e-network/neo-os-services-shared/logger';
// const logger = createLogger({ service: 'nitro-worker' });
// logger.error('server error', { error: String(error?.message || error) });

const port = Number(process.env.PORT || process.env.NITROCORE_PORT || 8080);
const maxBodyBytes = Math.max(Number(process.env.WORKER_MAX_BODY_BYTES || 262144), 1024);

async function toRequest(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      throw new Error(`request body too large (max ${maxBodyBytes} bytes)`);
    }
    chunks.push(chunk);
  }
  const bodyBuffer = Buffer.concat(chunks);
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `0.0.0.0:${port}`;
  const url = `${protocol}://${host}${req.url || '/'}`;

  return new Request(url, {
    method: req.method,
    headers: new Headers(
      Object.entries(req.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) return value.map((item) => [key, item]);
        return value ? [[key, value]] : [];
      })
    ),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuffer,
  });
}

async function writeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const arrayBuffer = await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}

const server = http.createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const response = await handler(request);
    await writeResponse(res, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: message }));
  }
});

// Bound how long a client may take to send its headers/body so a slow-loris
// cannot pin a worker request slot open (Node defaults are 60s headers / 5min
// request). These cap request RECEIPT, not handler processing, so long in-TEE
// oracle/compute work (up to the ~30s upstream budget) is unaffected.
server.requestTimeout = Math.max(Number(process.env.WORKER_REQUEST_TIMEOUT_MS) || 35_000, 1000);
server.headersTimeout = Math.max(Number(process.env.WORKER_HEADERS_TIMEOUT_MS) || 10_000, 1000);
server.on('error', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'nitro-worker server error',
      error: String(error?.message || error),
    })
  );
});

// Process-level safety net: a single stray promise rejection would otherwise take
// the whole TEE enclave offline (Node terminates on unhandledRejection). Log and
// keep serving; on a truly uncaught exception the state is unknown, so log and
// exit non-zero for a clean re-provisioned restart.
process.on('unhandledRejection', (reason) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unhandledRejection',
      error: String(reason?.message || reason),
    })
  );
});
process.on('uncaughtException', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'uncaughtException',
      error: String(error?.message || error),
    })
  );
  process.exit(1);
});

// SECURITY (S15): bind loopback by default; expose the worker externally only
// when explicitly configured (NITROCORE_HOST=0.0.0.0) behind a controlled
// network/load balancer.
const listenHost =
  String(process.env.NITROCORE_HOST || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
server.listen(port, listenHost, () => {
  console.log(
    JSON.stringify({ level: 'info', msg: 'nitro-worker server listening', port, host: listenHost })
  );
});

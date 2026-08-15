import http from 'node:http';

import { renderPrometheusMetrics } from './prometheus.js';
import { loadRelayerState, snapshotMetrics } from './state.js';
import { trimString } from './lib/strings.js';

function buildMetricsPayload(stateFile) {
  return renderPrometheusMetrics(snapshotMetrics(loadRelayerState(stateFile)));
}

export function startMetricsServer(config, logger) {
  const host = trimString(config.metricsServer?.host || '127.0.0.1') || '127.0.0.1';
  const port = Math.max(Number(config.metricsServer?.port || 9464), 1);
  const metricsPath = trimString(config.metricsServer?.path || '/metrics') || '/metrics';
  const healthPath = '/healthz';

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${host}:${port}`);

    if (request.method === 'GET' && url.pathname === metricsPath) {
      try {
        const payload = buildMetricsPayload(config.stateFile);
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(payload);
      } catch (error) {
        logger.error({ error }, 'Failed to render relayer Prometheus metrics');
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('failed to render metrics\n');
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === healthPath) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(
        JSON.stringify({
          status: 'ok',
          service: 'morpheus-relayer-metrics',
          metrics_path: metricsPath,
        })
      );
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found\n');
  });

  server.listen(port, host, () => {
    logger.info(
      {
        host,
        port,
        metrics_path: metricsPath,
        health_path: healthPath,
      },
      'Started relayer metrics server'
    );
  });

  return server;
}

import { createRelayerConfig } from './config.js';
import { formatConfigDump, validateRelayerConfig } from './config-introspect.js';
import { createLogger } from './logger.js';
import { startMetricsServer } from './metrics-server.js';
import { renderPrometheusMetrics } from './prometheus.js';
import { runRelayerLoop, runRelayerOnce } from './relayer.js';
import { loadRelayerState, snapshotMetrics } from './state.js';

const mode = process.argv[2] || 'once';

// `config:validate` / `config:dump` are read-only operator introspection commands
// that must run even when the config is invalid (e.g. a missing required signer
// would otherwise throw while building). They are handled before the eager
// createRelayerConfig() build the runtime modes rely on.
if (mode === 'config:validate') {
  const result = validateRelayerConfig();
  // eslint-disable-next-line no-console -- cli output for config:validate mode
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} else if (mode === 'config:dump') {
  // eslint-disable-next-line no-console -- cli output for config:dump mode
  console.log(formatConfigDump());
} else {
  const config = createRelayerConfig();
  const logger = createLogger(config);

  // Process-level safety net for the long-running modes: a single stray promise
  // rejection or uncaught exception would otherwise terminate the relayer by
  // default (Node exits on unhandledRejection). Log rejections and keep the scan
  // loop alive; on a truly uncaught exception the process state is unknown, so
  // log and exit non-zero to let the orchestrator restart cleanly.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { error: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandledRejection'
    );
  });
  process.on('uncaughtException', (error) => {
    logger.error({ error }, 'uncaughtException');
    process.exit(1);
  });

  if (mode === 'loop') {
    await runRelayerLoop({ config, logger });
  } else if (mode === 'metrics') {
    const state = loadRelayerState(config.stateFile);
    // eslint-disable-next-line no-console -- cli output for metrics mode
    console.log(
      JSON.stringify({ state_file: config.stateFile, metrics: snapshotMetrics(state) }, null, 2)
    );
  } else if (mode === 'metrics:prom') {
    const state = loadRelayerState(config.stateFile);
    process.stdout.write(renderPrometheusMetrics(snapshotMetrics(state)));
  } else if (mode === 'serve:metrics') {
    startMetricsServer(config, logger);
  } else {
    const result = await runRelayerOnce({ config, logger });
    // eslint-disable-next-line no-console -- cli output for once mode
    console.log(JSON.stringify(result, null, 2));
  }
}

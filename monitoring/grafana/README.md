# Grafana Alloy / Relayer Metrics

Grafana Cloud is an optional secondary observability path. The default Morpheus operations stack should prefer Better Stack + Checkly + Sentry first.

Use Grafana only when you need deeper relayer metrics than heartbeats and uptime checks provide.

## Exposed Relayer Metrics

- metrics: `http://127.0.0.1:9464/metrics`
- health: `http://127.0.0.1:9464/healthz`

Start it manually:

```bash
npm run start:relayer:metrics
```

Or via systemd:

- [morpheus-relayer-metrics.service](../../deploy/systemd/morpheus-relayer-metrics.service)
- [grafana-alloy.service](../../deploy/systemd/grafana-alloy.service)

Template:

- [alloy.relayer.example.alloy](./alloy.relayer.example.alloy)

Required remote-write environment:

- `GRAFANA_CLOUD_PROMETHEUS_USERNAME`
- `GRAFANA_CLOUD_PROMETHEUS_API_KEY`

Optional:

- `GRAFANA_CLOUD_PROMETHEUS_PUSH_URL`

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  FEED_UNIT_PINNED_ENV,
  applySystemdServiceEnv,
  parseEnvFileAssignments,
  parseSystemdUnitText,
  reservedKeysPresent,
} from './lib-feed-network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readUnit(name) {
  return readFileSync(path.join(HERE, name), 'utf8');
}

const COPY_PASTED_ENV = {
  FEED_NETWORK: 'testnet',
  FEED_CHAINS: 'neox',
  SIGNER_URL: 'http://127.0.0.1:8787',
  PUSH_LOG: '/opt/morpheus/nitro/feed-pusher-testnet.log',
  PUSH_STATUS: '/opt/morpheus/nitro/feed-pusher-testnet-status.json',
  MISSING_STATE: '/opt/morpheus/nitro/feed-pusher-testnet-missing.json',
  PUSH_PROM_TEXTFILE: '/opt/morpheus/nitro/feed-pusher-testnet.prom',
  MONITOR_NETWORK: 'neo-n3-testnet',
  MONITOR_LOG: '/opt/morpheus/nitro/feed-monitor-testnet.log',
  MONITOR_STATUS: '/opt/morpheus/nitro/feed-status-testnet.json',
  MONITOR_PROM_TEXTFILE: '/opt/morpheus/nitro/feed-monitor-testnet.prom',
  FEED_TOPUP_ENV_FILE: '/opt/morpheus/nitro/feed-topup-testnet.env',
  TOPUP_LOG: '/opt/morpheus/nitro/feed-topup-testnet.log',
};

test('every feed unit pins reserved keys at exec time so EnvironmentFile cannot override them', () => {
  for (const [unit, expected] of Object.entries(FEED_UNIT_PINNED_ENV)) {
    const parsed = parseSystemdUnitText(readUnit(unit));
    assert.match(
      parsed.execStart,
      /^\/usr\/bin\/env /,
      `${unit} must pin via ExecStart=/usr/bin/env`
    );
    assert.match(parsed.execStart, /\/usr\/bin\/node /, `${unit} must still launch node`);
    assert.deepEqual(parsed.execEnv, { ...expected }, `${unit} exec pins`);
    const leftoverWinsWithoutWrapper = applySystemdServiceEnv({
      environment: parsed.environment,
      environmentFile: COPY_PASTED_ENV,
    });
    const processEnv = applySystemdServiceEnv({
      environment: parsed.environment,
      environmentFile: COPY_PASTED_ENV,
      execEnv: parsed.execEnv,
    });
    for (const [key, value] of Object.entries(expected)) {
      if (Object.hasOwn(COPY_PASTED_ENV, key) && COPY_PASTED_ENV[key] !== value) {
        assert.equal(
          leftoverWinsWithoutWrapper[key],
          COPY_PASTED_ENV[key],
          `${unit}: systemd EnvironmentFile must be able to override Environment=${key}`
        );
      }
      assert.equal(processEnv[key], value, `${unit}: leftover ${key} must not survive exec pin`);
    }
  }
});

test('mainnet feed units keep WorkingDirectory on the library dir', () => {
  for (const unit of [
    'morpheus-feed-pusher.service',
    'morpheus-feed-monitor.service',
    'morpheus-feed-pusher-neox.service',
    'morpheus-feed-topup.service',
  ]) {
    const text = readUnit(unit);
    assert.match(
      text,
      /^WorkingDirectory=\/opt\/neoos\/services\/deploy\/feed-pusher$/m,
      `${unit} must resolve lib-feed-network.mjs from the script directory`
    );
    assert.match(text, /lib-feed-network\.mjs/, `${unit} must name the shared library`);
  }
});

test('testnet pusher/monitor exec pins stay off every mainnet state path', () => {
  const pusher = parseSystemdUnitText(readUnit('morpheus-feed-pusher-testnet.service')).execEnv;
  const monitor = parseSystemdUnitText(readUnit('morpheus-feed-monitor-testnet.service')).execEnv;
  const mainnetPusher = FEED_UNIT_PINNED_ENV['morpheus-feed-pusher.service'];
  const mainnetMonitor = FEED_UNIT_PINNED_ENV['morpheus-feed-monitor.service'];
  assert.equal(pusher.FEED_NETWORK, 'testnet');
  assert.equal(monitor.FEED_NETWORK, 'testnet');
  assert.equal(pusher.SIGNER_URL, 'http://127.0.0.1:8789');
  assert.notEqual(pusher.PUSH_LOG, mainnetPusher.PUSH_LOG);
  assert.notEqual(pusher.PUSH_STATUS, mainnetPusher.PUSH_STATUS);
  assert.notEqual(pusher.MISSING_STATE, mainnetPusher.MISSING_STATE);
  assert.notEqual(pusher.PUSH_PROM_TEXTFILE, mainnetPusher.PUSH_PROM_TEXTFILE);
  assert.notEqual(monitor.MONITOR_LOG, mainnetMonitor.MONITOR_LOG);
  assert.notEqual(monitor.MONITOR_STATUS, mainnetMonitor.MONITOR_STATUS);
  assert.notEqual(monitor.MONITOR_PROM_TEXTFILE, mainnetMonitor.MONITOR_PROM_TEXTFILE);
  assert.notEqual(monitor.MONITOR_NETWORK, mainnetMonitor.MONITOR_NETWORK);
});

test('testnet Node writer units are disabled compatibility artifacts, not an enableable authority', () => {
  for (const unit of [
    'morpheus-feed-pusher-testnet.service',
    'morpheus-feed-pusher-testnet.timer',
  ]) {
    const text = readUnit(unit);
    assert.match(text, /COMPATIBILITY ONLY/, `${unit} must be labelled compatibility-only`);
    assert.match(
      text,
      /^ConditionPathExists=\/opt\/morpheus\/nitro\/ENABLE_NODE_FEED_PUSHER_COMPAT$/m,
      `${unit} must require the Node feed-pusher compatibility marker`
    );
    assert.match(
      text,
      /^Conflicts=.*\bmorpheus-relayer\.service\b.*\bmorpheus-relayer-nitro\.service\b/m,
      `${unit} must conflict with both Rust relayers`
    );
    assert.match(
      text,
      /^Before=.*\bmorpheus-relayer\.service\b.*\bmorpheus-relayer-nitro\.service\b/m,
      `${unit} must start before both Rust relayers`
    );
    assert.doesNotMatch(text, /^\[Install\]$/m, `${unit} must not be enableable`);
    assert.doesNotMatch(text, /^WantedBy=/m, `${unit} must not have an install target`);
  }
});

test('testnet pusher requires the TestNet signer and cannot inherit the live 8787 bridge', () => {
  const text = readUnit('morpheus-feed-pusher-testnet.service');
  const parsed = parseSystemdUnitText(text);
  assert.match(text, /^Requires=morpheus-nitro-signer-testnet\.service$/m);
  assert.match(text, /^After=.*morpheus-nitro-signer-testnet\.service/m);
  assert.doesNotMatch(text, /^After=.*\bmorpheus-nitro-signer\.service\b/m);
  assert.doesNotMatch(text, /^Requires=.*\bmorpheus-nitro-signer\.service\b/m);
  assert.equal(parsed.execEnv.SIGNER_URL, 'http://127.0.0.1:8789');
  const leftover = applySystemdServiceEnv({
    environmentFile: COPY_PASTED_ENV,
    execEnv: parsed.execEnv,
  });
  assert.equal(leftover.SIGNER_URL, 'http://127.0.0.1:8789');
  assert.notEqual(leftover.SIGNER_URL, COPY_PASTED_ENV.SIGNER_URL);
});

test('Neo X and mainnet N3 pusher units pin distinct state files and leftover env cannot collide them', () => {
  const n3 = parseSystemdUnitText(readUnit('morpheus-feed-pusher.service'));
  const neox = parseSystemdUnitText(readUnit('morpheus-feed-pusher-neox.service'));
  const leftoverN3 = {
    PUSH_LOG: '/opt/morpheus/nitro/feed-pusher.log',
    PUSH_STATUS: '/opt/morpheus/nitro/feed-pusher-status.json',
    MISSING_STATE: '/opt/morpheus/nitro/feed-pusher-missing.json',
    PUSH_PROM_TEXTFILE: '/opt/morpheus/nitro/feed-pusher-testnet.prom',
    FEED_NETWORK: 'testnet',
    FEED_CHAINS: 'neo-n3',
  };

  assert.equal(n3.execEnv.PUSH_LOG, '/opt/morpheus/nitro/feed-pusher.log');
  assert.equal(n3.execEnv.PUSH_STATUS, '/opt/morpheus/nitro/feed-pusher-status.json');
  assert.equal(n3.execEnv.MISSING_STATE, '/opt/morpheus/nitro/feed-pusher-missing.json');
  assert.equal(n3.execEnv.PUSH_PROM_TEXTFILE, '');
  assert.equal(n3.execEnv.FEED_CHAINS, 'neo-n3');

  assert.equal(neox.execEnv.PUSH_LOG, '/opt/morpheus/nitro/feed-pusher-neox.log');
  assert.equal(neox.execEnv.PUSH_STATUS, '/opt/morpheus/nitro/feed-pusher-neox-status.json');
  assert.equal(neox.execEnv.MISSING_STATE, '/opt/morpheus/nitro/feed-pusher-neox-missing.json');
  assert.equal(neox.execEnv.PUSH_PROM_TEXTFILE, '');
  assert.equal(neox.execEnv.FEED_CHAINS, 'neox');
  assert.notEqual(neox.execEnv.PUSH_LOG, n3.execEnv.PUSH_LOG);
  assert.notEqual(neox.execEnv.PUSH_STATUS, n3.execEnv.PUSH_STATUS);
  assert.notEqual(neox.execEnv.MISSING_STATE, n3.execEnv.MISSING_STATE);

  const n3Process = applySystemdServiceEnv({
    environmentFile: leftoverN3,
    execEnv: n3.execEnv,
  });
  const neoxProcess = applySystemdServiceEnv({
    environmentFile: leftoverN3,
    execEnv: neox.execEnv,
  });
  const neoxWithoutPin = applySystemdServiceEnv({
    environmentFile: leftoverN3,
  });
  assert.equal(n3Process.PUSH_LOG, n3.execEnv.PUSH_LOG);
  assert.equal(neoxProcess.PUSH_LOG, neox.execEnv.PUSH_LOG);
  assert.equal(neoxWithoutPin.PUSH_LOG, leftoverN3.PUSH_LOG);
  assert.notEqual(neoxProcess.PUSH_LOG, leftoverN3.PUSH_LOG);
  assert.notEqual(neoxProcess.PUSH_STATUS, leftoverN3.PUSH_STATUS);
  assert.notEqual(neoxProcess.MISSING_STATE, leftoverN3.MISSING_STATE);
  assert.deepEqual(n3.execEnv, FEED_UNIT_PINNED_ENV['morpheus-feed-pusher.service']);
  assert.deepEqual(neox.execEnv, FEED_UNIT_PINNED_ENV['morpheus-feed-pusher-neox.service']);
});

test('runbooks do not tell operators to glob-copy unit files or a single script', () => {
  const runbook = readFileSync(path.join(HERE, 'RUNBOOK.md'), 'utf8');
  const outage = readFileSync(path.join(HERE, 'FEED-OUTAGE-RUNBOOK.md'), 'utf8');
  for (const text of [runbook, outage]) {
    assert.doesNotMatch(text, /cp deploy\/feed-pusher\/morpheus-feed-\{/);
    assert.doesNotMatch(text, /copy the `\*\.service\/\*\.timer` files/);
  }
  assert.match(runbook, /lib-feed-network\.mjs/);
  assert.match(runbook, /\/usr\/bin\/env/);
  assert.match(runbook, /95\.216\.148\.60/);
  assert.match(runbook, /has no feed units/);
  assert.match(outage, /95\.216\.148\.60/);
  assert.match(outage, /not the feed/);
});

test('runbook install path matches unit WorkingDirectory and atomically includes lib-feed-network.mjs', () => {
  const canonical = '/opt/neoos/services/deploy/feed-pusher';
  const runbook = readFileSync(path.join(HERE, 'RUNBOOK.md'), 'utf8');
  const outage = readFileSync(path.join(HERE, 'FEED-OUTAGE-RUNBOOK.md'), 'utf8');
  for (const unit of [
    'morpheus-feed-pusher.service',
    'morpheus-feed-monitor.service',
    'morpheus-feed-pusher-neox.service',
    'morpheus-feed-topup.service',
    'morpheus-feed-pusher-testnet.service',
    'morpheus-feed-monitor-testnet.service',
  ]) {
    const text = readUnit(unit);
    assert.match(
      text,
      new RegExp(`^WorkingDirectory=${canonical.replace(/\//g, '\\/')}$`, 'm'),
      `${unit} WorkingDirectory must be ${canonical}`
    );
  }
  assert.match(runbook, /WorkingDirectory=\/opt\/neoos\/services\/deploy\/feed-pusher/);
  assert.match(runbook, /atomically|atomic install|one step/i);
  assert.match(runbook, /lib-feed-network\.mjs/);
  assert.match(runbook, /drop-in/);
  assert.doesNotMatch(
    runbook,
    /The table below is the\s+_intended_\s+layout[\s\S]*WorkingDirectory=\/opt\/morpheus\/neo-morpheus-oracle/
  );
  assert.match(outage, /WorkingDirectory=\/opt\/neoos\/services\/deploy\/feed-pusher/);
  assert.match(outage, /lib-feed-network\.mjs/);
  assert.match(outage, /drop-in/);
});

test('feed-pusher.env.example leaves reserved pins unset so copy-paste cannot collide', () => {
  const assigned = parseEnvFileAssignments(readFileSync(path.join(HERE, 'feed-pusher.env.example'), 'utf8'));
  assert.deepEqual(reservedKeysPresent(assigned), []);
});

test('feed-pusher directory ships the library next to every importer', () => {
  const names = new Set(readdirSync(HERE));
  assert.ok(names.has('lib-feed-network.mjs'));
  assert.ok(names.has('lib-feed-writer-metrics.mjs'));
  assert.ok(names.has('feed-pusher.mjs'));
  assert.ok(names.has('feed-monitor.mjs'));
  assert.ok(names.has('feed-topup.mjs'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runProfitAnchorTick } from './anchor-profit-scheduler.js';

const input = {
  network: 'testnet', appId: 'miniapp-profitanchor', currentAgentId: 'a', observationBlock: 7,
  candidates: [{ id: 'a', rewardPerNeo: 10, observedAt: 100 }, { id: 'b', rewardPerNeo: 20, observedAt: 100 }],
  policyOptions: { nowMs: 100, minImprovementBps: 1 },
};

test('scheduler uses a durable lease and records one idempotent execution', async () => {
  const applied = new Set(); let executed = 0; let released = 0;
  const store = {
    isApplied: async (key) => applied.has(key),
    acquireLease: async () => 'owner-1',
    isLeaseOwner: async () => true,
    recordApplied: async (key) => applied.add(key),
    releaseLease: async () => { released += 1; },
  };
  const first = await runProfitAnchorTick({ load: async () => input, store, execute: async (plan) => { executed += 1; return { txid: 'test' }; } });
  const second = await runProfitAnchorTick({ load: async () => input, store, execute: async () => { executed += 1; return {}; } });
  assert.equal(first.status, 'executed');
  assert.equal(second.status, 'already-applied');
  assert.equal(executed, 1);
  assert.equal(released, 1);
});

test('scheduler never accepts TrustAnchor as a profit policy target', async () => {
  await assert.rejects(() => runProfitAnchorTick({ load: async () => ({ ...input, appId: 'miniapp-trustanchor' }), store: {}, execute: async () => {} }), /restricted to ProfitAnchor/);
});

test('no-op never reaches the execution or durable mutation ports', async () => {
  const result = await runProfitAnchorTick({ load: async () => ({ ...input, currentAgentId: 'b' }),
    store: new Proxy({}, { get: () => assert.fail('no-op must not touch store') }),
    execute: async () => assert.fail('no-op must not execute') });
  assert.equal(result.status, 'no-op');
});

test('rechecks completion after lease acquisition to prevent duplicate execution', async () => {
  let applied = false;
  let released = 0;
  let executed = 0;
  const store = {
    isApplied: async () => applied,
    acquireLease: async () => { applied = true; return 'owner-1'; },
    recordApplied: async () => assert.fail('already applied'),
    releaseLease: async () => { released++; },
  };
  const result = await runProfitAnchorTick({ load: async () => input, store, execute: async () => { executed++; } });
  assert.equal(result.status, 'already-applied');
  assert.equal(executed, 0);
  assert.equal(released, 1);
});

test('does not execute when the in-lease completion read fails', async () => {
  let reads = 0;
  let released = 0;
  const store = {
    isApplied: async () => { if (++reads === 2) throw new Error('store unavailable'); return false; },
    acquireLease: async () => 'owner-1',
    recordApplied: async () => assert.fail('must not record'),
    releaseLease: async () => { released++; },
  };
  await assert.rejects(runProfitAnchorTick({ load: async () => input, store, execute: async () => assert.fail('must not execute') }), /store unavailable/);
  assert.equal(released, 1);
});

function fixtureStore(overrides = {}) {
  return {
    isApplied: async () => false,
    acquireLease: async () => 'owner-1',
    isLeaseOwner: async () => true,
    recordApplied: async () => {},
    releaseLease: async () => {},
    ...overrides,
  };
}

test('refreshes the plan under a pool-scoped lease and propagates ownership', async () => {
  let reads = 0;
  const calls = [];
  const context = { resourceKey: 'testnet:miniapp-profitanchor', lease: 'owner-1' };
  const result = await runProfitAnchorTick({
    load: async () => ({ ...input, observationBlock: ++reads === 1 ? 7 : 8 }),
    store: fixtureStore({
      acquireLease: async (key) => { assert.equal(key, context.resourceKey); return context.lease; },
      isLeaseOwner: async (...args) => { calls.push(['owner', ...args]); return true; },
      recordApplied: async (key, result, owner) => {
        assert.equal(key, 'testnet:miniapp-profitanchor:8:b');
        assert.deepEqual(owner, context);
        calls.push(['record']);
      },
      releaseLease: async (...args) => calls.push(['release', ...args]),
    }),
    execute: async (plan, owner) => {
      assert.equal(plan.observationBlock, 8);
      assert.deepEqual(owner, context);
      assert.equal(Object.isFrozen(owner), true);
      calls.push(['execute']);
      return { txid: 'test' };
    },
  });
  assert.equal(result.status, 'executed');
  assert.deepEqual(calls, [
    ['owner', context.resourceKey, context.lease], ['execute'], ['record'],
    ['release', context.resourceKey, context.lease],
  ]);
});

for (const [name, refresh, error] of [
  ['network drift', { network: 'mainnet' }, /resource changed/],
  ['block regression', { observationBlock: 6 }, /block regressed/],
  ['TrustAnchor drift', { appId: 'miniapp-trustanchor' }, /restricted/],
]) {
  test(`rejects ${name} before execution and releases only its own lease`, async () => {
    let reads = 0;
    let released = 0;
    await assert.rejects(runProfitAnchorTick({
      load: async () => ++reads === 1 ? input : { ...input, ...refresh },
      store: fixtureStore({
        recordApplied: async () => assert.fail('must not record'),
        releaseLease: async (key, token) => {
          assert.equal(key, 'testnet:miniapp-profitanchor');
          assert.equal(token, 'owner-1');
          released++;
        },
      }),
      execute: async () => assert.fail('must not execute'),
    }), error);
    assert.equal(released, 1);
  });
}

test('refreshed no-op does not execute', async () => {
  let reads = 0;
  const result = await runProfitAnchorTick({
    load: async () => ++reads === 1 ? input : { ...input, currentAgentId: 'b' },
    store: fixtureStore(), execute: async () => assert.fail('must not execute'),
  });
  assert.equal(result.status, 'no-op');
});

test('checks the refreshed idempotency key before execution', async () => {
  let reads = 0;
  const result = await runProfitAnchorTick({
    load: async () => ({ ...input, observationBlock: ++reads === 1 ? 7 : 8 }),
    store: fixtureStore({ isApplied: async (key) => key.includes(':8:') }),
    execute: async () => assert.fail('must not execute'),
  });
  assert.equal(result.status, 'already-applied');
});

test('lost lease refuses execution', async () => {
  await assert.rejects(runProfitAnchorTick({
    load: async () => input,
    store: fixtureStore({ isLeaseOwner: async () => false }),
    execute: async () => assert.fail('must not execute'),
  }), /ownership lost/);
});

test('legacy boolean leases fail closed', async () => {
  await assert.rejects(runProfitAnchorTick({
    load: async () => input,
    store: fixtureStore({ acquireLease: async () => true }),
    execute: async () => assert.fail('must not execute'),
  }), /ownership token/);
});

test('different observation blocks cannot execute concurrently for the same pool', async () => {
  let owner;
  let notifyEntered;
  let unblock;
  const entered = new Promise((resolve) => { notifyEntered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const store = fixtureStore({
    acquireLease: async (key) => {
      if (owner) return null;
      owner = key;
      return 'owner-1';
    },
    releaseLease: async () => { owner = null; },
  });
  const first = runProfitAnchorTick({ load: async () => input, store,
    execute: async () => { notifyEntered(); await blocked; return {}; } });
  await entered;
  try {
    const second = await runProfitAnchorTick({
      load: async () => ({ ...input, observationBlock: 8 }), store,
      execute: async () => assert.fail('concurrent execution'),
    });
    assert.equal(second.status, 'lease-held');
  } finally {
    unblock();
    await first;
  }
});

test('executor failure does not record completion and preserves owner on release', async () => {
  let released = false;
  await assert.rejects(runProfitAnchorTick({ load: async () => input,
    store: fixtureStore({
      recordApplied: async () => assert.fail('must not record'),
      releaseLease: async (key, token) => { assert.equal(token, 'owner-1'); released = true; },
    }), execute: async () => { throw new Error('signer refused'); },
  }), /signer refused/);
  assert.equal(released, true);
});

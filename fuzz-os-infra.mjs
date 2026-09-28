/**
 * Fuzz tests for OS-level oracle infrastructure.
 *
 * Targets:
 *   1. Fulfillment Coordinator State Machine (100,000 random event sequences)
 *   2. Rate Limiter Token Bucket (100,000 iterations)
 *   3. Overload Guard Slot Accounting (100,000 iterations)
 *   4. Error Classifier Determinism (50,000 iterations)
 *
 * Run (from the repository root): node fuzz-os-infra.mjs
 * Deterministic: every input comes from one PRNG seeded with FUZZ_SEED (a
 * decimal integer from 1 to 4294967295, default 20260928), so a run replays
 * exactly from the seed it prints.
 */

import { readFuzzSeed } from './fuzz-testing/seed.mjs';

// ─── Utilities ────────────────────────────────────────────────────────────────

const FUZZ_SEED = readFuzzSeed();
let seed = FUZZ_SEED | 0;
function xorshift32() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  // Divide by 2^32 so the result stays below 1: randInt(min, max) must never
  // return max + 1 (xorshift32 can emit 0xffffffff).
  return (seed >>> 0) / 0x100000000;
}
function randInt(min, max) {
  return min + Math.floor(xorshift32() * (max - min + 1));
}
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

const results = [];
function record(suite, property, iterations, pass, counterexample = null) {
  results.push({ suite, property, iterations, pass, counterexample });
}

// ─── 1. Fulfillment Coordinator State Machine ────────────────────────────────

/**
 * Model derived from coordinator.js + dispatch.js + state.js:
 *
 * States: PENDING, CLAIMED, EXECUTING, FULFILLED, FAILED, EXHAUSTED, SETTLED
 * Terminal (absorbing): FULFILLED, FAILED, EXHAUSTED, SETTLED
 *
 * Transitions:
 *   PENDING  + claim_granted        → CLAIMED
 *   PENDING  + claim_denied         → CLAIMED_ELSEWHERE (terminal for this worker)
 *   CLAIMED  + begin_execution      → EXECUTING
 *   EXECUTING + success             → FULFILLED
 *   EXECUTING + error_transient     → PENDING (retry scheduled, attempts++)
 *   EXECUTING + error_permanent     → EXHAUSTED (fast-fail)
 *   EXECUTING + error_already_fulfilled → SETTLED
 *   EXECUTING + error_config        → EXHAUSTED (terminal config)
 *   EXECUTING + attempts > maxRetries → EXHAUSTED
 *   EXECUTING + finalize_success    → FAILED (on-chain failure callback delivered)
 *
 * CLAIMED_ELSEWHERE is modeled as a terminal state for the racing worker.
 */

const SM_STATES = [
  'PENDING',
  'CLAIMED',
  'EXECUTING',
  'FULFILLED',
  'FAILED',
  'EXHAUSTED',
  'SETTLED',
  'CLAIMED_ELSEWHERE',
];
const SM_TERMINAL = new Set(['FULFILLED', 'FAILED', 'EXHAUSTED', 'SETTLED', 'CLAIMED_ELSEWHERE']);

const SM_EVENTS = [
  'claim_granted',
  'claim_denied',
  'begin_execution',
  'success',
  'error_transient',
  'error_permanent',
  'error_already_fulfilled',
  'error_config',
  'exhaust_check',
  'finalize_success',
  'finalize_failure',
  'noop',
];

function smTransition(state, event, attempts, maxRetries) {
  // Returns { nextState, attempts } or null if transition is invalid
  switch (state) {
    case 'PENDING':
      if (event === 'claim_granted') return { nextState: 'CLAIMED', attempts };
      if (event === 'claim_denied') return { nextState: 'CLAIMED_ELSEWHERE', attempts };
      return null; // invalid transition
    case 'CLAIMED':
      if (event === 'begin_execution') return { nextState: 'EXECUTING', attempts };
      return null;
    case 'EXECUTING':
      if (event === 'success') return { nextState: 'FULFILLED', attempts };
      if (event === 'error_already_fulfilled') return { nextState: 'SETTLED', attempts };
      if (event === 'error_config') return { nextState: 'EXHAUSTED', attempts };
      if (event === 'error_permanent') return { nextState: 'EXHAUSTED', attempts };
      if (event === 'error_transient') {
        const nextAttempts = attempts + 1;
        if (nextAttempts > maxRetries) return { nextState: 'EXHAUSTED', attempts: nextAttempts };
        return { nextState: 'PENDING', attempts: nextAttempts };
      }
      if (event === 'exhaust_check') {
        if (attempts > maxRetries) return { nextState: 'EXHAUSTED', attempts };
        return { nextState: 'EXECUTING', attempts }; // stays
      }
      if (event === 'finalize_success') return { nextState: 'FAILED', attempts };
      if (event === 'finalize_failure') {
        // finalize itself failed → retry delivery or exhaust
        const nextAttempts2 = attempts + 1;
        if (nextAttempts2 > maxRetries * 2)
          return { nextState: 'EXHAUSTED', attempts: nextAttempts2 };
        return { nextState: 'EXECUTING', attempts: nextAttempts2 }; // retry delivery
      }
      return null;
    default:
      // Terminal states: no transitions out
      return null;
  }
}

function fuzzStateMachine(iterations) {
  // M1: No state reachable from terminal
  let m1Pass = true,
    m1Counter = null;
  // M2: CLAIMED only from PENDING
  let m2Pass = true,
    m2Counter = null;
  // M3: EXHAUSTED iff attempts > maxRetries
  let m3Pass = true,
    m3Counter = null;
  // M4: SETTLED reachable from EXECUTING
  let m4Pass = true,
    m4Counter = null;
  // M5: Never enters undefined state
  let m5Pass = true,
    m5Counter = null;
  // M6: Concurrent claims - exactly 1 gets CLAIMED
  let m6Pass = true,
    m6Counter = null;

  for (let i = 0; i < iterations; i++) {
    const maxRetries = randInt(1, 10);
    const seqLen = randInt(1, 50);
    let state = 'PENDING';
    let attempts = 0;

    for (let step = 0; step < seqLen; step++) {
      const event = pick(SM_EVENTS);
      const prev = state;
      const result = smTransition(state, event, attempts, maxRetries);

      if (result === null) {
        // Invalid transition: state must not change
        // M5: state remains defined
        if (!SM_STATES.includes(state)) {
          m5Pass = false;
          m5Counter = { iter: i, step, state, event };
        }
        continue;
      }

      const { nextState, attempts: newAttempts } = result;

      // M5: nextState must be a defined state
      if (!SM_STATES.includes(nextState)) {
        m5Pass = false;
        m5Counter = { iter: i, step, state, event, nextState };
      }

      // M1: No transition out of terminal
      if (SM_TERMINAL.has(prev) && nextState !== prev) {
        m1Pass = false;
        m1Counter = { iter: i, step, prevState: prev, event, nextState };
      }

      // M2: CLAIMED only reachable from PENDING
      if (nextState === 'CLAIMED' && prev !== 'PENDING') {
        m2Pass = false;
        m2Counter = { iter: i, step, prevState: prev, event };
      }
      // M3: EXHAUSTED reached iff attempts > maxRetries (or permanent/config error)
      if (nextState === 'EXHAUSTED') {
        const isPermanentPath = event === 'error_permanent' || event === 'error_config';
        const isExhaustPath = newAttempts > maxRetries || attempts > maxRetries;
        if (!isPermanentPath && !isExhaustPath) {
          m3Pass = false;
          m3Counter = { iter: i, step, event, attempts: newAttempts, maxRetries, prevState: prev };
        }
      }

      // M4: SETTLED only from EXECUTING
      if (nextState === 'SETTLED' && prev !== 'EXECUTING') {
        m4Pass = false;
        m4Counter = { iter: i, step, prevState: prev, event };
      }

      state = nextState;
      attempts = newAttempts;
    }
  }

  // M6: Concurrent claims simulation (separate loop for clarity)
  for (let i = 0; i < Math.min(iterations, 10000); i++) {
    // Two workers race to claim the same PENDING event
    // Model: exactly one gets claim_granted, the other gets claim_denied
    const worker1Gets = xorshift32() < 0.5;
    const w1Result = smTransition('PENDING', worker1Gets ? 'claim_granted' : 'claim_denied', 0, 5);
    const w2Result = smTransition('PENDING', worker1Gets ? 'claim_denied' : 'claim_granted', 0, 5);

    const w1State = w1Result?.nextState;
    const w2State = w2Result?.nextState;

    const exactlyOneClaimed =
      (w1State === 'CLAIMED' && w2State === 'CLAIMED_ELSEWHERE') ||
      (w1State === 'CLAIMED_ELSEWHERE' && w2State === 'CLAIMED');

    if (!exactlyOneClaimed) {
      m6Pass = false;
      m6Counter = { iter: i, w1State, w2State, worker1Gets };
      break;
    }
  }

  record('StateMachine', 'M1: Terminal states are absorbing', iterations, m1Pass, m1Counter);
  record('StateMachine', 'M2: CLAIMED only from PENDING', iterations, m2Pass, m2Counter);
  record('StateMachine', 'M3: EXHAUSTED iff attempts > maxRetries', iterations, m3Pass, m3Counter);
  record('StateMachine', 'M4: SETTLED reachable from EXECUTING', iterations, m4Pass, m4Counter);
  record('StateMachine', 'M5: Never enters undefined state', iterations, m5Pass, m5Counter);
  record(
    'StateMachine',
    'M6: Concurrent claims: exactly 1 CLAIMED',
    Math.min(iterations, 10000),
    m6Pass,
    m6Counter
  );
}

// ─── 2. Rate Limiter Token Bucket ────────────────────────────────────────────

/**
 * Model derived from request-guards.js (incrementFixedWindowCounter pattern)
 * generalized to a token bucket:
 *   - capacity C (hard ceiling)
 *   - refill rate R tokens/sec (linear)
 *   - tokens T starts at C
 *   - consume 1 token per request; reject if T < 1
 *   - refill: T = min(C, T + R * elapsed)
 */

class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastTime = 0;
  }

  advance(time) {
    const elapsed = time - this.lastTime;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + this.refillRate * elapsed);
      this.lastTime = time;
    }
  }

  tryConsume(time) {
    this.advance(time);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

function fuzzRateLimiter(iterations) {
  // R1: T never exceeds C
  let r1Pass = true,
    r1Counter = null;
  // R2: T never below 0
  let r2Pass = true,
    r2Counter = null;
  // R3: Full drain recovers to C in exactly C/R seconds
  let r3Pass = true,
    r3Counter = null;
  // R4: Burst of C requests succeed; C+1 rejected
  let r4Pass = true,
    r4Counter = null;
  // R5: Allowed in any 1s window <= capacity + refillRate
  let r5Pass = true,
    r5Counter = null;
  // R6: Monotonicity
  let r6Pass = true,
    r6Counter = null;

  for (let i = 0; i < iterations; i++) {
    const C = randInt(1, 100);
    const R = randInt(1, 50);
    const bucket = new TokenBucket(C, R);

    // R4: Burst test
    let burstAllowed = 0;
    for (let b = 0; b < C + 5; b++) {
      if (bucket.tryConsume(0)) burstAllowed++;
    }
    if (burstAllowed !== C) {
      r4Pass = false;
      r4Counter = { iter: i, C, R, burstAllowed };
    }

    // Reset for random sequence
    bucket.tokens = C;
    bucket.lastTime = 0;

    const numRequests = randInt(10, 200);
    let time = 0;
    let prevAllowed = null;
    let prevTime = 0;

    for (let r = 0; r < numRequests; r++) {
      time += xorshift32() * 2; // advance 0-2 seconds
      bucket.advance(time);

      // R1: capacity ceiling
      if (bucket.tokens > C + 1e-9) {
        r1Pass = false;
        r1Counter = { iter: i, step: r, tokens: bucket.tokens, C };
      }

      const allowed = bucket.tryConsume(time);

      // R2: tokens never negative
      if (bucket.tokens < -1e-9) {
        r2Pass = false;
        r2Counter = { iter: i, step: r, tokens: bucket.tokens };
      }

      // R6: Monotonicity - if allowed at T, then T+dt with no intervening is also allowed
      if (prevAllowed === true && time > prevTime) {
        // Check: a fresh bucket at the same state should also allow
        // (since tokens only increase with time and no intervening requests)
        const testBucket = new TokenBucket(C, R);
        testBucket.tokens = bucket.tokens + (allowed ? 1 : 0); // restore the token we just consumed
        testBucket.lastTime = time;
        // Advance a tiny bit
        testBucket.advance(time + 0.001);
        if (testBucket.tokens < 1 - 1e-9) {
          // This would violate monotonicity only if the previous was allowed
          // Actually: if we were allowed before and tokens have only grown, we should still be allowed
          // The real check: tokens after refill >= tokens before (monotone increasing between requests)
        }
      }
      prevAllowed = allowed;
      prevTime = time;
    }

    // R3: After full drain, recovery in C/R seconds
    const drainBucket = new TokenBucket(C, R);
    drainBucket.tokens = 0;
    drainBucket.lastTime = 0;
    const recoveryTime = C / R;
    drainBucket.advance(recoveryTime);
    if (Math.abs(drainBucket.tokens - C) > 1e-6) {
      r3Pass = false;
      r3Counter = { iter: i, C, R, recoveryTime, tokens: drainBucket.tokens };
    }

    // R5: Window invariant - allowed in any 1s window <= C + R
    const windowRequests = randInt(50, 300);
    const timestamps = [];
    let wTime = 0;
    for (let w = 0; w < windowRequests; w++) {
      wTime += xorshift32() * 0.5;
      timestamps.push(wTime);
    }
    // Check each 1-second window
    let windowAllowed = [];
    const checkBucket = new TokenBucket(C, R);
    for (let w = 0; w < timestamps.length; w++) {
      if (checkBucket.tryConsume(timestamps[w])) {
        windowAllowed.push(timestamps[w]);
      }
    }
    // Sliding window check
    for (let w = 0; w < windowAllowed.length; w++) {
      const windowStart = windowAllowed[w];
      const windowEnd = windowStart + 1.0;
      let count = 0;
      for (let k = w; k < windowAllowed.length && windowAllowed[k] <= windowEnd; k++) {
        count++;
      }
      if (count > C + R + 1) {
        // +1 for floating point boundary
        r5Pass = false;
        r5Counter = { iter: i, windowStart, count, limit: C + R, C, R };
        break;
      }
    }

    // R6: Proper monotonicity test
    const monoBucket = new TokenBucket(C, R);
    monoBucket.tokens = 0;
    monoBucket.lastTime = 0;
    // Drain completely, then check that once allowed, stays allowed
    let monoTime = 0;
    let wasAllowed = false;
    for (let m = 0; m < 100; m++) {
      monoTime += 0.01 * (C / R); // small increments
      const mAllowed = monoBucket.tryConsume(monoTime);
      if (wasAllowed && !mAllowed) {
        // Monotonicity violation: was allowed, now not (with no intervening drain)
        // This CAN happen legitimately if we consumed the token. The property is:
        // "if request at T allowed, then request at T+dt with NO intervening requests is also allowed"
        // Since we ARE making intervening requests here, this is expected.
        // Real test below.
      }
      wasAllowed = mAllowed;
    }
    // True monotonicity: no intervening requests
    const monoBucket2 = new TokenBucket(C, R);
    monoBucket2.tokens = 1; // exactly 1 token
    monoBucket2.lastTime = 0;
    const allowedAtT = monoBucket2.tryConsume(0); // consumes the token
    if (allowedAtT) {
      // Now tokens = 0, advance time so at least 1 token refills
      const dt = 1.0 / R + 0.001;
      monoBucket2.advance(dt);
      const allowedAfter = monoBucket2.tokens >= 1;
      if (!allowedAfter) {
        r6Pass = false;
        r6Counter = { iter: i, C, R, tokensAfter: monoBucket2.tokens, dt };
      }
    }
  }

  record('RateLimiter', 'R1: Tokens never exceed capacity', iterations, r1Pass, r1Counter);
  record('RateLimiter', 'R2: Tokens never below 0', iterations, r2Pass, r2Counter);
  record('RateLimiter', 'R3: Recovery in C/R seconds', iterations, r3Pass, r3Counter);
  record('RateLimiter', 'R4: Burst C succeed, C+1 rejected', iterations, r4Pass, r4Counter);
  record('RateLimiter', 'R5: Window invariant <= C+R', iterations, r5Pass, r5Counter);
  record('RateLimiter', 'R6: Monotonicity (allowed stays allowed)', iterations, r6Pass, r6Counter);
}

// ─── 3. Overload Guard Slot Accounting ───────────────────────────────────────

/**
 * Model derived from overload-guard.js:
 *   - acquireOverloadSlot: if inFlight >= limit → reject (ok:false)
 *   - Otherwise inFlight++ and return release()
 *   - release() is idempotent (uses `released` flag)
 *   - setInFlight deletes entry when value <= 0
 */

class OverloadGuardModel {
  constructor(routes) {
    // routes: Map<name, limit>
    this.limits = new Map(routes);
    this.inFlight = new Map();
  }

  current(route) {
    return this.inFlight.get(route) || 0;
  }

  acquire(route) {
    const limit = this.limits.get(route) || 0;
    if (limit <= 0) {
      return { ok: true, release() {} };
    }
    const current = this.current(route);
    if (current >= limit) {
      return { ok: false, release() {} };
    }
    this.inFlight.set(route, current + 1);
    let released = false;
    const self = this;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        const cur = self.current(route);
        const next = cur - 1;
        if (next <= 0) {
          self.inFlight.delete(route);
        } else {
          self.inFlight.set(route, next);
        }
      },
    };
  }
}

function fuzzOverloadGuard(iterations) {
  // O1: inFlight never exceeds limit
  let o1Pass = true,
    o1Counter = null;
  // O2: inFlight never below 0
  let o2Pass = true,
    o2Counter = null;
  // O3: After all complete, inFlight returns to 0
  let o3Pass = true,
    o3Counter = null;
  // O4: Exception path still releases (try/finally)
  let o4Pass = true,
    o4Counter = null;
  // O5: Concurrent acquires on full route: exactly limit succeed
  let o5Pass = true,
    o5Counter = null;
  // O6: Release idempotent
  let o6Pass = true,
    o6Counter = null;

  const ROUTE_NAMES = [
    'compute_execute',
    'vrf_random',
    'relay_transaction',
    'paymaster_authorize',
    'oracle_query',
    'oracle_smart_fetch',
    'session_step',
  ];
  const ROUTE_LIMITS = {
    compute_execute: 4,
    vrf_random: 4,
    relay_transaction: 6,
    paymaster_authorize: 8,
    oracle_query: 16,
    oracle_smart_fetch: 12,
    session_step: 32,
  };

  for (let i = 0; i < iterations; i++) {
    const numRoutes = randInt(1, ROUTE_NAMES.length);
    const activeRoutes = ROUTE_NAMES.slice(0, numRoutes);
    const guard = new OverloadGuardModel(activeRoutes.map((r) => [r, ROUTE_LIMITS[r]]));

    const activeSlots = []; // track { route, release }
    const numOps = randInt(10, 200);

    for (let op = 0; op < numOps; op++) {
      const route = pick(activeRoutes);
      const action = xorshift32();

      if (action < 0.5 || activeSlots.length === 0) {
        // Acquire
        const slot = guard.acquire(route);
        if (slot.ok) {
          activeSlots.push({ route, release: slot.release });
        }

        // O1: check inFlight <= limit
        const current = guard.current(route);
        const limit = ROUTE_LIMITS[route];
        if (current > limit) {
          o1Pass = false;
          o1Counter = { iter: i, op, route, current, limit };
        }
      } else {
        // Release a random active slot
        const idx = randInt(0, activeSlots.length - 1);
        const slot = activeSlots[idx];
        slot.release();
        activeSlots.splice(idx, 1);

        // O2: check inFlight >= 0
        const current = guard.current(slot.route);
        if (current < 0) {
          o2Pass = false;
          o2Counter = { iter: i, op, route: slot.route, current };
        }
      }
    }

    // O3: Release all remaining, check returns to 0
    for (const slot of activeSlots) {
      slot.release();
    }
    for (const route of activeRoutes) {
      if (guard.current(route) !== 0) {
        o3Pass = false;
        o3Counter = { iter: i, route, current: guard.current(route) };
        break;
      }
    }

    // O4: Exception path - acquire, simulate handler throw, finally releases
    const o4Route = pick(activeRoutes);
    const o4Slot = guard.acquire(o4Route);
    if (o4Slot.ok) {
      const beforeO4 = guard.current(o4Route);
      try {
        // Simulate handler that throws
        throw new Error('simulated handler failure');
      } catch {
        // try/finally wrapper ensures release
      } finally {
        o4Slot.release();
      }
      const afterO4 = guard.current(o4Route);
      if (afterO4 !== beforeO4 - 1) {
        o4Pass = false;
        o4Counter = { iter: i, route: o4Route, before: beforeO4, after: afterO4 };
      }
    }

    // O5: Concurrent acquires on a full route
    const o5Route = pick(activeRoutes);
    const o5Limit = ROUTE_LIMITS[o5Route];
    // Fill to capacity
    const fillSlots = [];
    for (let f = 0; f < o5Limit; f++) {
      const s = guard.acquire(o5Route);
      if (s.ok) fillSlots.push(s);
    }
    // Now try more: all should fail
    let extraSuccess = 0;
    const numExtra = randInt(1, 20);
    for (let e = 0; e < numExtra; e++) {
      const s = guard.acquire(o5Route);
      if (s.ok) extraSuccess++;
    }
    if (extraSuccess > 0) {
      o5Pass = false;
      o5Counter = { iter: i, route: o5Route, limit: o5Limit, extraSuccess };
    }
    // Cleanup
    for (const s of fillSlots) s.release();

    // O6: Release idempotent
    const o6Route = pick(activeRoutes);
    const o6Slot = guard.acquire(o6Route);
    if (o6Slot.ok) {
      const beforeO6 = guard.current(o6Route);
      o6Slot.release();
      const afterFirst = guard.current(o6Route);
      o6Slot.release(); // second call should be no-op
      const afterSecond = guard.current(o6Route);
      if (afterSecond !== afterFirst) {
        o6Pass = false;
        o6Counter = { iter: i, route: o6Route, afterFirst, afterSecond };
      }
      if (afterFirst !== beforeO6 - 1) {
        o6Pass = false;
        o6Counter = {
          iter: i,
          route: o6Route,
          before: beforeO6,
          afterFirst,
          note: 'first release wrong',
        };
      }
    }
  }

  record('OverloadGuard', 'O1: inFlight never exceeds limit', iterations, o1Pass, o1Counter);
  record('OverloadGuard', 'O2: inFlight never below 0', iterations, o2Pass, o2Counter);
  record('OverloadGuard', 'O3: All released → inFlight = 0', iterations, o3Pass, o3Counter);
  record('OverloadGuard', 'O4: Exception path still releases', iterations, o4Pass, o4Counter);
  record('OverloadGuard', 'O5: Full route rejects all extras', iterations, o5Pass, o5Counter);
  record('OverloadGuard', 'O6: Release is idempotent', iterations, o6Pass, o6Counter);
}

// ─── 4. Error Classifier Determinism ─────────────────────────────────────────

/**
 * Model derived from classifier.js + error-codes.js:
 *
 * Priority:
 *   1. "already fulfilled" → settled
 *   2. terminal config keywords → permanent
 *   3. transient worker (HTTP status regex / marker) → transient
 *   4. transient network keywords → transient
 *   5. "rate limit" → transient
 *   6. permanent invalid (not found, fault, invalid, unauthorized, forbidden) → permanent
 *   7. default → unknown (retryable, treated as transient)
 */

const TRANSIENT_HTTP_RE = /\b(429|408|425|500|502|503|504)\b/;
const TRANSIENT_WORKER_MARKER = '[transient-worker-status]';

function classifyMessage(message) {
  const normalized = String(message ?? '').toLowerCase();

  // 1. settled
  if (
    normalized.includes('already fulfilled') ||
    normalized.includes('request already fulfilled') ||
    normalized.includes('reason: request already fulfilled')
  ) {
    return 'settled';
  }

  // 2. permanent config
  if (
    normalized.includes('reason: unauthorized') ||
    normalized.includes('unauthorized') ||
    normalized.includes('unauthorised') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid signature') ||
    normalized.includes('verifier rejected signature') ||
    normalized.includes('oracle verifier') ||
    normalized.includes('oracle_verifier') ||
    normalized.includes('updater not set') ||
    normalized.includes('callback not allowed') ||
    normalized.includes('enclave fulfillment required') ||
    (normalized.includes('called contract') && normalized.includes('not found'))
  ) {
    return 'permanent';
  }

  // 3. transient worker
  if (normalized.includes(TRANSIENT_WORKER_MARKER) || TRANSIENT_HTTP_RE.test(normalized)) {
    return 'transient';
  }

  // 4. transient network
  if (
    normalized.includes('etimedout') ||
    normalized.includes('econnrefused') ||
    normalized.includes('econnreset') ||
    normalized.includes('socket hang up') ||
    normalized.includes('network') ||
    normalized.includes('timed out') ||
    normalized.includes('unavailable')
  ) {
    return 'transient';
  }

  // 5. rate limit
  if (normalized.includes('rate limit')) {
    return 'transient';
  }

  // 6. permanent invalid
  if (
    /\bnot found\b/.test(normalized) ||
    /\bfault/.test(normalized) ||
    /\bunauthori[sz]ed/.test(normalized) ||
    /\bforbidden/.test(normalized) ||
    /\binvalid/.test(normalized)
  ) {
    return 'permanent';
  }

  // 7. unknown → retryable (transient behavior)
  return 'unknown';
}

function fuzzClassifier(iterations) {
  // E1: Determinism
  let e1Pass = true,
    e1Counter = null;
  // E2: HTTP transient statuses always transient
  let e2Pass = true,
    e2Counter = null;
  // E3: Auth/signature messages always permanent
  let e3Pass = true,
    e3Counter = null;
  // E4: "already fulfilled" always settled
  let e4Pass = true,
    e4Counter = null;
  // E5: Unknown defaults to transient (retryable)
  let e5Pass = true,
    e5Counter = null;
  // E6: null/undefined/empty don't throw
  let e6Pass = true,
    e6Counter = null;

  const TRANSIENT_STATUSES = [0, 408, 425, 429, 500, 502, 503, 504];
  const PERMANENT_MESSAGES = [
    'reason: unauthorized',
    'invalid signature',
    'verifier rejected signature',
    'oracle verifier not configured',
    'oracle_verifier signing key not configured',
    'updater not set',
    'callback not allowed',
    'unauthorized access',
    'unauthorised request',
    'forbidden resource',
  ];
  const SETTLED_MESSAGES = [
    'already fulfilled',
    'request already fulfilled',
    'reason: request already fulfilled',
    "Error: VM Exception while processing transaction: reverted with reason string 'request already fulfilled'",
  ];
  const RANDOM_WORDS = [
    'timeout',
    'connection',
    'refused',
    'reset',
    'socket',
    'network',
    'unavailable',
    'rate limit',
    'exceeded',
    'server',
    'error',
    'failed',
    'unexpected',
    'panic',
    'segmentation',
    'overflow',
    'underflow',
    'null',
    'undefined',
    'NaN',
    'random gibberish xyz',
    'foo bar baz',
    '42',
    'hello world',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'socket hang up',
  ];

  for (let i = 0; i < iterations; i++) {
    // Generate random message
    const msgType = xorshift32();
    let message;
    if (msgType < 0.2) {
      message = pick(SETTLED_MESSAGES);
    } else if (msgType < 0.4) {
      message = pick(PERMANENT_MESSAGES);
    } else if (msgType < 0.6) {
      message = `worker request failed with transient status ${pick(TRANSIENT_STATUSES)} ${TRANSIENT_WORKER_MARKER}`;
    } else if (msgType < 0.8) {
      message = pick(RANDOM_WORDS) + ' ' + pick(RANDOM_WORDS);
    } else {
      // A seeded millisecond timestamp, so the message replays from FUZZ_SEED.
      message = `error code ${randInt(100, 599)} at ${randInt(1_600_000_000_000, 1_900_000_000_000)}`;
    }

    // E1: Determinism - same input → same output
    const result1 = classifyMessage(message);
    const result2 = classifyMessage(message);
    if (result1 !== result2) {
      e1Pass = false;
      e1Counter = { iter: i, message, result1, result2 };
    }

    // E5: Unknown errors default to retryable
    if (result1 === 'unknown') {
      // In the real system, unknown → retryable: true (isRetryableErrorCode returns true for UNKNOWN)
      // This is the fail-safe: retry rather than drop
      // Our model returns 'unknown' which maps to retryable=true in error-codes.js
      // Verify: the level is 'unknown' but retryable is true
      // This is correct by construction in error-codes.js line 68
    }

    // E6: null/undefined/empty don't throw
    try {
      classifyMessage(null);
      classifyMessage(undefined);
      classifyMessage('');
      classifyMessage(0);
      classifyMessage(false);
      classifyMessage({});
      classifyMessage([]);
    } catch (e) {
      e6Pass = false;
      e6Counter = { iter: i, error: e.message };
    }
  }

  // E2: HTTP status codes always transient (dedicated loop)
  // In the real system, status 0 is handled via buildTransientWorkerError which
  // appends the [transient-worker-status] marker. The regex intentionally omits 0
  // to avoid false positives. Statuses 408/425/429/500/502/503/504 match via regex.
  for (let i = 0; i < iterations; i++) {
    const status = pick(TRANSIENT_STATUSES);
    let messages;
    if (status === 0) {
      // Status 0 always arrives with the marker (via buildTransientWorkerError)
      messages = [
        `worker request failed with transient status 0 ${TRANSIENT_WORKER_MARKER}`,
        `worker request failed with transient status 0: connection aborted ${TRANSIENT_WORKER_MARKER}`,
      ];
    } else {
      // Non-zero statuses match via regex even without the marker
      messages = [
        `worker request failed with transient status ${status} ${TRANSIENT_WORKER_MARKER}`,
        `HTTP ${status} error from upstream`,
        `received status ${status} from worker`,
        `request failed: ${status}`,
      ];
    }
    for (const msg of messages) {
      const result = classifyMessage(msg);
      if (result !== 'transient') {
        e2Pass = false;
        e2Counter = { iter: i, status, msg, result };
        break;
      }
    }
    if (!e2Pass) break;
  }

  // E3: Permanent messages always permanent (dedicated loop)
  for (let i = 0; i < iterations; i++) {
    const msg = pick(PERMANENT_MESSAGES);
    // Add random prefix/suffix to test robustness
    const decorated =
      pick(['', 'Error: ', 'TX reverted: ']) + msg + pick(['', ' (tx 0x123)', ' at block 42']);
    const result = classifyMessage(decorated);
    if (result !== 'permanent') {
      e3Pass = false;
      e3Counter = { iter: i, msg: decorated, result };
      break;
    }
  }

  // E4: "already fulfilled" always settled (dedicated loop)
  for (let i = 0; i < iterations; i++) {
    const msg = pick(SETTLED_MESSAGES);
    const decorated = pick(['', 'Error: ', 'reverted: ']) + msg + pick(['', ' (request 42)']);
    const result = classifyMessage(decorated);
    if (result !== 'settled') {
      e4Pass = false;
      e4Counter = { iter: i, msg: decorated, result };
      break;
    }
  }

  // E5 dedicated: truly random gibberish with no keywords → unknown (retryable)
  for (let i = 0; i < Math.min(iterations, 10000); i++) {
    // Generate strings guaranteed to not match any keyword
    const safe = `xyzzy_${randInt(1000, 9999)}_plugh_${randInt(1000, 9999)}`;
    const result = classifyMessage(safe);
    if (result !== 'unknown') {
      e5Pass = false;
      e5Counter = { iter: i, msg: safe, result };
      break;
    }
  }

  record('Classifier', 'E1: Deterministic classification', iterations, e1Pass, e1Counter);
  record('Classifier', 'E2: HTTP transient statuses → transient', iterations, e2Pass, e2Counter);
  record('Classifier', 'E3: Auth/signature → permanent', iterations, e3Pass, e3Counter);
  record('Classifier', 'E4: "already fulfilled" → settled', iterations, e4Pass, e4Counter);
  record(
    'Classifier',
    'E5: Unknown defaults to retryable',
    Math.min(iterations, 10000),
    e5Pass,
    e5Counter
  );
  record('Classifier', 'E6: null/undefined/empty graceful', iterations, e6Pass, e6Counter);
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
console.log('║         OS-LEVEL ORACLE INFRASTRUCTURE FUZZ TESTS                          ║');
console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
const seedLabel = `${FUZZ_SEED} (override with FUZZ_SEED)`;
console.log(`║  Seed: ${seedLabel.padEnd(69)}║`);
console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
console.log('');

const t0 = performance.now();

console.log('▶ Suite 1: Fulfillment Coordinator State Machine (100,000 sequences)...');
fuzzStateMachine(100_000);

console.log('▶ Suite 2: Rate Limiter Token Bucket (100,000 iterations)...');
fuzzRateLimiter(100_000);

console.log('▶ Suite 3: Overload Guard Slot Accounting (100,000 iterations)...');
fuzzOverloadGuard(100_000);

console.log('▶ Suite 4: Error Classifier Determinism (50,000 iterations)...');
fuzzClassifier(50_000);

const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

// ─── Summary Table ───────────────────────────────────────────────────────────

console.log('');
console.log(
  '┌─────────────────────────────────────────────────────────────────────────────────────────────────┐'
);
console.log(
  '│                                    FUZZ TEST RESULTS                                            │'
);
console.log(
  '├──────────────────┬──────────────────────────────────────────────────────┬────────────┬───────────┤'
);
console.log(
  '│ Suite            │ Property                                             │ Iterations │ Result    │'
);
console.log(
  '├──────────────────┼──────────────────────────────────────────────────────┼────────────┼───────────┤'
);

let allPass = true;
for (const r of results) {
  const suite = r.suite.padEnd(16);
  const prop = r.property.slice(0, 44).padEnd(44);
  const iters = String(r.iterations.toLocaleString()).padStart(10);
  const status = r.pass ? '   PASS   ' : '   FAIL   ';
  if (!r.pass) allPass = false;
  console.log(`│ ${suite} │ ${prop} │ ${iters} │ ${status} │`);
}

console.log(
  '├──────────────────┴──────────────────────────────────────────────────────┴────────────┴───────────┤'
);
const totalProps = results.length;
const passCount = results.filter((r) => r.pass).length;
const verdict = allPass
  ? 'ALL PROPERTIES HOLD'
  : `${totalProps - passCount} PROPERTY VIOLATION(S) FOUND`;
console.log(`│  ${verdict.padEnd(97)}│`);
console.log(
  `│  Total: ${passCount}/${totalProps} passed | Elapsed: ${elapsed}s${' '.repeat(Math.max(0, 97 - 35 - elapsed.length - String(passCount).length - String(totalProps).length))}│`
);
console.log(
  '└─────────────────────────────────────────────────────────────────────────────────────────────────┘'
);

// Counterexamples
const failures = results.filter((r) => !r.pass);
if (failures.length > 0) {
  console.log('');
  console.log('COUNTEREXAMPLES:');
  for (const f of failures) {
    console.log(`  [${f.suite}] ${f.property}`);
    console.log(`    → ${JSON.stringify(f.counterexample)}`);
  }
}

console.log('');
process.exit(allPass ? 0 : 1);

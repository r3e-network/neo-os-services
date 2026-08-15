import { env, json, trimString } from './core.js';
import { resolveRouteName as normalizeRouteName } from '../capabilities.js';

const inFlightByRoute = new Map();

function defaultLimit(routeName) {
  switch (routeName) {
    case 'compute_execute':
      return 4;
    case 'vrf_random':
      return 4;
    case 'relay_transaction':
      return 6;
    case 'paymaster_authorize':
      return 8;
    case 'neodid_recovery_ticket':
      return 4;
    case 'neodid_bind':
      return 6;
    case 'neodid_action_ticket':
      return 6;
    case 'neodid_zklogin_ticket':
      return 6;
    case 'oracle_feed':
      return 0;
    case 'oracle_smart_fetch':
      return 12;
    case 'oracle_query':
      return 16;
    case 'txproxy_invoke':
      return 12;
    case 'session_start':
      return 8;
    case 'session_step':
      return 32;
    case 'session_finalize':
      return 8;
    default:
      return 0;
  }
}

function resolveLimit(routeName) {
  if (!routeName) return 0;
  const explicit = Number(
    env(`MORPHEUS_MAX_INFLIGHT_${routeName.toUpperCase()}`) || defaultLimit(routeName)
  );
  return Number.isFinite(explicit) ? Math.max(Math.trunc(explicit), 0) : 0;
}

function currentInFlight(routeName) {
  return Number(inFlightByRoute.get(routeName) || 0);
}

function setInFlight(routeName, value) {
  if (value <= 0) {
    inFlightByRoute.delete(routeName);
    return;
  }
  inFlightByRoute.set(routeName, value);
}

export function snapshotOverloadState() {
  return Object.fromEntries([...inFlightByRoute.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function acquireOverloadSlot(pathname = '', payload = {}) {
  // Resolve with the payload so action-routed requests share the in-flight cap
  // of the capability the dispatcher will execute.
  const routeName = normalizeRouteName(trimString(pathname), payload);
  const limit = resolveLimit(routeName);
  if (!routeName || limit <= 0) {
    return {
      ok: true,
      routeName,
      limit,
      inFlight: currentInFlight(routeName),
      release() {},
    };
  }

  const inFlight = currentInFlight(routeName);
  if (inFlight >= limit) {
    return {
      ok: false,
      routeName,
      limit,
      inFlight,
      response: json(
        503,
        {
          error: 'overloaded',
          route: routeName,
          limit,
          in_flight: inFlight,
        },
        { 'retry-after': '1' }
      ),
      release() {},
    };
  }

  setInFlight(routeName, inFlight + 1);
  let released = false;
  return {
    ok: true,
    routeName,
    limit,
    inFlight: inFlight + 1,
    release() {
      if (released) return;
      released = true;
      setInFlight(routeName, currentInFlight(routeName) - 1);
    },
  };
}

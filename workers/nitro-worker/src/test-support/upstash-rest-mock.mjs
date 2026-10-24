export function createUpstashRestMock({ fallback = null } = {}) {
  const originalFetch = global.fetch;
  const store = new Map();
  const expiry = new Map();
  const commands = [];
  let failure = '';

  function purge(key) {
    const expiresAt = expiry.get(key);
    if (typeof expiresAt === 'number' && expiresAt <= Date.now()) {
      store.delete(key);
      expiry.delete(key);
    }
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function execute(entry) {
    const [operation, ...rest] = entry;
    const op = String(operation).toUpperCase();
    const key = op === 'EVAL' ? rest[2] : rest[0];
    commands.push({ op, key, entry });
    purge(key);
    switch (op) {
      case 'GET':
        return { result: store.get(key) ?? null };
      case 'SET': {
        const value = rest[1];
        const options = rest.slice(2).map((item) => String(item).toUpperCase());
        if (options.includes('NX') && store.has(key)) return { result: null };
        store.set(key, String(value));
        const px = options.indexOf('PX');
        if (px >= 0) expiry.set(key, Date.now() + Number(rest[px + 2]));
        return { result: 'OK' };
      }
      case 'DEL': {
        const existed = store.delete(key);
        expiry.delete(key);
        return { result: existed ? 1 : 0 };
      }
      case 'INCR': {
        const next = Number(store.get(key) || 0) + 1;
        store.set(key, String(next));
        return { result: next };
      }
      case 'PTTL':
        return { result: expiry.has(key) ? Math.max(expiry.get(key) - Date.now(), 0) : -1 };
      case 'PEXPIRE':
        expiry.set(key, Date.now() + Number(rest[1]));
        return { result: 1 };
      case 'EVAL': {
        const script = String(rest[0]);
        if (script.includes("local value = redis.call('GET', KEYS[1])")) {
          const value = store.get(key) ?? null;
          if (value !== null) {
            store.delete(key);
            expiry.delete(key);
          }
          return { result: value };
        }
        if (script.includes('ARGV[1]')) {
          if (store.get(key) !== rest[3]) return { result: 0 };
          store.delete(key);
          expiry.delete(key);
          return { result: 1 };
        }
        throw new Error('unsupported EVAL script');
      }
      default:
        throw new Error(`unsupported Upstash operation ${op}`);
    }
  }

  return {
    store,
    commands,
    install() {
      global.fetch = async (url, init = {}) => {
        const value = String(url);
        if (!value.startsWith('https://mock-upstash.example.com')) {
          if (fallback) return fallback(url, init);
          throw new Error(`unexpected fetch ${value}`);
        }
        if (failure) {
          const message = failure;
          failure = '';
          return json({ error: message }, 500);
        }
        const parsed = new URL(value);
        if (parsed.pathname === '/pipeline') {
          return json(JSON.parse(String(init.body || '[]')).map(execute));
        }
        const [, command, ...segments] = parsed.pathname.split('/');
        if (command === 'get') {
          const key = decodeURIComponent(segments.join('/'));
          purge(key);
          return json({ result: store.get(key) ?? null });
        }
        throw new Error(`unsupported Upstash path ${parsed.pathname}`);
      };
    },
    restore() {
      global.fetch = originalFetch;
    },
    clear() {
      store.clear();
      expiry.clear();
      commands.length = 0;
      failure = '';
    },
    putJson(key, value, ttlMs = 60_000) {
      store.set(key, JSON.stringify(value));
      expiry.set(key, Date.now() + ttlMs);
    },
    getJson(key) {
      purge(key);
      const value = store.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    expire(key) {
      store.delete(key);
      expiry.delete(key);
    },
    failNext(message = 'injected storage failure') {
      failure = message;
    },
  };
}

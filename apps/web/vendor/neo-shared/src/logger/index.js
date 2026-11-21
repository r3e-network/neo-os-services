// @ts-check
/**
 * @fileoverview Dependency-free structured logger for the Neo Morpheus Oracle
 * monorepo. Emits JSON records by default and supports a human-readable pretty
 * mode via `LOG_PRETTY=1` or the `format` option. Supports level filtering,
 * child loggers, arbitrary metadata, and pluggable transports/redaction so the
 * same interface can run in web, worker, and script contexts without external
 * dependencies.
 */

const LEVELS = Object.freeze({
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
});

const DEFAULT_OPTIONS = Object.freeze({
  level: 'info',
  format: 'json',
  namespace: 'app',
  maxDepth: 8,
  maxNodes: 1000,
});

/**
 * Returns true for plain objects (not arrays, null, or class instances).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/**
 * Best-effort env reader that works in Node and avoids throwing in browser/edge
 * runtimes where `process` may be undefined.
 * @param {string} key
 * @returns {string | undefined}
 */
function readEnv(key) {
  try {
    if (typeof process !== 'undefined' && process.env && typeof process.env[key] === 'string') {
      return process.env[key];
    }
  } catch {
    // no-op: env is unavailable in some runtimes.
  }
  return undefined;
}

function trimString(value) {
  return String(value || '').trim();
}

function resolveLevel(options) {
  const raw = options.level ?? readEnv('LOG_LEVEL') ?? DEFAULT_OPTIONS.level;
  return trimString(raw).toLowerCase() || DEFAULT_OPTIONS.level;
}

function resolveFormat(options) {
  const raw = options.format ?? readEnv('LOG_FORMAT') ?? DEFAULT_OPTIONS.format;
  if (readEnv('LOG_PRETTY') === '1') return 'pretty';
  return trimString(raw).toLowerCase() || DEFAULT_OPTIONS.format;
}

function resolveNamespace(options) {
  return trimString(
    options.service || options.namespace || readEnv('SERVICE_NAME') || DEFAULT_OPTIONS.namespace
  );
}

function resolveMaxDepth(options) {
  const n = Number(options.maxDepth);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OPTIONS.maxDepth;
}

function resolveMaxNodes(options) {
  const n = Number(options.maxNodes);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OPTIONS.maxNodes;
}

function shouldLog(currentLevel, configuredLevel) {
  const currentPriority = LEVELS[currentLevel];
  const configuredPriority = LEVELS[configuredLevel];
  if (typeof currentPriority !== 'number' || typeof configuredPriority !== 'number') return false;
  return currentPriority >= configuredPriority;
}

/**
 * Supports both pino-style signatures:
 *   logger.info('message', { extra: 'fields' })
 *   logger.info({ extra: 'fields' }, 'message')
 * @param {unknown} first
 * @param {unknown} second
 * @param {string} level
 * @returns {{ message: string, fields: Record<string, unknown> }}
 */
function parseArgs(first, second, level) {
  if (typeof first === 'string') {
    return {
      message: first,
      fields: second && typeof second === 'object' && !Array.isArray(second) ? { ...second } : {},
    };
  }

  if (first && typeof first === 'object') {
    const message =
      typeof second === 'string'
        ? second
        : typeof first.message === 'string'
          ? first.message
          : typeof first.msg === 'string'
            ? first.msg
            : level;
    return { message, fields: { ...first } };
  }

  if (first === undefined || first === null) {
    return { message: level, fields: {} };
  }

  return {
    message: String(first),
    fields: second && typeof second === 'object' && !Array.isArray(second) ? { ...second } : {},
  };
}

function shouldRedactKey(key, redactKeys) {
  if (!Array.isArray(redactKeys)) return false;
  for (const rule of redactKeys) {
    if (typeof rule === 'string' && key === rule) return true;
    if (rule instanceof RegExp && rule.test(key)) return true;
    if (typeof rule === 'function' && rule(key)) return true;
  }
  return false;
}

/**
 * Deep-walks plain objects/arrays and applies redaction. Bounds the cost of
 * walking arbitrarily nested or large payloads so a single log call cannot
 * blow the stack or stall on a pathological structure.
 * @param {unknown} value
 * @param {{ redactKeys: unknown[], redactor?: function, maxDepth: number, maxNodes: number }} options
 * @param {number} depth
 * @param {{ count: number }} counter
 * @returns {unknown}
 */
function deepRedact(value, options, depth = 0, counter = null) {
  if (!counter) counter = { count: 0 };
  if (counter.count >= options.maxNodes || depth > options.maxDepth) {
    return '[redacted-truncated]';
  }
  counter.count += 1;

  if (typeof value === 'string') {
    return options.redactor ? options.redactor(value) : value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: options.redactor ? options.redactor(value.message) : value.message,
      stack: options.redactor ? options.redactor(value.stack) : value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, options, depth + 1, counter));
  }

  if (isPlainObject(value)) {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (shouldRedactKey(key, options.redactKeys)) {
        result[key] = '[redacted]';
      } else {
        result[key] = deepRedact(nested, options, depth + 1, counter);
      }
    }
    return result;
  }

  return value;
}

function buildRecord(level, message, fields, namespace, service) {
  const context = service || namespace || 'app';
  return {
    ...fields,
    timestamp: new Date().toISOString(),
    namespace: context,
    service: context,
    level,
    message,
  };
}

function normalizeTransports(transports, format) {
  if (transports === undefined || transports === null) {
    return [createConsoleTransport(format)];
  }
  if (typeof transports === 'function') return [transports];
  if (Array.isArray(transports)) {
    return transports.filter((transport) => typeof transport === 'function');
  }
  return [createConsoleTransport(format)];
}

/**
 * Default console transport. JSON mode prints a single JSON line; pretty mode
 * prints a human-readable line with a compact extra-field suffix.
 * @param {string} format
 * @returns {function(import('./index.d.ts').LogRecord): void}
 */
export function createConsoleTransport(format = 'json') {
  return (record) => {
    if (format === 'pretty') {
      const { timestamp, level, namespace, service, message, ...rest } = record;
      const context = namespace || service || 'app';
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      // eslint-disable-next-line no-console -- logger transport writes to stdout
      console.log(
        `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${context} — ${message}${extra}`
      );
    } else {
      // eslint-disable-next-line no-console -- logger transport writes to stdout
      console.log(JSON.stringify(record));
    }
  };
}

/**
 * Creates a structured logger.
 * @param {import('./index.d.ts').LoggerOptions} options
 * @returns {import('./index.d.ts').Logger}
 */
export function createLogger(options = {}) {
  const namespace = resolveNamespace(options);
  const configuredLevel = resolveLevel(options);
  const format = resolveFormat(options);
  const baseFields =
    options.baseFields && typeof options.baseFields === 'object' ? { ...options.baseFields } : {};
  const redactOptions = {
    redactKeys: Array.isArray(options.redactKeys) ? options.redactKeys : [],
    redactor: typeof options.redactor === 'function' ? options.redactor : undefined,
    maxDepth: resolveMaxDepth(options),
    maxNodes: resolveMaxNodes(options),
  };
  const transports = normalizeTransports(options.transports, format);

  /**
   * @param {string} level
   * @param {unknown} first
   * @param {unknown} second
   */
  function log(level, first, second) {
    if (!shouldLog(level, configuredLevel)) return;
    const { message, fields } = parseArgs(first, second, level);
    const mergedFields = { ...baseFields, ...fields };
    const record = buildRecord(level, message, mergedFields, namespace, options.service);
    const redactedRecord = deepRedact(record, redactOptions);
    for (const transport of transports) {
      transport(redactedRecord, format);
    }
  }

  return {
    trace: (first, second) => log('trace', first, second),
    debug: (first, second) => log('debug', first, second),
    info: (first, second) => log('info', first, second),
    warn: (first, second) => log('warn', first, second),
    error: (first, second) => log('error', first, second),
    fatal: (first, second) => log('fatal', first, second),
    child(childFields) {
      const mergedChildFields =
        childFields && typeof childFields === 'object' ? { ...childFields } : {};
      return createLogger({
        ...options,
        namespace,
        service: options.service,
        level: configuredLevel,
        format,
        baseFields: { ...baseFields, ...mergedChildFields },
      });
    },
  };
}

export { LEVELS };

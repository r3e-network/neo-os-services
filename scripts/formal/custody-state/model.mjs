// Abstract protocol model. This file does not execute or verify Rust code.
import { finiteEncoding } from './smt-lib.mjs';
export const PHASES = [
  'sealed',
  'restored',
  'ready',
  'prepared',
  'uploaded',
  'awaiting',
  'acknowledged',
];
export const ACTIONS = [
  'idle',
  'restore',
  'acquire',
  'expire',
  'prepare-sign',
  'prepare-revoke',
  'upload',
  'submit',
  'remote-commit',
  'timeout',
  'receive-receipt',
  'release',
  'cache-release',
  'crash',
  'client-cancel',
  'reject-receipt',
  'reject-stale-acquire',
  'finish-revoke',
];
export const MUTATIONS = [
  'none',
  'early-release',
  'stale-restore-admission',
  'inexact-receipt',
  'omit-audit',
  'omit-fencing',
  'rewind-generation',
  'rewind-snapshot-fence',
];

const and = (...items) => (items.length ? `(and ${items.join(' ')})` : 'true');
const or = (...items) => (items.length ? `(or ${items.join(' ')})` : 'false');
const eq = (a, b) => `(= ${a} ${b})`;
const not = (a) => `(not ${a})`;
const ite = (c, a, b) => `(ite ${c} ${a} ${b})`;
const add = (a, b = 1) => `(+ ${a} ${b})`;
const select = (a, k) => `(select ${a} ${k})`;
const store = (a, k, v) => `(store ${a} ${k} ${v})`;

const GLOBALS = {
  generation: 'Int',
  hash: 'Int',
  owner: 'Int',
  epoch: 'Int',
  snapshotFence: 'Int',
  lease: 'Bool',
  authorized: 'Bool',
  result0: 'Int',
  result1: 'Int',
  audit0: 'Bool',
  audit1: 'Bool',
  spent0: 'Bool',
  spent1: 'Bool',
  slot: 'Int',
  released0: 'Int',
  released1: 'Int',
  badRelease: 'Bool',
  badCache: 'Bool',
  badAdmission: 'Bool',
  badLedger: 'Bool',
  badFencing: 'Bool',
  badMonotonicity: 'Bool',
  badSnapshotFencing: 'Bool',
  badRequestBinding: 'Bool',
  sawTimeoutRecovery: 'Bool',
  sawLateCommit: 'Bool',
  sawCrashCommitted: 'Bool',
  sawRejectedReceipt: 'Bool',
  sawRejectedRestore: 'Bool',
  sawCache: 'Bool',
  sawCancelledCommit: 'Bool',
  sawTakeover: 'Bool',
  sawSnapshotTakeover: 'Bool',
};
const LOCAL = {
  phase: 'Int',
  generation: 'Int',
  hash: 'Int',
  epoch: 'Int',
  snapshotFence: 'Int',
  authorized: 'Bool',
  result0: 'Int',
  result1: 'Int',
  audit0: 'Bool',
  audit1: 'Bool',
  spent0: 'Bool',
  spent1: 'Bool',
  slot: 'Int',
  pending: 'Int',
  receipt: 'Int',
  timedOut: 'Bool',
  cancelled: 'Bool',
};
const OBJECTS = {
  exists: 'Bool',
  uploaded: 'Bool',
  submitted: 'Bool',
  committed: 'Bool',
  previousGeneration: 'Int',
  previousHash: 'Int',
  owner: 'Int',
  epoch: 'Int',
  snapshotFence: 'Int',
  previousSnapshotFence: 'Int',
  authorized: 'Bool',
  result0: 'Int',
  result1: 'Int',
  audit0: 'Bool',
  audit1: 'Bool',
  spent0: 'Bool',
  spent1: 'Bool',
  slot: 'Int',
  kind: 'Int',
  request: 'Int',
  digest: 'Int',
};
const mutableObjectFields = ['uploaded', 'submitted', 'committed'];
const immutableObjectFields = Object.keys(OBJECTS).filter(
  (name) => !mutableObjectFields.includes(name)
);
const fields = {
  ...GLOBALS,
  ...Object.fromEntries(
    [0, 1].flatMap((owner) =>
      Object.entries(LOCAL).map(([key, type]) => [`local${owner}_${key}`, type])
    )
  ),
  ...Object.fromEntries(
    mutableObjectFields.map((key) => [`objects_${key}`, `(Array Int ${OBJECTS[key]})`])
  ),
};
const snapFields = [
  'authorized',
  'result0',
  'result1',
  'audit0',
  'audit1',
  'spent0',
  'spent1',
  'slot',
];
const scalarFields = Object.entries(fields)
  .filter(([, type]) => !type.startsWith('(Array'))
  .map(([name]) => name);

export function buildModel({ bound = 14, mutation = 'none', timeoutMs = 30000 } = {}) {
  if (!Number.isInteger(bound) || bound < 2 || bound > 40)
    throw new Error('bound must be an integer in [2, 40]');
  if (!MUTATIONS.includes(mutation)) throw new Error(`unknown mutation: ${mutation}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid solver timeout');
  const lines = [
    '; Two-owner custody state protocol, finite execution prefix; not Rust refinement.',
    `(set-logic QF_AUFLIA)`,
    `(set-option :produce-models true)`,
    `(set-option :timeout ${timeoutMs})`,
  ];
  const symbol = (name, step) => `${name}_${step}`;
  for (const name of immutableObjectFields) {
    lines.push(`(declare-const snapshot_${name} (Array Int ${OBJECTS[name]}))`);
    lines.push(
      `(assert ${eq(select(`snapshot_${name}`, 0), OBJECTS[name] === 'Bool' ? 'false' : 0)})`
    );
  }
  for (let step = 0; step <= bound; step += 1) {
    for (const [name, type] of Object.entries(fields))
      lines.push(`(declare-const ${symbol(name, step)} ${type})`);
    if (step < bound)
      for (const name of ['action', 'actor', 'object', 'request', 'digest'])
        lines.push(`(declare-const ${symbol(name, step)} Int)`);
  }
  for (const [name, type] of Object.entries(fields)) {
    let initial = type === 'Bool' ? 'false' : '0';
    if (type.startsWith('(Array'))
      initial = `((as const ${type}) ${type.endsWith('Bool)') ? 'false' : '0'})`;
    if (name === 'owner') initial = '2';
    if (name === 'authorized') initial = 'true';
    lines.push(`(assert ${eq(symbol(name, 0), initial)})`);
  }

  for (let step = 0; step < bound; step += 1) {
    const s = (name) => symbol(name, step);
    const local = (name, owner = s('actor')) =>
      ite(eq(owner, 0), s(`local0_${name}`), s(`local1_${name}`));
    const obj = (name, id = s('object')) =>
      select(mutableObjectFields.includes(name) ? s(`objects_${name}`) : `snapshot_${name}`, id);
    const pending = local('pending');
    const owns = and(s('lease'), eq(s('owner'), s('actor')), eq(s('epoch'), local('epoch')));
    const current = and(
      eq(local('generation'), s('generation')),
      eq(local('hash'), s('hash')),
      eq(local('snapshotFence'), s('snapshotFence'))
    );
    const phase = (...values) => or(...values.map((value) => eq(local('phase'), value)));
    const cases = [];
    const updateLocal = (values) =>
      Object.fromEntries(
        [0, 1].flatMap((owner) =>
          Object.entries(values).map(([key, value]) => [
            `local${owner}_${key}`,
            ite(eq(s('actor'), owner), String(value), s(`local${owner}_${key}`)),
          ])
        )
      );
    const updateObject = (id, values) =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) =>
          mutableObjectFields.includes(key)
            ? [`objects_${key}`, store(s(`objects_${key}`), id, value)]
            : [`snapshot_${key}`, value]
        )
      );
    const action = (name, guard, updates = {}) =>
      cases.push({ id: ACTIONS.indexOf(name), guard, updates });
    const remember = (name, condition) => or(s(name), condition);
    const resultFor = (req, source) => ite(eq(req, 0), source('result0'), source('result1'));
    const exactReceipt = and(
      obj('committed'),
      eq(s('object'), pending),
      eq(obj('owner'), s('actor')),
      eq(obj('epoch'), local('epoch'))
    );
    const requestedResult = resultFor(s('request'), local);
    const requestFresh = eq(requestedResult, 0);
    const decisionAllowed = and(phase(2), owns, current);
    lines.push(
      `(assert ${and(
        `(<= 0 ${s('action')})`,
        `(< ${s('action')} ${ACTIONS.length})`,
        or(eq(s('actor'), 0), eq(s('actor'), 1)),
        `(<= 1 ${s('object')})`,
        `(<= ${s('object')} ${bound})`,
        or(eq(s('request'), 0), eq(s('request'), 1)),
        or(eq(s('digest'), 1), eq(s('digest'), 2))
      )})`
    );

    action('idle', 'true');
    action(
      'restore',
      phase(0, 1),
      updateLocal({
        phase: 1,
        generation: s('generation'),
        hash: s('hash'),
        epoch: 0,
        snapshotFence: s('snapshotFence'),
        ...Object.fromEntries(snapFields.map((name) => [name, s(name)])),
        pending: 0,
        receipt: 0,
        timedOut: 'false',
        cancelled: 'false',
      })
    );
    action(
      'acquire',
      and(phase(1), not(s('lease')), mutation === 'stale-restore-admission' ? 'true' : current),
      {
        owner: s('actor'),
        epoch: add(s('epoch')),
        lease: 'true',
        badAdmission: remember('badAdmission', not(current)),
        sawTakeover: remember(
          'sawTakeover',
          and(`(< ${s('owner')} 2)`, not(eq(s('owner'), s('actor'))))
        ),
        sawSnapshotTakeover: remember(
          'sawSnapshotTakeover',
          and(`(< ${s('owner')} 2)`, not(eq(s('owner'), s('actor'))), `(> ${s('snapshotFence')} 0)`)
        ),
        ...updateLocal({ phase: 2, epoch: add(s('epoch')) }),
      }
    );
    action('expire', s('lease'), { lease: 'false' });

    const prepare = (signing) => {
      const id = String(step + 1); // Collision-free opaque object/hash abstraction.
      const content = Object.fromEntries(snapFields.map((name) => [name, local(name)]));
      if (signing) {
        for (const req of [0, 1]) {
          content[`result${req}`] = ite(eq(s('request'), req), s('digest'), local(`result${req}`));
          content[`audit${req}`] =
            mutation === 'omit-audit'
              ? local(`audit${req}`)
              : or(eq(s('request'), req), local(`audit${req}`));
          content[`spent${req}`] = or(eq(s('request'), req), local(`spent${req}`));
        }
        content.slot = s('digest');
      } else content.authorized = 'false';
      return {
        ...updateLocal({
          phase: 3,
          pending: id,
          receipt: 0,
          timedOut: 'false',
          cancelled: 'false',
          ...content,
        }),
        ...updateObject(id, {
          exists: 'true',
          previousGeneration: local('generation'),
          previousHash: local('hash'),
          owner: s('actor'),
          epoch: local('epoch'),
          snapshotFence: local('epoch'),
          previousSnapshotFence: local('snapshotFence'),
          ...content,
          kind: signing ? 1 : 2,
          request: signing ? s('request') : 0,
          digest: signing ? s('digest') : 0,
        }),
      };
    };
    action(
      'prepare-sign',
      and(
        decisionAllowed,
        local('authorized'),
        requestFresh,
        or(eq(local('slot'), 0), eq(local('slot'), s('digest')))
      ),
      prepare(true)
    );
    action('prepare-revoke', and(decisionAllowed, local('authorized')), prepare(false));
    action('upload', phase(3), {
      ...updateObject(pending, { uploaded: 'true' }),
      ...updateLocal({ phase: 4 }),
    });
    action('submit', phase(4), {
      ...updateObject(pending, { submitted: 'true' }),
      ...updateLocal({ phase: 5 }),
    });

    // The request is outside the caller process now; it may commit after crash.
    const commitGuard = and(
      obj('exists'),
      obj('uploaded'),
      obj('submitted'),
      not(obj('committed')),
      s('lease'),
      mutation === 'omit-fencing'
        ? 'true'
        : and(eq(obj('owner'), s('owner')), eq(obj('epoch'), s('epoch'))),
      eq(obj('previousGeneration'), s('generation')),
      eq(obj('previousHash'), s('hash')),
      mutation === 'rewind-snapshot-fence'
        ? 'true'
        : eq(obj('previousSnapshotFence'), s('snapshotFence'))
    );
    const nextGeneration =
      mutation === 'rewind-generation' ? obj('previousGeneration') : add(s('generation'));
    const committedOwnerPhase = local('phase', obj('owner'));
    action('remote-commit', commitGuard, {
      generation: nextGeneration,
      hash: s('object'),
      snapshotFence:
        mutation === 'rewind-snapshot-fence' ? s('snapshotFence') : obj('snapshotFence'),
      ...Object.fromEntries(snapFields.map((name) => [name, obj(name)])),
      ...updateObject(s('object'), { committed: 'true' }),
      badFencing: remember(
        'badFencing',
        or(not(eq(obj('owner'), s('owner'))), not(eq(obj('epoch'), s('epoch'))), not(s('lease')))
      ),
      badMonotonicity: remember(
        'badMonotonicity',
        or(
          not(eq(nextGeneration, add(s('generation')))),
          not(eq(add(obj('previousGeneration')), nextGeneration))
        )
      ),
      badSnapshotFencing: remember(
        'badSnapshotFencing',
        or(
          not(eq(obj('previousSnapshotFence'), s('snapshotFence'))),
          not(eq(obj('snapshotFence'), obj('epoch'))),
          mutation === 'rewind-snapshot-fence'
            ? not(eq(s('snapshotFence'), obj('snapshotFence')))
            : 'false'
        )
      ),
      sawLateCommit: remember('sawLateCommit', eq(committedOwnerPhase, 0)),
      sawCancelledCommit: remember('sawCancelledCommit', local('cancelled', obj('owner'))),
    });
    action('timeout', and(phase(5), not(local('timedOut'))), updateLocal({ timedOut: 'true' }));
    action(
      'receive-receipt',
      and(phase(5), mutation === 'inexact-receipt' ? obj('committed') : exactReceipt),
      {
        ...updateLocal({
          phase: 6,
          receipt: s('object'),
          generation: add(obj('previousGeneration')),
          hash: s('object'),
          snapshotFence: obj('snapshotFence'),
        }),
        sawTimeoutRecovery: remember('sawTimeoutRecovery', local('timedOut')),
      }
    );

    const p = (name) => obj(name, pending);
    const exactCommit = and(
      p('committed'),
      eq(local('receipt'), pending),
      eq(p('kind'), 1),
      eq(p('owner'), s('actor')),
      eq(p('epoch'), local('epoch')),
      eq(p('snapshotFence'), local('snapshotFence')),
      eq(resultFor(p('request'), p), p('digest'))
    );
    const completeLedger = and(
      ite(eq(p('request'), 0), p('audit0'), p('audit1')),
      ite(eq(p('request'), 0), p('spent0'), p('spent1')),
      eq(p('slot'), p('digest'))
    );
    const releaseGuard = and(
      mutation === 'early-release' ? phase(3, 4, 5, 6) : phase(6),
      owns,
      eq(p('kind'), 1)
    );
    const recordRelease = (req, digest) => ({
      released0: ite(eq(req, 0), digest, s('released0')),
      released1: ite(eq(req, 1), digest, s('released1')),
      badRequestBinding: remember(
        'badRequestBinding',
        and(not(eq(resultFor(req, s), 0)), not(eq(resultFor(req, s), digest)))
      ),
    });
    action('release', releaseGuard, {
      ...recordRelease(p('request'), p('digest')),
      badRelease: remember('badRelease', not(exactCommit)),
      badLedger: remember('badLedger', not(completeLedger)),
      ...updateLocal({ phase: 2, pending: 0, receipt: 0, timedOut: 'false', cancelled: 'false' }),
    });
    action(
      'finish-revoke',
      and(phase(6), owns, eq(p('kind'), 2), p('committed'), eq(local('receipt'), pending)),
      updateLocal({ phase: 2, pending: 0, receipt: 0, timedOut: 'false', cancelled: 'false' })
    );
    action(
      'cache-release',
      and(phase(2), owns, local('authorized'), eq(requestedResult, s('digest'))),
      {
        ...recordRelease(s('request'), s('digest')),
        badCache: remember(
          'badCache',
          not(and(current, s('authorized'), eq(resultFor(s('request'), s), s('digest'))))
        ),
        sawCache: 'true',
      }
    );
    action('crash', not(phase(0)), {
      sawCrashCommitted: remember('sawCrashCommitted', and(phase(5), p('committed'))),
      ...updateLocal(
        Object.fromEntries(
          Object.entries(LOCAL).map(([name, type]) => [name, type === 'Bool' ? 'false' : 0])
        )
      ),
    });
    action('client-cancel', phase(3, 4, 5, 6), updateLocal({ cancelled: 'true' }));
    action('reject-receipt', and(phase(5), obj('committed'), not(exactReceipt)), {
      sawRejectedReceipt: 'true',
    });
    action('reject-stale-acquire', and(phase(1), not(s('lease')), not(current)), {
      sawRejectedRestore: 'true',
    });

    for (const item of cases) lines.push(`(assert (=> ${eq(s('action'), item.id)} ${item.guard}))`);
    for (const name of immutableObjectFields) {
      let value = OBJECTS[name] === 'Bool' ? 'false' : '0';
      for (const item of cases.filter((entry) => `snapshot_${name}` in entry.updates).reverse()) {
        value = ite(eq(s('action'), item.id), item.updates[`snapshot_${name}`], value);
      }
      lines.push(`(assert ${eq(select(`snapshot_${name}`, step + 1), value)})`);
    }
    for (const name of Object.keys(fields)) {
      let next = s(name);
      for (const item of cases.filter((entry) => name in entry.updates).reverse())
        next = ite(eq(s('action'), item.id), item.updates[name], next);
      lines.push(`(assert ${eq(symbol(name, step + 1), next)})`);
    }
  }
  const propertiesAt = (at) => {
    const end = (name) => symbol(name, at);
    return {
      'release-barrier': end('badRelease'),
      'exact-decision-ledger': end('badLedger'),
      'cache-current-authority': end('badCache'),
      'restore-head-admission': end('badAdmission'),
      'epoch-fencing': end('badFencing'),
      'monotonic-generation': end('badMonotonicity'),
      'snapshot-fence-integrity': end('badSnapshotFencing'),
      'request-digest-binding': end('badRequestBinding'),
      'consensus-no-conflicting-release': and(
        `(> ${end('released0')} 0)`,
        `(> ${end('released1')} 0)`,
        not(eq(end('released0'), end('released1')))
      ),
    };
  };
  const properties = propertiesAt(bound);
  const previousProperties = propertiesAt(bound - 1);
  const end = (name) => symbol(name, bound);
  const covers = {
    'timeout-exact-receipt-release': and(
      end('sawTimeoutRecovery'),
      or(`(> ${end('released0')} 0)`, `(> ${end('released1')} 0)`)
    ),
    'inflight-commit-after-crash': end('sawLateCommit'),
    'commit-crash-restore-cache': and(end('sawCrashCommitted'), end('sawCache')),
    'reject-wrong-commit-receipt': end('sawRejectedReceipt'),
    'reject-restore-head-race': end('sawRejectedRestore'),
    'cancel-does-not-abort-commit': end('sawCancelledCommit'),
    'two-owner-takeover': end('sawTakeover'),
    'committed-snapshot-takeover': end('sawSnapshotTakeover'),
    'two-requests-output': and(`(> ${end('released0')} 0)`, `(> ${end('released1')} 0)`),
  };
  const traceSymbols = [];
  for (let step = 0; step <= bound; step += 1) {
    traceSymbols.push(...scalarFields.map((name) => symbol(name, step)));
    if (step < bound)
      traceSymbols.push(
        ...['action', 'actor', 'object', 'request', 'digest'].map((name) => symbol(name, step))
      );
  }
  return {
    source: `${lines.join('\n')}\n`,
    properties,
    previousProperties,
    covers,
    traceSymbols,
    bound,
    mutation,
  };
}

export function buildQueries(model, checks) {
  if (!checks.length || new Set(checks.map(({ id }) => id)).size !== checks.length)
    throw new Error('checks must have unique nonempty identities');
  return finiteEncoding(
    model.source +
      checks
        .map(({ id, expression, expected }) => {
          if (!/^[a-z0-9-]+$/.test(id) || !['sat', 'unsat'].includes(expected))
            throw new Error('invalid check specification');
          const propertyId = Object.keys(model.properties).find(
            (name) => model.properties[name] === expression
          );
          // Idle-prefix padding puts the first violation last without removing a trace.
          const firstBad = propertyId
            ? `(assert (not ${model.previousProperties[propertyId]}))\n`
            : '';
          return `(echo "CHECK:${id}")\n(push)\n${firstBad}(assert ${expression})\n(check-sat)\n${expected === 'sat' ? `(get-value (${model.traceSymbols.join(' ')}))\n` : ''}(pop)\n`;
        })
        .join('')
  );
}

export function decodeTrace(values, bound) {
  const rows = [];
  for (let step = 0; step <= bound; step += 1) {
    const get = (name) => values[`${name}_${step}`];
    const row = {
      step,
      head: {
        generation: get('generation'),
        hash: get('hash'),
        owner: get('owner'),
        epoch: get('epoch'),
        snapshotFence: get('snapshotFence'),
        lease: get('lease'),
        authorized: get('authorized'),
        results: [get('result0'), get('result1')],
      },
      owners: [0, 1].map((owner) => ({
        phase: PHASES[get(`local${owner}_phase`)],
        generation: get(`local${owner}_generation`),
        hash: get(`local${owner}_hash`),
        epoch: get(`local${owner}_epoch`),
        snapshotFence: get(`local${owner}_snapshotFence`),
        pending: get(`local${owner}_pending`),
        receipt: get(`local${owner}_receipt`),
        authorized: get(`local${owner}_authorized`),
      })),
      released: [get('released0'), get('released1')],
      violations: Object.keys(GLOBALS).filter((name) => name.startsWith('bad') && get(name)),
    };
    if (step < bound)
      row.next = {
        action: ACTIONS[get('action')],
        actor: get('actor'),
        object: get('object'),
        request: get('request'),
        digest: get('digest'),
      };
    rows.push(row);
  }
  return rows;
}

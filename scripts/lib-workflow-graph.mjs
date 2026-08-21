/**
 * A deliberately small reader for the `jobs:` section of a GitHub Actions
 * workflow, plus the release-gating rule we want enforced across this repo.
 *
 * Why hand-rolled instead of a YAML dependency: this repo declares no YAML
 * parser, and the gate has to run inside the release workflows themselves,
 * where adding a dependency to satisfy a guard would widen the very surface the
 * guard exists to protect. The reader is intentionally strict — anything it
 * does not recognise throws rather than being skipped, because a guard that
 * silently parses nothing reports the same green as a guard that passed.
 *
 * The rule: a job that writes to a production release target must declare
 * `needs:` on a job — in the same workflow — that actually runs tests.
 * `needs:` cannot reference another workflow, so a deploy workflow that defers
 * to ci.yml is not gated at all: it starts while ci.yml is still running, and
 * starts just the same after ci.yml has failed.
 */

/**
 * Steps whose presence in a job body mean that job writes to a release target.
 * A false positive here only demands that a job be gated, so the list errs
 * toward over-matching.
 */
export const RELEASE_MARKERS = [
  'publish:cdn',
  'npm publish',
  'vercel deploy',
  'vercel build --prod',
  'push: true',
  'wrangler deploy',
  'wrangler publish',
];

/**
 * Status-check functions that switch off the implicit gate.
 *
 * GitHub applies "a default status check of `success()` ... unless you include
 * one of these functions" in an `if:` conditional
 * (docs.github.com/en/actions/reference/workflows-and-actions/expressions
 * #status-check-functions). That default is the only thing that makes `needs:`
 * mean "and they passed" rather than "and they finished" — the `needs:`
 * reference itself says a dependent job is skipped when its dependency fails
 * "unless the jobs use a conditional expression that causes the job to
 * continue".
 *
 * This matters concretely here: deploy-web.yml's `deploy` job already carries
 * an `if:` for the secrets preflight. It is safe as written, because a plain
 * comparison keeps the implicit success(). Rewriting it to mention any of these
 * would leave `needs: [preflight, test]` in place and still ship on red.
 */
export const GATE_DEFEATING_FUNCTIONS = ['always', 'failure', 'cancelled'];

const GATE_DEFEATING_PATTERN = new RegExp(
  `\\b(${GATE_DEFEATING_FUNCTIONS.join('|')})\\s*\\(\\s*\\)`,
  'g'
);

/** Commands that count as "this job ran tests". */
const TEST_MARKERS = [
  /(^|[\s&|;])npm test(\s|$)/m,
  /npm run (-s )?test\b/,
  /npm (--prefix|--workspace) \S+ (run )?test\b/,
  /node --test\b/,
  /vitest run\b/,
  /deno test\b/,
  /dotnet test\b/,
  /forge test\b/,
  /go test\b/,
];

const JOB_HEADER = /^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isIgnorable(line) {
  return line.trim() === '' || /^\s*#/.test(line);
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^["']/.test(trimmed) && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse the `jobs:` mapping of a workflow.
 *
 * @param {string} source raw workflow YAML
 * @returns {{name: string, indent: number, body: string, needs: string[]}[]}
 */
export function parseWorkflowJobs(source) {
  const lines = source.split(/\r?\n/);
  const jobsLine = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (jobsLine === -1) {
    throw new Error('workflow has no top-level `jobs:` mapping');
  }

  const jobs = [];
  let jobIndent = null;
  let current = null;

  for (let i = jobsLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isIgnorable(line)) {
      if (current) current.lines.push(line);
      continue;
    }

    const indent = indentOf(line);
    if (indent === 0) break; // back out to another top-level key

    if (jobIndent === null) jobIndent = indent;

    if (indent < jobIndent) {
      throw new Error(`line ${i + 1} dedents out of the jobs mapping: ${line}`);
    }

    if (indent === jobIndent) {
      const header = JOB_HEADER.exec(line);
      if (!header) {
        throw new Error(`line ${i + 1} is not a recognisable job header: ${line}`);
      }
      current = { name: header[1], indent, lines: [] };
      jobs.push(current);
      continue;
    }

    if (!current) {
      throw new Error(`line ${i + 1} sits inside jobs: but before any job: ${line}`);
    }
    current.lines.push(line);
  }

  if (jobs.length === 0) {
    throw new Error('workflow declares `jobs:` but no jobs');
  }

  return jobs.map((job) => ({
    name: job.name,
    indent: job.indent,
    body: job.lines.join('\n'),
    needs: readNeeds(job),
    condition: readCondition(job),
  }));
}

/**
 * Read a job's own top-level `if:`, in the scalar and block-scalar spellings.
 * Returns '' when the job declares none. As with `needs:`, only the job's own
 * indent level is considered, so a step's `if:` cannot be mistaken for it.
 */
function readCondition(job) {
  const keyIndent = job.indent + 2;
  const keyPattern = new RegExp(`^ {${keyIndent}}if:\\s*(.*)$`);

  for (let i = 0; i < job.lines.length; i += 1) {
    const match = keyPattern.exec(job.lines[i]);
    if (!match) continue;

    const head = match[1].trim();
    // A plain scalar ends on its own line. `>`/`|` (and an empty value) carry
    // the expression on the following, more-indented lines.
    if (head !== '' && !/^[>|]/.test(head)) return head;

    const continued = [];
    for (let j = i + 1; j < job.lines.length; j += 1) {
      if (isIgnorable(job.lines[j])) continue;
      if (indentOf(job.lines[j]) <= keyIndent) break;
      continued.push(job.lines[j].trim());
    }
    return continued.join(' ');
  }

  return '';
}

/**
 * Status-check functions named in a job's `if:`, each at most once.
 * A non-empty result means the implicit `success()` over `needs:` is gone.
 */
export function gateDefeatingFunctions(condition) {
  const found = new Set();
  for (const match of String(condition ?? '').matchAll(GATE_DEFEATING_PATTERN)) {
    found.add(`${match[1]}()`);
  }
  return [...found];
}

/**
 * Read a job's `needs:` in all three spellings GitHub accepts: a bare scalar,
 * a flow sequence, and a block sequence. Only the job's own top level is
 * considered, so a `needs` key nested inside a step cannot be mistaken for one.
 */
function readNeeds(job) {
  const keyIndent = job.indent + 2;
  const keyPattern = new RegExp(`^ {${keyIndent}}needs:\\s*(.*)$`);
  const itemPattern = new RegExp(`^ {${keyIndent + 2}}-\\s*(.+?)\\s*$`);

  for (let i = 0; i < job.lines.length; i += 1) {
    const match = keyPattern.exec(job.lines[i]);
    if (!match) continue;

    const value = match[1].replace(/\s+#.*$/, '').trim();

    if (value.startsWith('[')) {
      if (!value.endsWith(']')) {
        throw new Error(`job "${job.name}" has an unterminated needs list: ${value}`);
      }
      return value
        .slice(1, -1)
        .split(',')
        .map(unquote)
        .filter((entry) => entry !== '');
    }

    if (value !== '') return [unquote(value)];

    const items = [];
    for (let j = i + 1; j < job.lines.length; j += 1) {
      if (isIgnorable(job.lines[j])) continue;
      const item = itemPattern.exec(job.lines[j]);
      if (!item) break;
      items.push(unquote(item[1]));
    }
    if (items.length === 0) {
      throw new Error(`job "${job.name}" declares an empty needs:`);
    }
    return items;
  }

  return [];
}

/** True when a job body contains a step that writes to a release target. */
export function isReleaseJob(job, markers = RELEASE_MARKERS) {
  return markers.some((marker) => job.body.includes(marker));
}

/** True when a job body contains a step that runs tests. */
export function runsTests(job) {
  return TEST_MARKERS.some((pattern) => pattern.test(job.body));
}

/** Offset of the earliest match in `body`, or -1. Patterns may be string or RegExp. */
function firstMatchOffset(body, patterns) {
  let earliest = -1;
  for (const pattern of patterns) {
    const at = typeof pattern === 'string' ? body.indexOf(pattern) : body.search(pattern);
    if (at !== -1 && (earliest === -1 || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * True when a job runs its own tests *before* its release step.
 *
 * `needs:` is not the only way to gate a release. A single job whose steps are
 * "test, then publish" is gated by step ordering: a failed step ends the job,
 * so the publish step never runs. neo-os-devpack/publish.yml is the in-house
 * example of exactly this. Demanding `needs:` there would flag a correct
 * workflow and push it toward a worse shape, so this counts as gated.
 *
 * `continue-on-error: true` anywhere in the job disqualifies it: a step that is
 * allowed to fail cannot gate anything, and locating which step carries the key
 * is more than this reader should pretend to do. Fail closed instead.
 */
export function gatesItselfInline(job, markers = RELEASE_MARKERS) {
  if (/continue-on-error:\s*true/.test(job.body)) return false;
  const testAt = firstMatchOffset(job.body, TEST_MARKERS);
  if (testAt === -1) return false;
  const releaseAt = firstMatchOffset(job.body, markers);
  return releaseAt !== -1 && testAt < releaseAt;
}

/**
 * Report every release job in a workflow that is not gated behind a test job.
 *
 * @returns {{job: string, reason: string}[]} empty when the workflow is sound
 */
export function findUngatedReleaseJobs(source, markers = RELEASE_MARKERS) {
  const jobs = parseWorkflowJobs(source);
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const failures = [];

  for (const job of jobs) {
    if (!isReleaseJob(job, markers)) continue;

    // Step ordering is a gate in its own right, and it does not depend on
    // needs: or on the implicit success() the checks below are about.
    if (gatesItselfInline(job, markers)) continue;

    // Checked before needs:, because it defeats whatever needs: says.
    const defeating = gateDefeatingFunctions(job.condition);
    if (defeating.length > 0) {
      failures.push({
        job: job.name,
        reason: `its if: calls ${defeating.join(', ')}, which drops the implicit success() over needs:`,
      });
      continue;
    }

    if (job.needs.length === 0) {
      failures.push({ job: job.name, reason: 'declares no needs:, so nothing gates it' });
      continue;
    }

    const seen = new Set();
    const queue = [...job.needs];
    let gated = false;
    let missing = null;

    while (queue.length > 0) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      const upstream = byName.get(name);
      if (!upstream) {
        missing = name;
        continue;
      }
      if (runsTests(upstream)) {
        gated = true;
        break;
      }
      queue.push(...upstream.needs);
    }

    if (missing) {
      failures.push({
        job: job.name,
        reason: `needs: names a job that does not exist: ${missing}`,
      });
      continue;
    }
    if (!gated) {
      failures.push({
        job: job.name,
        reason: `none of its transitive needs (${[...seen].join(', ')}) runs tests`,
      });
    }
  }

  return failures;
}

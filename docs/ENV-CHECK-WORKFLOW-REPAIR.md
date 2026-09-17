# Environment Check Workflow Repair

## Purpose and cause

Restore YAML parsing of `.github/workflows/env-check.yml` without changing the
intended workflow behavior. This document was created before the regression test
and workflow repair.

The report heredoc body and its `EOF` terminator originally started at column 1,
outside the `run: |` block. The installed `js-yaml` parser rejected the workflow
at line 96, column 10 with:

```text
can not read a block mapping entry; a multiline key may not be an implicit key
```

## Repair and interface preservation

Indent the nonblank heredoc body lines and `EOF` by ten spaces to keep them inside
the YAML literal block. YAML removes that common indentation when decoding the
script, leaving the report content and the shell's `EOF` terminator at column 1.
Prettier additionally removes whitespace from blank lines.

Triggers, network input choices, job IDs, step order, action pins, commands,
artifact configuration, and summary conditions remain unchanged. There are no
API, schema, dependency, or migration changes.

## Local regression tests

`scripts/env-check-workflow.test.mjs` uses `node:test` and the already installed
transitive dependency `js-yaml` (currently 3.15.1). No package installation or
manifest change is needed. The existing `test:scripts` glob includes this file.

The four tests check:

- Successful YAML parsing; a parser exception fails the regression.
- Push/PR branches and manual network choice input.
- The validation jobs, their steps, and summary dependencies/condition.
- The report heredoc's presence in the decoded script, its column-1 terminator,
  and the network-variable report lines.

Run from the repository root:

```sh
node --test scripts/env-check-workflow.test.mjs
./node_modules/.bin/prettier --check .github/workflows/env-check.yml scripts/env-check-workflow.test.mjs docs/ENV-CHECK-WORKFLOW-REPAIR.md
```

Before the workflow edit, all four tests failed on the YAML parse error. After
the repair, all four must pass. These tests read and parse one small local file;
they do not execute workflow commands, access credentials, or call the network.

## Security and operational boundaries

The repair adds no credentials and preserves existing GitHub expressions and
shell substitutions. It does not assess or change the workflow's runtime security
or environment requirements. The parser is supplied transitively; removing its
parent dependency could require revisiting test dependency resolution.

No deployment or live workflow execution is part of verification. Once separately
reviewed and committed, the repair takes effect when GitHub next loads the
workflow. Runtime behavior is not validated by the parser test. In particular,
the report step assumes its existing `build/` output directory is available;
this syntax-only repair does not change that assumption.

#!/bin/bash
# Daily fuzz driver for this repository's real fuzz harnesses.
#
# Runs fuzz-security.mjs and fuzz-os-infra.mjs from the repository root. Both
# harnesses draw every input from a PRNG seeded with FUZZ_SEED (a decimal
# integer from 1 to 4294967295, default 20260928), so a run replays exactly
# from the seed it prints. Set FUZZ_DRY_RUN=1 to print the plan without
# executing anything. Artifact upload (S3) and the Slack notification are
# optional: each is skipped with a notice when its configuration is absent,
# and neither requires credentials for a local run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_DIR="${FUZZ_RESULTS_DIR:-$ROOT/fuzz-testing/results}"
SEED="${FUZZ_SEED:-20260928}"
HARNESSES=(fuzz-security.mjs fuzz-os-infra.mjs)
RUN_DAY="$(date +%Y/%m/%d)"
ARCHIVE_NAME="fuzz-results-${RUN_DAY//\//}.tar.gz"
S3_PREFIX="fuzz-$RUN_DAY/"

if ! [[ "$SEED" =~ ^[0-9]{1,10}$ ]] || [ "$SEED" -lt 1 ] || [ "$SEED" -gt 4294967295 ]; then
  echo "error: FUZZ_SEED must be a decimal integer from 1 to 4294967295 (got '$SEED')" >&2
  exit 2
fi

echo "== daily fuzz =="
echo "repository root: $ROOT"
echo "seed: $SEED (override with FUZZ_SEED)"
echo "results dir: $RESULTS_DIR"

if [ "${FUZZ_DRY_RUN:-0}" = "1" ]; then
  echo "dry run: would execute:"
  for harness in "${HARNESSES[@]}"; do
    echo "  FUZZ_SEED=$SEED node $harness"
  done
  if [ -n "${FUZZ_S3_BUCKET:-}" ]; then
    echo "dry run: artifact upload: $ARCHIVE_NAME to s3://$FUZZ_S3_BUCKET/$S3_PREFIX"
  else
    echo "dry run: artifact upload: skipped (FUZZ_S3_BUCKET not set)"
  fi
  if [ -n "${FUZZ_SLACK_WEBHOOK:-}" ]; then
    echo "dry run: slack notification: would post to the configured webhook"
  else
    echo "dry run: slack notification: skipped (FUZZ_SLACK_WEBHOOK not set)"
  fi
  echo "dry run: nothing executed"
  exit 0
fi

cd "$ROOT"
mkdir -p "$RESULTS_DIR"

STATUS=0
for harness in "${HARNESSES[@]}"; do
  name="$(basename "$harness" .mjs)"
  log="$RESULTS_DIR/$name.log"
  echo "== running $harness =="
  if FUZZ_SEED="$SEED" node "$harness" 2>&1 | tee "$log"; then
    echo "== $harness passed (log: $log) =="
  else
    echo "== $harness FAILED (log: $log) =="
    STATUS=1
  fi
done
if [ "$STATUS" -eq 0 ]; then
  outcome="passing"
else
  outcome="failing"
fi

# Optional artifact upload: needs an explicit FUZZ_S3_BUCKET (and the aws CLI).
# The logs are uploaded whether the harnesses passed or failed: a failing run's
# counterexamples are what the archive is for. The archive is built in a
# temporary directory so it is not left behind in the checkout. Never runs,
# and never asks for credentials, when the bucket is not configured.
if [ -n "${FUZZ_S3_BUCKET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    archive_dir="$(mktemp -d)"
    trap 'rm -rf "$archive_dir"' EXIT
    archive="$archive_dir/$ARCHIVE_NAME"
    logs=()
    for harness in "${HARNESSES[@]}"; do
      logs+=("$(basename "$harness" .mjs).log")
    done
    if tar -czf "$archive" -C "$RESULTS_DIR" "${logs[@]}"; then
      echo "uploading the $outcome run's logs ($ARCHIVE_NAME) to s3://$FUZZ_S3_BUCKET/$S3_PREFIX"
      if ! aws s3 cp "$archive" "s3://$FUZZ_S3_BUCKET/$S3_PREFIX"; then
        echo "error: artifact upload failed"
        STATUS=1
      fi
    else
      echo "error: could not archive the logs; skipping artifact upload"
      STATUS=1
    fi
  else
    echo "note: FUZZ_S3_BUCKET is set but the aws CLI is not installed; skipping artifact upload"
  fi
else
  echo "note: artifact upload skipped (set FUZZ_S3_BUCKET to enable)"
fi

# Optional Slack notification: needs an explicit FUZZ_SLACK_WEBHOOK. The URL is
# a secret: it is never echoed, and it reaches curl as a config file on stdin
# (printf is a shell builtin), so it never appears in a process argument list.
if [ -n "${FUZZ_SLACK_WEBHOOK:-}" ]; then
  verdict="passed"
  if [ "$STATUS" -ne 0 ]; then
    verdict="FAILED"
  fi
  # A curl config value in double quotes interprets backslash escapes, so a
  # URL with whitespace, a quote or a backslash is refused rather than escaped.
  webhook_pattern='^https://[^[:space:]"\\]+$'
  if [[ "$FUZZ_SLACK_WEBHOOK" =~ $webhook_pattern ]]; then
    echo "posting the Slack notification"
    if ! printf 'url = "%s"\n' "$FUZZ_SLACK_WEBHOOK" |
      curl -fsS -K - -X POST -H 'Content-type: application/json' \
        --data "{\"text\":\"daily fuzz $verdict (seed $SEED)\"}"; then
      echo "note: Slack notification failed (continuing)"
    fi
  else
    echo "note: FUZZ_SLACK_WEBHOOK is not an https URL free of whitespace, quotes and backslashes; skipping the Slack notification"
  fi
else
  echo "note: Slack notification skipped (set FUZZ_SLACK_WEBHOOK to enable)"
fi

if [ "$STATUS" -ne 0 ]; then
  echo "RESULT: FAIL (see logs in $RESULTS_DIR)"
else
  echo "RESULT: PASS"
fi
exit "$STATUS"

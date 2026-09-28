#!/bin/bash
# Daily fuzz driver for this repository's real fuzz harnesses.
#
# Runs fuzz-security.mjs and fuzz-os-infra.mjs from the repository root with a
# fixed default seed (override with FUZZ_SEED). Set FUZZ_DRY_RUN=1 to print the
# plan without executing anything. Artifact upload (S3) and the Slack
# notification are optional: each is skipped with a notice when its
# configuration is absent, and neither requires credentials for a local run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_DIR="${FUZZ_RESULTS_DIR:-$ROOT/fuzz-testing/results}"
SEED="${FUZZ_SEED:-20260928}"
HARNESSES=(fuzz-security.mjs fuzz-os-infra.mjs)

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
    echo "dry run: artifact upload: s3://$FUZZ_S3_BUCKET/fuzz-results-<date>.tar.gz"
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

# Optional artifact upload: needs an explicit FUZZ_S3_BUCKET (and the aws CLI).
# Never runs, and never asks for credentials, when the bucket is not configured.
if [ "$STATUS" -eq 0 ] && [ -n "${FUZZ_S3_BUCKET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    archive="$RESULTS_DIR/fuzz-results-$(date +%Y%m%d).tar.gz"
    logs=()
    for harness in "${HARNESSES[@]}"; do
      logs+=("$(basename "$harness" .mjs).log")
    done
    tar -czf "$archive" -C "$RESULTS_DIR" "${logs[@]}"
    echo "uploading $archive to s3://$FUZZ_S3_BUCKET/"
    aws s3 cp "$archive" "s3://$FUZZ_S3_BUCKET/fuzz-$(date +%Y/%m/%d)/" || STATUS=$?
  else
    echo "note: FUZZ_S3_BUCKET is set but the aws CLI is not installed; skipping artifact upload"
  fi
else
  echo "note: artifact upload skipped (set FUZZ_S3_BUCKET to enable)"
fi

# Optional Slack notification: needs an explicit FUZZ_SLACK_WEBHOOK. The URL is
# never echoed.
if [ -n "${FUZZ_SLACK_WEBHOOK:-}" ]; then
  verdict="passed"
  if [ "$STATUS" -ne 0 ]; then
    verdict="FAILED"
  fi
  echo "posting the Slack notification"
  curl -fsS -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"daily fuzz $verdict (seed $SEED)\"}" \
    "$FUZZ_SLACK_WEBHOOK" || echo "note: Slack notification failed (continuing)"
else
  echo "note: Slack notification skipped (set FUZZ_SLACK_WEBHOOK to enable)"
fi

if [ "$STATUS" -ne 0 ]; then
  echo "RESULT: FAIL (see logs in $RESULTS_DIR)"
else
  echo "RESULT: PASS"
fi
exit "$STATUS"

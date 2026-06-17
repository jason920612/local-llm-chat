#!/usr/bin/env bash
# Diagnostic: peek at a VM session and optionally one job's live log.
set -uo pipefail

CONV="${1:?usage: peek-live.sh <conv-id> [job-id]}"
JOB="${2:-}"
D="/srv/llm-sandboxes/$CONV/ws/.run"

echo "--- daemon ---"
cat "$D/daemon.json" 2>&1 || true
echo

echo "--- jobs ---"
find "$D/jobs" -maxdepth 2 -type f \( -name status.json -o -name result.json \) \
  -printf '%TY-%Tm-%Td %TH:%TM %p\n' 2>/dev/null | sort | tail -20 || true

if [ -n "$JOB" ]; then
  J="$D/jobs/$JOB"
  echo "--- $JOB status ---"
  cat "$J/status.json" 2>&1 || true
  echo
  echo "--- $JOB live.log tail ---"
  tail -40 "$J/live.log" 2>&1 || true
fi

echo "--- serial.log tail ---"
tail -20 "$D/serial.log" 2>&1 || true

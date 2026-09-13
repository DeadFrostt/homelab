#!/usr/bin/env bash
# Shared bounded, retrying remote verification for encrypted snapshots.

verify_remote_snapshot() {
  local snapshot=$1 remote=$2
  shift 2
  local attempt

  for attempt in 1 2 3; do
    if timeout --foreground 2m rclone "$@" check "$snapshot" "$remote" \
      --one-way --size-only --contimeout 15s --timeout 30s \
      --retries 1 --low-level-retries 1; then
      return 0
    fi
    printf 'Remote verification attempt %s/3 failed for %s.\n' "$attempt" "$remote" >&2
    if [[ "$attempt" -lt 3 ]]; then
      sleep $((attempt * 10))
    fi
  done

  return 1
}

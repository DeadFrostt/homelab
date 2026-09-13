#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "--foreground" ]] && shift
shift
exec "$@"
EOF
cat >"$tmp/bin/rclone" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
attempt_file=${ATTEMPT_FILE:?}
attempt=0
[[ -f "$attempt_file" ]] && attempt=$(<"$attempt_file")
attempt=$((attempt + 1))
printf '%s' "$attempt" >"$attempt_file"
[[ "$attempt" -lt "${SUCCEED_ON_ATTEMPT:?}" ]] && exit 1
exit 0
EOF
cat >"$tmp/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/bin/timeout" "$tmp/bin/rclone" "$tmp/bin/sleep"

export PATH="$tmp/bin:$PATH"
export ATTEMPT_FILE="$tmp/attempts"
source "$repo/host-backup/backup-verify.sh"

export SUCCEED_ON_ATTEMPT=2
verify_remote_snapshot /snapshot remote:bucket/path --config /test/rclone.conf
[[ $(<"$ATTEMPT_FILE") == 2 ]]

printf '0' >"$ATTEMPT_FILE"
export SUCCEED_ON_ATTEMPT=4
if verify_remote_snapshot /snapshot remote:bucket/path --config /test/rclone.conf; then
  printf '%s\n' 'expected verification to fail after retry budget' >&2
  exit 1
fi
[[ $(<"$ATTEMPT_FILE") == 3 ]]
printf '%s\n' 'backup verification retry tests passed'

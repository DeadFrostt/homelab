#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${K3S_BACKUP_CONFIG:-/home/ubuntu/.config/docker-state-backup/config}"
RCLONE_CONFIG_FILE="${K3S_BACKUP_RCLONE_CONFIG:-/home/ubuntu/.config/rclone/rclone.conf}"
LOCAL_ROOT="${K3S_BACKUP_LOCAL_ROOT:-/var/lib/k3s-state-backups}"
LOCK_FILE="${K3S_BACKUP_LOCK:-/run/lock/k3s-state-backup.lock}"
LOCAL_RETENTION_DAYS="${K3S_BACKUP_LOCAL_RETENTION_DAYS:-7}"
REMOTE_RETENTION_DAYS="${K3S_BACKUP_REMOTE_RETENTION_DAYS:-30}"
K3S_DB="/var/lib/rancher/k3s/server/db/state.db"
K3S_TOKEN="/var/lib/rancher/k3s/server/token"
LOCAL_ONLY=0

if [[ "${1:-}" == "--local-only" ]]; then
  LOCAL_ONLY=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--local-only]" >&2
  exit 2
fi

[[ "$(id -u)" -eq 0 ]] || { echo "This backup must run as root." >&2; exit 1; }
for command in age flock rclone sha256sum sqlite3 tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 1; }
done
[[ -r "$CONFIG_FILE" ]] || { echo "Backup configuration is not readable: $CONFIG_FILE" >&2; exit 1; }
[[ -r "$K3S_DB" ]] || { echo "K3s SQLite database is not readable: $K3S_DB" >&2; exit 1; }
[[ -r "$K3S_TOKEN" ]] || { echo "K3s server token is not readable: $K3S_TOKEN" >&2; exit 1; }

# shellcheck source=/dev/null
source "$CONFIG_FILE"
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required in $CONFIG_FILE}"
if (( ! LOCAL_ONLY )); then
  : "${RCLONE_DESTINATION:?RCLONE_DESTINATION is required in $CONFIG_FILE}"
  [[ -r "$RCLONE_CONFIG_FILE" ]] || { echo "rclone configuration is not readable: $RCLONE_CONFIG_FILE" >&2; exit 1; }
fi

install -d -m 0700 "$LOCAL_ROOT"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another K3s state backup is running." >&2; exit 1; }

host="$(hostname -s)"
snapshot_id="$(date -u +%Y%m%dT%H%M%SZ)"
work="$LOCAL_ROOT/.${snapshot_id}.incomplete"
snapshot="$LOCAL_ROOT/$snapshot_id"
plain="$work/plain"
install -d -m 0700 "$plain"
cleanup() { [[ -d "$work" ]] && rm -rf -- "$work"; }
trap cleanup EXIT

echo "Create online SQLite backup"
sqlite3 "$K3S_DB" ".timeout 60000" ".backup '$plain/state.db'"
[[ "$(sqlite3 "$plain/state.db" 'PRAGMA quick_check;')" == "ok" ]] || {
  echo "SQLite integrity check failed." >&2
  exit 1
}

install -m 0600 "$K3S_TOKEN" "$plain/token"
if [[ -r /etc/rancher/k3s/config.yaml ]]; then
  install -m 0600 /etc/rancher/k3s/config.yaml "$plain/config.yaml"
fi
if [[ -r /etc/rancher/k3s/resolv.conf ]]; then
  install -m 0600 /etc/rancher/k3s/resolv.conf "$plain/resolv.conf"
fi

tar -C "$plain" -czf - . | age -r "$AGE_RECIPIENT" -o "$work/k3s-state.tar.gz.age"
rm -rf -- "$plain"
{
  echo "snapshot=$snapshot_id"
  echo "host=$host"
  echo "created_utc=$(date -u +%FT%TZ)"
  echo "database=sqlite-online-backup"
  echo "integrity_check=ok"
  echo "includes=state.db,server-token,k3s-config,resolver-config"
} >"$work/manifest.txt"
age -r "$AGE_RECIPIENT" -o "$work/manifest.txt.age" "$work/manifest.txt"
rm -f "$work/manifest.txt"
(
  cd "$work"
  sha256sum k3s-state.tar.gz.age manifest.txt.age >SHA256SUMS
)

mv "$work" "$snapshot"
trap - EXIT

if (( ! LOCAL_ONLY )); then
  remote="${RCLONE_DESTINATION%/}/k3s/$host/$snapshot_id"
  echo "Upload encrypted K3s snapshot: $remote"
  rclone --config "$RCLONE_CONFIG_FILE" copy "$snapshot" "$remote" --checkers 4 --transfers 2
  rclone --config "$RCLONE_CONFIG_FILE" check "$snapshot" "$remote" --one-way
  rclone --config "$RCLONE_CONFIG_FILE" delete "${RCLONE_DESTINATION%/}/k3s/$host" --min-age "${REMOTE_RETENTION_DAYS}d" --rmdirs
fi

find "$LOCAL_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime "+$LOCAL_RETENTION_DAYS" -exec rm -rf -- {} +
echo "K3s state backup complete: $snapshot"

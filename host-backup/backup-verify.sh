#!/usr/bin/env bash
# Verify encrypted snapshot content before recording success or pruning history.
# Installed rclone can deadlock in its automatic systemd log handler.
# Keep stderr attached to journald but disable that reentrant handler.
backup_rclone() { env -u JOURNAL_STREAM rclone "$@"; }
verify_remote_snapshot() {
  local snapshot=$1 remote=$2
  shift 2
  # Native object hashes verify uploads without consuming download allowance.
  # Explicit download mode remains available for controlled restore drills.
  if [[ "${BACKUP_VERIFY_MODE:-native}" == native ]]; then
    env -u JOURNAL_STREAM python3 - "$snapshot" "$remote" "$@" <<'PYTHON'
import hashlib,json,os,subprocess,sys
from pathlib import Path
snapshot=Path(sys.argv[1]);remote=sys.argv[2]
subprocess.run(['sha256sum','--check','--status','SHA256SUMS'],cwd=snapshot,check=True)
expected={}
for path in snapshot.rglob('*'):
    if path.is_symlink():raise ValueError('Snapshot links refused')
    if path.is_file():
        with path.open('rb') as stream:digest=hashlib.file_digest(stream,'sha1').hexdigest()
        expected[str(path.relative_to(snapshot))]=(path.stat().st_size,digest)
result=subprocess.run(['rclone',*sys.argv[3:],'lsjson',remote,'--recursive','--hash','--retries','1'],capture_output=True,check=True,timeout=120)
actual={}
for item in json.loads(result.stdout):
    if item['IsDir']:continue
    name=item['Path'];hashes={k.lower().replace('-',''):v.lower() for k,v in item.get('Hashes',{}).items()};digest=hashes.get('sha1','')
    if name in actual or len(digest)!=40 or any(c not in '0123456789abcdef' for c in digest):raise ValueError('Missing/invalid native hash; verification refused')
    actual[name]=(item['Size'],digest)
if not expected or actual!=expected:raise ValueError('Object inventory/hash mismatch; pruning refused')
print('Native upload hashes verified without payload downloads')
PYTHON
    return $?
  fi
  local attempt checksums attempts=${BACKUP_VERIFY_ATTEMPTS:-3}
  [[ -s "$snapshot/SHA256SUMS" ]] || { echo "Missing snapshot SHA256SUMS" >&2; return 1; }
  # This also refuses incomplete/corrupt local inputs before contacting storage.
  (cd "$snapshot" && sha256sum --check --status SHA256SUMS) || return 1
  checksums=$(mktemp) || return 1
  # rclone treats leading ./ literally on object storage; sha256sum emits it
  # when manifests are built from find. Normalize only the relative prefix.
  sed -E 's@^([[:xdigit:]]{64} [ *])\./@\1@' "$snapshot/SHA256SUMS" >"$checksums"
  for ((attempt=1; attempt<=attempts; attempt++)); do
    if timeout --foreground "${BACKUP_VERIFY_DEADLINE:-10m}" env -u JOURNAL_STREAM rclone "$@" \
        checksum SHA-256 "$checksums" "$remote" --download --one-way \
        --checkers "${BACKUP_VERIFY_CHECKERS:-2}" --contimeout 15s --timeout 45s \
        --retries 1 --low-level-retries 1; then
      rm -f -- "$checksums"
      return 0
    fi
    printf 'Content verification attempt %s/%s failed. No retention pruning is permitted.\n' "$attempt" "$attempts" >&2
    if (( attempt < attempts )); then sleep "${BACKUP_VERIFY_BACKOFF_SECONDS:-10}"; fi
  done
  rm -f -- "$checksums"
  return 1
}

record_verified_snapshot() {
  local root=$1 snapshot=$2
  local marker="$root/.last-verified"
  [[ -d "$snapshot" && "${snapshot%/*}" == "$root" ]] || return 1
  (umask 077; printf '%s\n%s\n' "${snapshot##*/}" "$(date -u +%FT%TZ)" >"$marker.tmp") || return 1
  mv -f -- "$marker.tmp" "$marker"
}

prune_local_snapshots() {
  local root=$1 days=$2 protected='' candidate
  if [[ -r "$root/.last-verified" ]]; then IFS= read -r protected <"$root/.last-verified"; fi
  while IFS= read -r -d '' candidate; do
    [[ "${candidate##*/}" == "$protected" ]] && continue
    rm -rf -- "$candidate"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -mtime "+$days" -print0)
}

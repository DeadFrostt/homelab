#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run on Yeager as root; reuses the established private encrypted backup target.
source "${BACKUP_CONFIG_FILE:-/home/ubuntu/.config/docker-state-backup/config}"
export AGE_RECIPIENT RCLONE_DESTINATION
export BACKUP_RCLONE_CONFIG="${BACKUP_RCLONE_CONFIG:-/etc/homelab-dr/source-rclone.conf}"
version=59cf6d2-pacing1
image="ghcr.io/deadfrostt/inbox-zero:$version"
work="/var/lib/homelab-dr/images/inbox-zero-$version"
mkdir -p "$work"
if [[ ! -s "$work/image.tar.gz.age" ]]; then
  k3s ctr images export --local --platform linux/amd64 - "$image" |
    gzip -1 | age -r "$AGE_RECIPIENT" -o "$work/image.tar.gz.age.incomplete"
  mv "$work/image.tar.gz.age.incomplete" "$work/image.tar.gz.age"
fi
(cd "$work" && sha256sum image.tar.gz.age > SHA256SUMS)
remote="${RCLONE_DESTINATION%/}/portable/yeager/image-artifacts/inbox-zero-$version"
env -u JOURNAL_STREAM rclone --config "$BACKUP_RCLONE_CONFIG" copy "$work" "$remote" --transfers 1 --checkers 2
python3 - "$work" "$remote" <<'PY'
import sys,os,runpy
sys.path.insert(0,'/usr/local/lib/homelab-dr')
verify_uploaded_snapshot=runpy.run_path('/usr/local/lib/homelab-dr/portable-backup.py')['verify_uploaded_snapshot']
verify_uploaded_snapshot(sys.argv[1],sys.argv[2],os.environ['BACKUP_RCLONE_CONFIG'])
PY
echo 'Encrypted recovery image uploaded and native offsite hashes verified.'

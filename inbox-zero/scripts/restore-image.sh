#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${AGE_IDENTITY_FILE:?Set the path to the separately held age recovery identity}"
source "${BACKUP_CONFIG_FILE:-/home/ubuntu/.config/docker-state-backup/config}"
: "${BACKUP_RCLONE_CONFIG:?Set a recovery rclone config with read access; the source upload key cannot download} "
config=$BACKUP_RCLONE_CONFIG
release_file=${INBOXZERO_RELEASE_FILE:-$(dirname "$0")/../release.json}
read -r version digest platform < <(python3 - "$release_file" <<'PYCODE'
import json,re,sys
release=json.load(open(sys.argv[1]))
revision=release['source_revision'];image=release['image'];platform=release['platform']
assert re.fullmatch(r'[a-f0-9]{40}',revision)
assert re.fullmatch(r'ghcr\.io/deadfrostt/inbox-zero@sha256:[a-f0-9]{64}',image)
assert platform=='linux/arm64'
print('native-'+revision,image.split('@')[1],platform)
PYCODE
)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
env -u JOURNAL_STREAM rclone --config "$config" copy "${RCLONE_DESTINATION%/}/portable/yeager/image-artifacts/inbox-zero-$version" "$work" --transfers 1
(cd "$work" && sha256sum -c SHA256SUMS)
age -d -i "$AGE_IDENTITY_FILE" "$work/image.tar.gz.age" |
  gzip -dc | k3s ctr images import --local --digests -
image="ghcr.io/deadfrostt/inbox-zero:$version"
actual=$(k3s ctr images list "name==$image" | awk 'NR == 2 {print $3}')
if [[ "$actual" != "$digest" ]]; then
  echo 'Imported image digest does not match release.json' >&2
  exit 1
fi
k3s ctr images tag "$image" "ghcr.io/deadfrostt/inbox-zero@$digest"

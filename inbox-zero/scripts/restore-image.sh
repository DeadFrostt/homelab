#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${AGE_IDENTITY_FILE:?Set the path to the separately held age recovery identity}"
source "${BACKUP_CONFIG_FILE:-/home/ubuntu/.config/docker-state-backup/config}"
config=${BACKUP_RCLONE_CONFIG:-/etc/homelab-dr/source-rclone.conf}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
env -u JOURNAL_STREAM rclone --config "$config" copy "${RCLONE_DESTINATION%/}/portable/yeager/image-artifacts/inbox-zero-59cf6d2-pacing1" "$work" --transfers 1
(cd "$work" && sha256sum -c SHA256SUMS)
age -d -i "$AGE_IDENTITY_FILE" "$work/image.tar.gz.age" |
  gzip -dc | k3s ctr images import --local --digests -
image=ghcr.io/deadfrostt/inbox-zero
digest=sha256:3b773fa5b80bd6157c8d5247c45650eca0360a368124bdbf90890c8de1e5146e
k3s ctr images tag --force "$image:59cf6d2-pacing1" "$image@$digest"

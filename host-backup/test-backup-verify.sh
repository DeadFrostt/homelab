#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/backup-verify.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
export BACKUP_VERIFY_ATTEMPTS=1 BACKUP_VERIFY_BACKOFF_SECONDS=0 BACKUP_VERIFY_DEADLINE=30s
mkdir -p "$work/source/nested" "$work/remote/nested"
printf 'abcdefgh' >"$work/source/nested/data.age"
(cd "$work/source" && sha256sum ./nested/data.age >SHA256SUMS)
cp "$work/source/nested/data.age" "$work/remote/nested/data.age"
verify_remote_snapshot "$work/source" "$work/remote"
printf 'abcdEfgh' >"$work/remote/nested/data.age"
if verify_remote_snapshot "$work/source" "$work/remote"; then echo 'same-size corruption accepted' >&2; exit 1; fi
rm "$work/remote/nested/data.age"
if verify_remote_snapshot "$work/source" "$work/remote"; then echo 'missing object accepted' >&2; exit 1; fi
printf 'abcdefgH' >"$work/source/nested/data.age"
if verify_remote_snapshot "$work/source" "$work/remote"; then echo 'corrupt local snapshot accepted' >&2; exit 1; fi
mkdir -p "$work/history/20200101T000000Z" "$work/history/20200102T000000Z" "$work/history/20261006T000000Z"
touch -d '2020-01-01' "$work/history/20200101T000000Z" "$work/history/20200102T000000Z"
record_verified_snapshot "$work/history" "$work/history/20200101T000000Z"
prune_local_snapshots "$work/history" 2
[[ -d "$work/history/20200101T000000Z" && ! -d "$work/history/20200102T000000Z" && -d "$work/history/20261006T000000Z" ]]
echo 'PASS: correct content, same-size corruption, missing remote object, corrupt local input, protected retention'

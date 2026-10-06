#!/usr/bin/env bash
set -euo pipefail
source "${DR_BACKUP_CONFIG:-/home/ubuntu/.config/docker-state-backup/config}"
export AGE_RECIPIENT RCLONE_DESTINATION
exec python3 "$(dirname "$0")/portable-backup.py" "$@"

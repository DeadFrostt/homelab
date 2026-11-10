#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
install -d -m 0755 /etc/rakazo/tailnet-client
install -m 0644 client/profile.sh client/curlrc client/chromium.json /etc/rakazo/tailnet-client/

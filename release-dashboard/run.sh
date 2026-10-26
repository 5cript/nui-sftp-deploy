#!/usr/bin/env bash
# Release dashboard for nui-sftp: a local web page that runs the release steps (prepare, five test targets, publish)
# with red/green checks, live logs and the human steps (push, PRs, merge) in between.
# Usage: release-dashboard/run.sh --version X.Y.Z [--port 8740] [--deploy-root <dir>] [--test-vm <dir>] [--no-open]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null || { echo "node is not installed" >&2; exit 1; }
exec node "$here/server.mjs" "$@"

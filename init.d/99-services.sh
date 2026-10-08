#!/bin/bash
set -euo pipefail
# ENV credentials belong to first launch; upstream otherwise overrides saved settings on every start.
for variable in USERNAME PASSWORD ${!CLOUDCMD_@} ${!cloudcmd_@}; do
    unset "$variable"
done
exec pm2-runtime --no-auto-exit /usr/local/lib/codex-docker/ecosystem.config.js

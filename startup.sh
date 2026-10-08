#!/bin/bash
set -euo pipefail
export LC_ALL=C

scripts=()
for script in "${1:-/etc/codex-init.d}"/*; do
    if [[ -f "$script" && -x "$script" ]]; then
        scripts+=("$script")
    fi
done

if (( ${#scripts[@]} == 0 )); then
    echo "No executable initialization files found; refusing to start." >&2
    exit 1
fi

for script in "${scripts[@]:0:${#scripts[@]}-1}"; do
    "$script"
done
exec "${scripts[-1]}"

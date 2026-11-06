#!/usr/bin/env bash
# dev/update.sh — rebuild docket and load the new build into a local vault.
#
# Installs the CLI with scripts/install.sh, links the plugin into the vault,
# then turns the plugin off and on in Obsidian so it loads the build. Runs the
# same from any directory. Needs Bun; the reload also needs Obsidian's CLI.
#
#   dev/update.sh /path/to/vault
#   DOCKET_VAULT=/path/to/vault dev/update.sh
#
# The plugin files are symlinks into this clone, so keep the clone in place.

set -euo pipefail

ID=ctx42-docket

VAULT="${1:-${DOCKET_VAULT:-}}"
if [ -z "$VAULT" ]; then
    echo "usage: update.sh <vault-path> (or set DOCKET_VAULT)" >&2
    exit 2
fi
[ -d "$VAULT" ] || { echo "update: not a directory: $VAULT" >&2; exit 1; }
VAULT="$(cd "$VAULT" && pwd)"  # absolute, before leaving the caller's directory
NAME="$(basename "$VAULT")"    # Obsidian names a vault after its folder

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # repo root
./scripts/install.sh
bun run deploy:plugin "$VAULT" --link

if ! command -v obsidian >/dev/null 2>&1; then
    echo "update: obsidian command not found; reload $ID by hand" >&2
    exit 0
fi

# Obsidian's CLI exits 0 even when a command fails, so the plugin's reported
# state decides the result, not the exit codes.
obsidian "vault=$NAME" plugin:disable "id=$ID" >/dev/null
obsidian "vault=$NAME" plugin:enable "id=$ID" >/dev/null
INFO="$(obsidian "vault=$NAME" plugin "id=$ID" 2>&1)"
if grep -q '^enabled[[:space:]]*true' <<<"$INFO"; then
    echo "update: reloaded $ID in $NAME"
else
    echo "update: could not reload $ID in $NAME: $INFO" >&2
    echo "update: enable it under Settings → Community plugins" >&2
fi

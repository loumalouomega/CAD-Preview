#!/usr/bin/env bash
# Bumps the patch version, builds, packages, and installs this extension into
# the currently running VS Code — the workflow CLAUDE.md's "Verify a change"
# section documents for Remote/SSH: the running extension there is the
# installed copy under ~/.vscode-server/extensions/, not the workspace dist/,
# so a rebuild alone never reaches the editor. Safe to run locally too (falls
# back to `code`'s normal user extensions dir when not on Remote/SSH).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME=$(node -p "require('./package.json').name")
PUBLISHER=$(node -p "require('./package.json').publisher")
EXT_ID="${PUBLISHER}.${NAME}"

echo "==> Bumping patch version"
npm version patch --no-git-tag-version >/dev/null
VERSION=$(node -p "require('./package.json').version")
echo "    ${EXT_ID}@${VERSION}"

echo "==> Building"
npm run build

echo "==> Packaging"
rm -f "${NAME}"-*.vsix
npx vsce package >/dev/null
VSIX="${NAME}-${VERSION}.vsix"

CODE_CLI="$(command -v code || command -v code-server || true)"
if [ -z "$CODE_CLI" ]; then
  echo "!! No 'code' or 'code-server' CLI on PATH — built ${VSIX} but did not install it."
  exit 0
fi

echo "==> Installing via '${CODE_CLI} --install-extension'"
"$CODE_CLI" --install-extension "$VSIX"

# Remote/SSH keeps every installed version's directory around; an older one
# left in place has occasionally been the wrong copy VS Code activates.
EXT_DIR="${HOME}/.vscode-server/extensions"
if [ -d "$EXT_DIR" ]; then
  STALE=$(find "$EXT_DIR" -maxdepth 1 -name "${EXT_ID}-*" ! -name "${EXT_ID}-${VERSION}")
  if [ -n "$STALE" ]; then
    echo "==> Removing stale install(s):"
    echo "$STALE" | sed 's/^/    /'
    echo "$STALE" | xargs -r rm -rf
  fi
fi

echo
echo "==> Done: ${EXT_ID}@${VERSION} installed."
echo "==> Reload the window (Developer: Reload Window) to pick it up."

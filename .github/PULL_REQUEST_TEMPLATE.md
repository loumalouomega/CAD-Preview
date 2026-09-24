# Pull Request

## What changed, and why

<!-- One or two sentences. If this closes an issue, write "Closes #NN". If it
     implements a doc/roadmap.md item, name the item by NAME (never by number —
     numbering is not stable across closes). -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactoring / dependency / build maintenance
- [ ] Test harness only

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` green
- [ ] `npm run build` clean
- Kernel/MCP-pipeline changes: [ ] `npm run mcp:smoke` green (live WASM)
- Viewer markup/panel changes: [ ] `npm run test:webview` green, [ ] `npm run docs:screenshots` regenerated and visually inspected (at least one full 3D shot — see CLAUDE.md's "inspect the images, not the exit code")
- Extension-host flows (provider.ts, watchers, dialogs): [ ] exercised in a real Extension Development Host (F5) session, or the remaining manual-verification gap stated below
- Save/watch/recovery flows: [ ] `npm run test:integration` green where touched

## Docs kept in sync

Per CLAUDE.md's "Keep docs in sync" header — update everything the change touches, as part of the change:

- [ ] Protocol messages changed → `doc/protocol.md`
- [ ] File-format behavior changed → `doc/file-formats.md` + the format tables in `README.md` / `doc/index.md` / `doc/getting-started.md`
- [ ] Module/API surface changed → `doc/extension-host-api.md` and/or `doc/webview-api.md`
- [ ] UI/toolbar flows changed → `doc/getting-started.md`
- [ ] Non-obvious gotchas or verifications → `CLAUDE.md`
- [ ] MCP surface changed → `doc/mcp-server.md` (+ `scripts/mcp-smoke/run.mjs` where relevant)

## Notes

<!-- Verification gaps that no automated check reached, stated plainly. If a
     new bundled dependency ships in the .vsix, note its license and say why
     it is GPL-3.0-compatible (CLAUDE.md's "License" section). Roadmap items
     are named by heading, never "roadmap item N" — path names and quoted
     historical mentions excepted, see .github/PULL_REQUEST_TEMPLATE.md's
     sibling check in npm test. -->

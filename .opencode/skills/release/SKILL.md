---
name: CAD-Preview release
description: Use when cutting a CAD-Preview release or bumping its version — updating CHANGELOG.md, running npm version, committing and pushing, creating the git tag and pushing it (which triggers CI to package, publish to the Marketplace and create the GitHub Release). Trigger on "release", "cut a version", "bump the version", "tag vX.Y.Z", "publish to the Marketplace", or any request to write the changelog entry for a new version.
---

# CAD-Preview release

## Why the order matters

A pushed tag **is** the release trigger (`.github/workflows/ci.yml`, job `release`): CI builds and tests that commit, packages the VSIX, publishes to the Marketplace and creates the GitHub Release. The version bump and changelog must therefore be committed and pushed **before** the tag exists. A tag can be moved freely until it is pushed; afterwards it must never move — the in-flight release run stands down, and the release becomes whatever the new tag points at.

## 1. Decide the version

- Last release: `git describe --tags --abbrev=0`.
- Changes: `git log --oneline vLAST..HEAD` (and read the bodies of non-obvious commits).
- Plain semver, as this project uses it:
  - user-visible feature → minor (3.43.0 → 3.44.0)
  - fixes or dependency bumps only → patch
  - breaks sidecars, protocol or the public API → major (confirm with the user first)
- `package.json` is the only place the version lives.

## 2. Pre-flight

A red `master` makes the release run red, so check before tagging:

- `git status --short` — commit or stash unrelated work first.
- Kernel drift: `npm outdated @meshioplusplus/wasm @loumalouomega/gmsh-wasm opencascade.js float-tetwild-wasm @loumalouomega/mmg-wasm @loumalouomega/openscad-wasm`.
- `npm ls --depth=0` — if it reports invalid/missing packages, run `npm ci`. A drifted `node_modules` manufactures convincing fake test reds (`AGENTS.md`).
- `npm run build` and `npm test` (the latter also runs the `doc/**` example-compile, op-coverage and roadmap-citation gates).
- For kernel or dependency changes, also run `npm run compat`, `npm run mcp:smoke` and `npm run test:webview`. The full pre-tag checklist is in `doc/development.md` → "Release checklist, before tagging".

The tag run repeats build/test/package; it cannot repair a bad commit.

## 3. Bump

```bash
npm version 3.44.0 --no-git-tag-version
```

- `--no-git-tag-version` is required: without it npm creates the tag on the pre-changelog commit, and this project tags only the release commit.
- Never hand-edit or `sed` `package.json` / `package-lock.json`; a blanket sed once rewrote `ipaddr.js` to an unpublished version and broke `npm ci` (`AGENTS.md`). `npm version` updates both files together.

## 4. Changelog

`CHANGELOG.md` conventions:

- Insert `## [X.Y.Z] - YYYY-MM-DD` directly below `## [Unreleased]`; never rename or delete an older section.
- Sections: `### Added`, `### Changed`, `### Fixed`; omit empty ones. One bold lead-in per bullet, then what changed and where it is documented.
- Summarise from `git log vLAST..HEAD`, not from memory. Include user-visible features, dependency/version changes and notable harness/CI additions; skip pure refactors unless they close a verification gap.
- Quote measured numbers when the feature has them — past entries do.
- Add the compare link at the bottom, above the previous one:
  `[X.Y.Z]: https://github.com/loumalouomega/CAD-Preview/compare/vLAST...vX.Y.Z`
  and retarget `[Unreleased]` to `...compare/vX.Y.Z...HEAD`.

## 5. Commit and push

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "Release X.Y.Z"
git push origin master
```

Match the existing release commit message (`Release 3.43.0`). The master run is a useful second check, but the tag run is the gate that publishes.

## 6. Tag and push (the release trigger)

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

- Tag the release commit itself: `git rev-parse HEAD` and `git rev-parse vX.Y.Z^{commit}` must agree before the push.
- Push the tag explicitly. `git push --follow-tags` does not push lightweight tags, and these tags are lightweight.
- Verify the run with `gh run list --workflow=ci.yml --limit 3` (or the Actions tab), then confirm the GitHub Release and the Marketplace version.

## Failure modes

- **Tag pushed before the release commit:** it points at an older commit. If the release job has not published yet, delete the remote tag, push the commit, re-tag and push again; otherwise cut a new patch version.
- **Release run failed after the tag push:** fix on `master` and cut a new version. Never move, delete or re-push the tag to retry — the newer run stands down and the release name would point at different bits.
- **Mistake in a published changelog:** correct it in a follow-up commit (or under `[Unreleased]`); the tag stays where it is.
- **`npm version` created a tag by mistake** (missing `--no-git-tag-version`): `git tag -d vX.Y.Z` before pushing anything, then redo step 3.

## Verify

```bash
git describe --tags --exact-match    # vX.Y.Z on the release commit
git status --short                   # clean
gh run list --workflow=ci.yml --limit 3
```

The release job publishes only if the remote tag still points at the commit the run was triggered for.

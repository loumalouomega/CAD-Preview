# Contributing

Thank you for your interest in contributing to CAD Preview!

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally: `git clone https://github.com/<your-username>/CAD-Preview.git`
3. **Create a branch** for your change:
   ```bash
   git checkout -b feat/my-feature
   # or:
   git checkout -b fix/issue-description
   # or:
   git checkout -b docs/update-readme
   ```
4. **Install dependencies**: `npm install`
5. Make your changes, test them, and open a PR against `master`.

## Branch Naming

| Prefix      | Use for                             |
| ----------- | ----------------------------------- |
| `feat/`     | New features                        |
| `fix/`      | Bug fixes                           |
| `docs/`     | Documentation changes only          |
| `refactor/` | Refactoring without behavior change |
| `test/`     | Adding or fixing tests              |

## Development Workflow

See the [Development Guide](./development.md) for build commands, the F5 test checklist, and the test suite.

Before opening a PR, run the full cycle:

```bash
npm run build    # must succeed (no type errors)
npm test         # all tests must pass
```

## Commit Style

Commits in this repository use Spanish or English — either is fine. Keep commit messages short and descriptive.

Examples:

```
Agregar soporte para formato XYZ
Fix OCCT memory leak on repeated file opens
docs: update architecture diagram
```

## Code Style

- **TypeScript strict mode** is enforced (`"strict": true` in `tsconfig.json`). No `@ts-ignore` without an accompanying comment explaining why.
- **`any`** is only acceptable for raw OCCT handle types (where upstream `opencascade.js` typings are incomplete). Mark these with `// eslint-disable-next-line @typescript-eslint/no-explicit-any` if a linter is added.
- **`const`-first.** Use `const` for all declarations unless mutation is required.
- **No silent error swallowing.** `catch (e) {}` (empty catch) is not acceptable. At minimum, post an `error` message to the webview or re-throw.
- **Comments** only for non-obvious reasoning — the WHY, not the WHAT. Avoid restating what the code does.

## OCCT Memory Discipline

Every OCCT object created in the extension host is an Emscripten heap handle that must be explicitly freed. The singleton (`getOcct()`) is never freed, but every per-file object must be:

```typescript
const cleanup: { delete(): void }[] = []
try {
  const someOcctObject = new oc.SomeClass()
  cleanup.push(someOcctObject)
  // ... use it
} finally {
  // Delete in reverse order (inner dependencies before outer)
  for (let i = cleanup.length - 1; i >= 0; i--) {
    cleanup[i].delete()
  }
}
```

Forgetting to `.delete()` an OCCT handle causes the WASM heap to grow unboundedly. Test for leaks by opening/closing a large STEP file 20+ times and watching extension host process memory.

## Adding a New File Format

To support a new file format, make changes in the following places:

1. **`src/fileRouter.ts`** — Add the new extension(s) to `EXTENSION_MAP`:

   ```typescript
   '.xyz': { strategy: 'three', format: 'xyz' },
   ```

   Also add `'xyz'` to the `CadFormat` union type.

2. **`package.json`** — Add the extension to `contributes.customEditors[0].selector`:

   ```json
   { "filenamePattern": "*.xyz" }
   ```

3. **Loader or parser:**
   - For a pre-triangulated mesh format: add a branch to `loadMeshFromUrl()` in `src/webview/meshLoaders.ts`.
   - For a B-rep format requiring OCCT: add a reader branch to `readShape()` in `src/occtService.ts`.

4. **`examples/`** — Add at least one test fixture file to `examples/<FORMAT>/` for manual testing. Update `examples/README.md` if it exists.

5. **Tests** — Add test cases to the relevant test file (`src/fileRouter.test.ts` at minimum to verify routing; and a loader/parser test if the new code path is non-trivial).

6. **Export (optional)** — If the format should also be an export *target*, add a writer: for a mesh format, a branch in `exportModel()` (`src/webview/meshExporters.ts`); for a B-rep format, a branch in `writeShape()` (`src/occtService.ts`). Then add it to the relevant list in `exportTargetsFor()` (`src/exportTargets.ts`) and its extension/label in `EXPORT_EXTENSION`/ `EXPORT_LABEL`. There is no writer path from a mesh format back to a B-rep format — don't add a B-rep target for a mesh source.

7. **Docs** — Update `doc/file-formats.md`, the format tables in `README.md` / `doc/index.md` / `doc/getting-started.md`, and `doc/extension-host-api.md` / `doc/webview-api.md` for whichever module changed. See [CLAUDE.md](https://github.com/loumalouomega/CAD-Preview/blob/master/CLAUDE.md)'s "Keep docs in sync" section.

## Architecture Constraints

The following are **non-negotiable** invariants. PRs that violate them will not be merged:

- **OCCT WASM runs in the extension host, never in the webview.** The webview CSP forbids the unsafe WASM initialization pattern that OCCT requires.
- **Never initialize OCCT in `activate()`.** The singleton is lazy — initialized only on the first B-rep open. Do not call `getOcct()` eagerly.
- **The orientation cube must not create its own `WebGLRenderer`.** It draws via scissor viewport into the main renderer. A second WebGL context fails in constrained environments.
- **`setupViewControls()` in `main.ts` must be wrapped in `try/catch`** and run before the `ready` handshake. A UI wiring failure must never block model loading.
- **B-rep export targets are written in the host via OCCT; mesh export targets are written in the webview via Three.js exporters.** This build of OCCT has no STL/OBJ/PLY/glTF writers and no path from a mesh back to a B-rep — don't try to route mesh-to-B-rep export through OCCT, and don't move B-rep writing into the webview (same CSP/WASM reasoning as reading).

## Submitting a Pull Request

1. Ensure `npm run build` and `npm test` pass locally.
2. Open a PR against `master` with a clear description of the change and why it's needed.
3. For non-trivial changes, include a manual test checklist (which fixtures you tested, which UI interactions you verified).
4. If your change affects the public API or architecture, update the relevant pages in `doc/`.

## Reporting Issues

Please open an issue on [GitHub Issues](https://github.com/loumalouomega/CAD-Preview/issues) with:

- VS Code version and operating system.
- The file format and approximate file size.
- Steps to reproduce.
- If possible, attach a minimal test file that reproduces the problem.

Do **not** attach files containing proprietary geometry without permission from the file's owner.

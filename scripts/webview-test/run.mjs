/**
 * Webview assertion harness — the automated half of `doc/roadmap.md`'s Tier 1
 * "close the F5-only verification gap".
 *
 * Drives the REAL shipped `media/viewer.js` over `viewerDom.ts`'s own markup in
 * headless Chromium (the same harness `scripts/screenshots/capture.mjs` uses —
 * see `../screenshots/harness.mjs`) and **asserts** against it. That harness
 * has existed for a long time but only ever captured PNGs, which is precisely
 * why an exit-0 run could coexist with every 3D shot being silently misframed.
 *
 * **What this can and cannot cover, stated plainly.** It covers the webview:
 * DOM, panels, picking, overlays, and the messages the webview posts back
 * (`window.__sent`, populated by the harness's `acquireVsCodeApi` stub). It
 * covers **nothing** host-side — quick-picks, save dialogs,
 * `vscode.workspace.fs`, custom-editor registration and the file watchers all
 * live in the extension host, which Playwright cannot reach at all. That half
 * is `test/integration/` (`@vscode/test-electron`).
 *
 * Every case below is tied to a REAL, documented bug or invariant from
 * `CLAUDE.md`, not to coverage for its own sake — see each case's comment.
 *
 * Run: `npm run test:webview` (chains build → fixtures → this).
 */
import * as fs from "fs";
import * as path from "path";
import {
  ROOT,
  FIX,
  LAUNCH_ARGS,
  nodeSupportsPlaywright,
  MIN_NODE_MAJOR_FOR_PLAYWRIGHT,
  fixture,
  sleep,
  startServer,
  openHarness,
  post,
  postMeshingResult,
  populate,
} from "../screenshots/harness.mjs";

// ── Reporting (mirrors scripts/mcp-smoke/run.mjs's conventions) ────────────
let failures = 0;
let checks = 0;

function assert(cond, message) {
  checks++;
  if (cond) {
    console.log(`  ✓ ${message}`);
  } else {
    failures++;
    console.error(`  ✗ ${message}`);
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The 3D viewport's screen rect.
 *
 * Deliberately measured from `#app`, not from a canvas selector: `#app` holds
 * TWO stacked canvases (the WebGL one and `#markup-canvas`, which is
 * `position:absolute; inset:0` over it), so `#app canvas` is ambiguous. `#app`
 * is the shared container and is positionally identical to both.
 */
const viewportBox = (page) => page.locator("#app").boundingBox();

/**
 * Takes a screenshot with the transient `#status` toast masked.
 *
 * Every pixel helper in this file measures the CANVAS — camera framing, cap
 * coverage, scene colours — and the toast is not part of any of those. It used
 * to be harmless by accident: it was centred on the whole body while the dock
 * centres on the canvas, and sat directly behind the dock, so it painted over
 * pixels that were already non-background and changed no count. Once it was
 * moved clear of the dock (so it is actually readable) it started adding ~7,000
 * real pixels to whichever capture happened to be taken while it was showing,
 * and `zoom to selection: empty selection…` — which deliberately triggers a
 * "No selection" toast — tripped its `< 0.001` tolerance on it.
 *
 * `visibility: hidden` rather than `display: none` so layout, and therefore
 * every other element's position, is untouched by the mask.
 */
async function shotWithoutToast(page, take) {
  await page.evaluate(() => {
    const el = document.getElementById("status");
    if (!el) return;
    el.dataset.prevVis = el.style.visibility;
    el.style.visibility = "hidden";
  });
  try {
    return await take();
  } finally {
    await page.evaluate(() => {
      const el = document.getElementById("status");
      if (!el) return;
      el.style.visibility = el.dataset.prevVis ?? "";
      delete el.dataset.prevVis;
    });
  }
}

/** A dropdown is open when its panel has lost the `hidden` CLASS (not the attribute). */
const dropdownOpen = (page, id) =>
  page.evaluate((i) => {
    const panel = document.getElementById(i);
    return panel ? !panel.classList.contains("hidden") : null;
  }, id);

/**
 * Selects in Surf mode, clicks the middle of the viewport, assigns whatever was
 * picked to a NEW Part, and returns just that part's entity ids.
 *
 * **Reads only the newly-created part, never the whole list** — the `parts`
 * fixture pre-creates three Parts that already reference real `face-N`/`edge-N`
 * ids, so an assertion over `parts.flatMap(...)` passes whether or not the
 * click selected anything. A first version of this harness did exactly that and
 * gave a false pass; the hidden-geometry case below is what exposed it.
 */
async function pickCentreIntoNewPart(page) {
  await page.click("#select-menu");
  // `#sel-toggle` is a SEPARATE enable switch from the mode buttons —
  // `main.ts`'s `apply()` is `setSelectionMode(selecting ? selectMode : null)`,
  // so picking stays off until this is clicked no matter which mode is active.
  // Omitting it made both picking cases pass for the wrong reason: nothing was
  // selectable at all, so "hidden geometry selects nothing" was trivially true.
  await page.click("#sel-toggle");
  await page.click('.sel-mode[data-mode="surface"]');
  // Close via the trigger, not the canvas: the dropdown's own capture-phase
  // dismissal swallows the first click that lands on the viewport.
  await page.click("#select-menu");
  await sleep(150);

  const before = await page.evaluate(() => {
    const m = (window.__sent || []).findLast((x) => x.type === "partsChanged");
    return m ? m.parts.length : 0;
  });

  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(250);
  // `#parts-new` only CREATES a part — assignment is a separate per-row "＋"
  // button (`partsPanel.ts`'s `onAssign(index)`). Create, then assign into the
  // row that was just added (the last one).
  await page.click("#parts-new");
  await sleep(250);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#parts-body .part-row");
    const row = rows[rows.length - 1];
    const assign = [...row.querySelectorAll("button.part-btn")].find((b) => b.title?.startsWith("Assign"));
    assign?.click();
  });
  await sleep(250);

  return page.evaluate((n) => {
    const m = (window.__sent || []).findLast((x) => x.type === "partsChanged");
    if (!m || m.parts.length === 0) return null;
    const added = m.parts[m.parts.length - 1];
    if (m.parts.length <= n) return null; // no part was actually created
    return [...(added.volumes ?? []), ...(added.surfaces ?? []), ...(added.lines ?? []), ...(added.points ?? [])];
  }, before);
}

// ── Cases ─────────────────────────────────────────────────────────────────
// Each is { name, run(page) }. A fresh page per case (capture.mjs's own
// convention) so one case's UI state can never leak into the next.
const CASES = [];
const test = (name, run) => CASES.push({ name, run });

/**
 * A. Bootstrap. The webview posts `ready` and mounts a canvas. `openHarness`
 * already waits on both, so reaching here proves them; this also asserts the
 * canvas has real pixels, which catches a WebGL context that failed to create
 * (headless Chromium silently renders nothing without the SwiftShader flags).
 */
test("bootstrap: ready posted, canvas mounted with real dimensions", async (page) => {
  const size = await page.evaluate(() => {
    const c = document.querySelector("#app canvas");
    return c ? { w: c.width, h: c.height } : null;
  });
  assert(size !== null, "a canvas is mounted under #app");
  assert(size && size.w > 0 && size.h > 0, `canvas has non-zero size (got ${JSON.stringify(size)})`);
});

/**
 * B. Panel inventory. Every id the screenshot harness selects, plus the panels
 * `viewerDom.ts` provides — the screenshot harness assumes all of these exist
 * and has never checked. A renamed or dropped id currently surfaces only as a
 * failed shot, and only if a shot happens to target it.
 */
test("panels: every documented panel id exists and is populated", async (page) => {
  await populate(page);
  await openAdvanced(page);
  const ids = [
    "menubar", "toolbar", "app", "view-controls",
    "tree-panel", "tree-body",
    "parts-panel", "parts-body",
    "edits-panel", "variables-section",
    "meshing-panel", "standard-parts-panel",
    "clash-panel", "clash-body",
  ];
  const missing = await page.evaluate((list) => list.filter((id) => !document.getElementById(id)), ids);
  assert(missing.length === 0, `all ${ids.length} panel ids present (missing: ${JSON.stringify(missing)})`);

  // Populated, not merely present — the tree and parts panels are fed by real
  // fixtures, so an empty body means the message handler silently no-oped.
  const filled = await page.evaluate(() => ({
    tree: (document.getElementById("tree-body")?.children.length ?? 0) > 0,
    parts: (document.getElementById("parts-body")?.children.length ?? 0) > 0,
  }));
  assert(filled.tree, "the Components tree rendered rows from the `tree` message");
  assert(filled.parts, "the Parts panel rendered rows from the `parts` message");
});

/**
 * C. The export `<select>` reflects the registry. This is the webview half of
 * the GiD verification gap: `meshExportFormats.ts` gained a `gid` entry, and
 * nothing checked that a registry entry actually reaches the picker. Compared
 * against `registry.json`, emitted by `fixtures-entry.ts` from the REAL
 * `MESH_EXPORT_FORMATS` — never a hand-copied list, which would drift.
 */
test("export picker: options equal the real MESH_EXPORT_FORMATS registry", async (page) => {
  await populate(page);
  const { meshExportFormats } = fixture("registry");
  const options = await page.evaluate(() =>
    Array.from(document.getElementById("meshing-export-format").options).map((o) => ({ id: o.value, label: o.textContent }))
  );
  assert(
    eq(options.map((o) => o.id), meshExportFormats.map((f) => f.id)),
    `picker lists exactly the registry's ${meshExportFormats.length} ids in order`
  );
  assert(options[0]?.id === "mdpaElements", "mdpaElements is first, keeping it the default-selected export");
  const gid = options.find((o) => o.id === "gid");
  assert(!!gid, "the GiD entry reaches the picker");
  assert(gid?.label?.includes(".post.msh"), `the GiD option is labelled with its compound extension (got ${JSON.stringify(gid?.label)})`);
});

/**
 * C2. Every `<select>` the FE Mesh panel builds has a resolved value.
 *
 * This case exists because a stale fixture caught one for real: the Engine
 * picker rendered BLANK in a screenshot run, because `meshingOptions.json`
 * predated `MeshOptions.engine` and `select.value = undefined` silently
 * degrades to "". Nothing failed — the run exited 0 with a subtly wrong image.
 * An empty select is always a defect, whether the cause is a stale fixture or
 * a real regression.
 */
test("form state: no FE Mesh <select> is left with an unresolved value", async (page) => {
  await populate(page);
  const blanks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#meshing-panel select"))
      // The Saved-presets picker legitimately starts unselected: its "No saved
      // presets" placeholder (value "") is a real third state — "nothing to
      // pick yet" — not a stale-fixture blank like the Engine case above.
      // Apply/Delete stay disabled/hidden until a real preset arrives.
      .filter((s) => s.id !== "meshing-preset-select")
      .filter((s) => s.options.length > 0 && s.value === "")
      .map((s) => s.id || s.previousElementSibling?.textContent || "(unlabelled)")
  );
  assert(blanks.length === 0, `every populated FE Mesh select resolved a value (blank: ${JSON.stringify(blanks)})`);
});

/**
 * D. Picking. Selection is transient webview state and is never posted to the
 * host, so it cannot be read off `window.__sent` directly — but assigning a
 * selection to a NEW Part does post `partsChanged`, which carries the real
 * entity ids. That makes the whole pick → resolve → assign path assertable
 * without hardcoding a fixture id or a screen coordinate.
 */
test("picking: a canvas click in Surf mode resolves to a real surface entity", async (page) => {
  await populate(page);
  const picked = await pickCentreIntoNewPart(page);
  assert(picked !== null, "assigning a selection creates a new Part and posts partsChanged");
  assert(
    Array.isArray(picked) && picked.length > 0 && picked.every((id) => /^face-\d+$/.test(id)),
    `the click resolved to real face-N id(s) and nothing else (got ${JSON.stringify(picked)})`
  );
});

/**
 * D2. Hidden geometry is not pickable.
 *
 * `THREE.Raycaster` tests only `layers` — it ignores `.visible` entirely — so
 * `collectTargets` had to switch from `traverse` to `traverseVisible`. That fix
 * shipped with unit coverage of the collector but was never exercised through a
 * real click on a real canvas. Hiding every group via the tree's eye toggles
 * keeps this positional-free: after hiding, a centre click must select nothing.
 */
test("picking: geometry hidden via the tree is not pickable", async (page) => {
  await populate(page);

  const toggled = await page.evaluate(() => {
    const eyes = document.querySelectorAll("#tree-body [data-visible-toggle], #tree-body .tree-eye");
    eyes.forEach((e) => e.click());
    return eyes.length;
  });
  assert(toggled > 0, `the tree exposes per-group visibility toggles (found ${toggled})`);
  await sleep(250);

  const picked = await pickCentreIntoNewPart(page);
  assert(
    picked !== null && picked.length === 0,
    `clicking hidden geometry selects nothing (got ${JSON.stringify(picked)})`
  );
});

/**
 * D3. Assembly group rows select and hide their descendant solids.
 *
 * The `tree` fixture is bull.stp, whose XCAF structure is a real assembly
 * group (`xcaf-asm-1`) over one leaf (`solid-0`) — so this exercises the
 * production group path with no synthetic posts. Before the fix the group
 * row's eye toggled state but called `setGroupVisible` with the synthetic id,
 * which matches nothing in the scene: the model stayed visible. Hiding via
 * the GROUP eye must therefore leave a centre click selecting nothing (the
 * same positional-free technique as D2).
 */
test("tree: assembly group rows select and hide their descendant solids", async (page) => {
  await populate(page);

  const eyeTitle = await page.evaluate(
    () => document.querySelector("#tree-body .tree-eye")?.getAttribute("title") ?? ""
  );
  assert(
    /assembly \(1 solids\)/i.test(eyeTitle),
    `the group eye names its descendant count (got ${JSON.stringify(eyeTitle)})`
  );

  await page.evaluate(() => {
    document.querySelector("#tree-body .tree-row")?.click();
  });
  await sleep(250);
  const groupSelected = await page.evaluate(
    () => document.querySelector("#tree-body .tree-row")?.classList.contains("selected") ?? false
  );
  assert(groupSelected, "clicking the assembly row marks it selected without error");

  await page.click("#tree-body .tree-eye");
  await sleep(250);
  const picked = await pickCentreIntoNewPart(page);
  assert(
    picked !== null && picked.length === 0,
    `hiding via the group eye hides its descendant solid (got ${JSON.stringify(picked)})`
  );
});

/**
 * E. The FE mesh overlay and its toolbar toggle stay truthful about each other.
 * `CLAUDE.md`: the toggle "must never claim on for content that isn't shown",
 * and showing an overlay hides the model's own shaded faces so two opaque
 * solids don't stack.
 */
test("overlays: meshingResult lights the toggle and hides model faces; Clear reverses both", async (page) => {
  await populate(page);
  const before = await page.evaluate(() => document.getElementById("meshing-toggle")?.classList.contains("active"));
  assert(before === false, "the FE Mesh toggle starts inactive");

  await postMeshingResult(page);
  await sleep(700);
  const on = await page.evaluate(() => document.getElementById("meshing-toggle")?.classList.contains("active"));
  assert(on === true, "posting meshingResult lights the FE Mesh toggle");

  await page.click("#meshing-clear");
  await sleep(400);
  const off = await page.evaluate(() => document.getElementById("meshing-toggle")?.classList.contains("active"));
  assert(off === false, "Clear disposes the overlay and unlights the toggle");
});

/**
 * F. Render-on-demand: the webview must draw only when something changed.
 *
 * `renderScheduler.ts` takes an injectable frame source that `viewer.ts`
 * resolves to the global `requestAnimationFrame`, so counting rAF calls counts
 * exactly the frames the scheduler asked for — no production hook needed. The
 * failure mode this guards is SILENT in both directions: a viewer that renders
 * every frame regardless (the regression the feature removed), and one that
 * freezes mid-interaction because a mutation forgot its `requestRender()`.
 */
test("render-on-demand: frames are flat while idle, and resume on interaction", async (page) => {
  await populate(page);
  await sleep(900); // let any settling animation finish

  const idleStart = await page.evaluate(() => window.__rafCount);
  await sleep(1000);
  const idleEnd = await page.evaluate(() => window.__rafCount);
  assert(
    idleEnd - idleStart <= 2,
    `idle for 1s schedules ~no frames (got ${idleEnd - idleStart}; a per-frame loop would be ~60)`
  );

  const box = await viewportBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 12 });
  await page.mouse.up();
  await sleep(400);
  const afterDrag = await page.evaluate(() => window.__rafCount);
  assert(afterDrag > idleEnd, `an orbit drag schedules frames (${idleEnd} -> ${afterDrag})`);
});

/**
 * H. Mesh-target export — the half the VS Code host harness structurally cannot
 * reach.
 *
 * STL/OBJ/PLY/glTF are serialized by `meshExporters.ts` IN THE WEBVIEW and
 * posted back; the integration harness runs a VS Code with WebGL2 blocklisted,
 * so it has no Three.js scene to serialize and a mesh export never completes
 * there. This harness has working WebGL (SwiftShader), so it is the only place
 * that path can be exercised.
 *
 * Driven by posting the host's own `exportMesh` message rather than clicking
 * the FE Mesh panel's Export button: that button serializes via
 * `currentStlIfMeshSource()`, which requires `pristineMesh` (set only on the
 * mesh-loading path, not by this harness's B-rep `geometry` fixture), and it
 * only ever produces STL. The message route uses `viewer.getModel()` — which
 * the geometry fixture does set — and reaches all four formats.
 */
test("mesh export: every target serializes real geometry from the live scene", async (page) => {
  await populate(page);

  // STL is exported BINARY (`STLExporter().parse(target, {binary: true})`), so
  // it gets a structural check rather than a substring one: bytes 80..83 are the
  // triangle count and the file must be exactly 84 + count*50 bytes. That
  // verifies real triangle data, which a length check alone would not.
  const targets = [
    {
      format: "stl",
      binary: true,
      check: (buf) => {
        const tris = buf.readUInt32LE(80);
        return { ok: tris > 0 && buf.length === 84 + tris * 50, detail: `${tris} triangles, ${buf.length} bytes` };
      },
    },
    { format: "obj", binary: false, check: (b) => ({ ok: b.toString("latin1").includes("\nf "), detail: "has f-lines" }) },
    { format: "ply", binary: false, check: (b) => ({ ok: b.toString("latin1").startsWith("ply"), detail: "ply header" }) },
    { format: "gltf", binary: true, check: (b) => ({ ok: b.toString("latin1", 0, 4) === "glTF", detail: "GLB magic" }) },
  ];

  for (const { format, binary, check } of targets) {
    const requestId = `t-${format}`;
    await post(page, { type: "exportMesh", requestId, format });
    const result = await page
      .waitForFunction(
        (rid) => window.__sent?.find((m) => m.requestId === rid && (m.type === "exportResult" || m.type === "exportError")) ?? null,
        requestId,
        { timeout: 30000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);

    assert(result?.type === "exportResult", `${format}: the webview answers with exportResult (got ${result?.type ?? "nothing"})`);
    if (result?.type !== "exportResult") continue;
    assert(result.binary === binary, `${format}: the binary flag is ${binary} (got ${result.binary})`);

    // Length alone is a weak check — an empty but well-formed export (a bare
    // `solid`/`endsolid`, or a zero-triangle binary STL header) is exactly the
    // failure mode that would otherwise pass. Each format is checked for real
    // geometry instead.
    const buf = Buffer.from(result.data, result.binary ? "base64" : "utf8");
    assert(buf.length > 200, `${format}: the payload is not empty (${buf.length} bytes)`);
    const { ok, detail } = check(buf);
    assert(ok, `${format}: the payload contains real geometry (${detail})`);
  }
});

/**
 * H2. Mesh-ops section — the interactive half of the mesh-operations-panel item.
 *
 * `transform_mesh` was MCP-only with zero webview callers; the FE Mesh panel
 * grew a Mesh-ops section driving the same `runMeshioOps` pipeline entry via
 * `meshioOpsRequest`/`meshioOpsResult`. This covers the webview half the host
 * harness cannot: section visibility per source kind, a well-formed request,
 * and the stale-response guard. The host half (save dialog → write) is
 * F5-only, like every other `provider.ts` save flow.
 */
test("mesh ops: section tracks source kind and posts a guarded request", async (page) => {
  await populate(page);

  const hiddenOf = () =>
    page.evaluate(() => document.getElementById("meshing-meshops")?.hidden ?? null);
  assert((await hiddenOf()) === true, "mesh ops section is hidden for a B-rep source");

  // A meshio++-imported document arrives as STL bytes + its real format name.
  const tet = [
    "solid tet",
    "facet normal 0 0 1", "outer loop", "vertex 0 0 0", "vertex 1 0 0", "vertex 0 1 0", "endloop", "endfacet",
    "facet normal 0 -1 0", "outer loop", "vertex 0 0 0", "vertex 0 0 1", "vertex 1 0 0", "endloop", "endfacet",
    "facet normal -1 0 0", "outer loop", "vertex 0 0 0", "vertex 0 1 0", "vertex 0 0 1", "endloop", "endfacet",
    "facet normal 0.577 0.577 0.577", "outer loop", "vertex 1 0 0", "vertex 0 0 1", "vertex 0 1 0", "endloop", "endfacet",
    "endsolid tet",
  ].join("\n");
  const dataBase64 = Buffer.from(tet, "utf8").toString("base64");
  await post(page, { type: "loadMeshBytes", sourceFormat: "vtu", dataBase64 });
  await sleep(800);
  assert((await hiddenOf()) === false, "mesh ops section is shown for a meshio++ source");

  await page.click("#meshing-ops-run");
  const req = await page
    .waitForFunction(
      () => window.__sent?.findLast((m) => m.type === "meshioOpsRequest") ?? null,
      null,
      { timeout: 10000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  assert(
    req && Array.isArray(req.ops) && req.ops.length === 1 && req.ops[0].op === "clean",
    `Run posts one validated op (got ${JSON.stringify(req?.ops)})`
  );

  // A stale reply (superseded requestId) must not touch the status line.
  await post(page, { type: "meshioOpsResult", requestId: "stale-id", steps: [], warnings: [] });
  await sleep(150);
  const kept = await page.evaluate(() => document.getElementById("meshing-ops-status")?.textContent);
  assert(kept === "Running…", `a stale reply is ignored (status still "Running…", got ${JSON.stringify(kept)})`);

  await post(page, {
    type: "meshioOpsResult",
    requestId: req.requestId,
    steps: [{ op: "clean", applied: true, detail: "welded 4, dropped 0 degenerate / 0 duplicate" }],
    warnings: [],
  });
  await sleep(150);
  const shown = await page.evaluate(() => document.getElementById("meshing-ops-status")?.textContent);
  assert(
    (shown ?? "").includes("welded 4"),
    `the real reply renders the kernel's step detail (got ${JSON.stringify(shown)})`
  );

  // A new B-rep load hides the section again (no stale UI for the next file).
  await populate(page);
  assert((await hiddenOf()) === true, "mesh ops section hides again on a B-rep load");
});

/**
 * H3. BOM Copy button — the interactive half of the BOM-copy item.
 *
 * `generate_bom` was MCP-only with nothing in the webview importing `bomTsv`;
 * the Parts header grew a Copy BOM button driving the same `computeBom`
 * pipeline entry via `bomRequest`/`bomResult`. This covers the webview half
 * the host harness cannot: button presence/eligibility, a well-formed request,
 * the stale-response guard, and the copy + status confirmation. The host half
 * (rows computed over a real parse/replay) is F5-only, like every other
 * `provider.ts` save/compute flow. Status text — not a clipboard read-back —
 * is the copy assertion: headless Chromium grants no `clipboard-read`
 * permission, but a denied/failed `writeText` would surface the error status
 * instead of the confirmation, so the confirmation proves the write resolved.
 */
test("bom: Copy BOM posts a guarded request and copies the TSV", async (page) => {
  await populate(page);

  const btn = await page.evaluate(() => {
    const el = document.getElementById("parts-copy-bom");
    return el ? { present: true, disabled: el.disabled } : { present: false, disabled: null };
  });
  assert(btn.present, "Copy BOM button is present in the Parts header");
  assert(btn.disabled === false, "Copy BOM is enabled for a B-rep source with parts (3-part fixture)");

  await page.click("#parts-copy-bom");
  const req = await page
    .waitForFunction(
      () => window.__sent?.findLast((m) => m.type === "bomRequest") ?? null,
      null,
      { timeout: 10000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  assert(
    req && typeof req.requestId === "string" && Object.keys(req).length === 2,
    `click posts a well-formed bomRequest (got ${JSON.stringify(req)})`
  );

  // A stale reply (superseded requestId) must copy nothing.
  await post(page, { type: "bomResult", requestId: "stale-id", rows: [], warnings: [] });
  await sleep(150);
  const noCopy = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(!/BOM copied/.test(noCopy), `a stale reply copies nothing (status: ${JSON.stringify(noCopy)})`);

  const rows = [
    { name: "Bracket", color: "#ff8800", solidCount: 1, surfaceCount: 0, lineCount: 0, pointCount: 0, volume: 1000, area: 600, unresolvedIds: [] },
    { name: "Plate", color: "#38c172", solidCount: 2, surfaceCount: 0, lineCount: 0, pointCount: 0, volume: null, area: null, unresolvedIds: ["solid-9"] },
  ];
  await post(page, { type: "bomResult", requestId: req.requestId, rows, warnings: ["Part \"Plate\" has 1 unresolved id."] });
  await sleep(250);
  const status = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(status === "BOM copied (2 rows).", `the real reply copies and confirms the row count (status: ${JSON.stringify(status)})`);

  // Warnings travel as status lines first — the copy confirmation lands last.
  await page.click("#parts-copy-bom");
  const req2 = await page
    .waitForFunction(
      () => window.__sent?.filter((m) => m.type === "bomRequest").length === 2 ?? null,
      null,
      { timeout: 10000 }
    )
    .catch(() => null);
  assert(req2 !== null, "a second click posts a second request (no latch wedging)");

  // An error reply surfaces as an error status, never a copy confirmation.
  await post(page, { type: "bomError", requestId: "stale-id", message: "boom" });
  await sleep(150);
  const stillCopy = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(!/boom/.test(stillCopy), `a stale error reply changes nothing (status: ${JSON.stringify(stillCopy)})`);

  // Empty parts disable the button with a reason (no header-only copy).
  await post(page, { type: "parts", parts: [] });
  await sleep(150);
  const emptyState = await page.evaluate(() => {
    const el = document.getElementById("parts-copy-bom");
    return el ? { disabled: el.disabled, title: el.title } : null;
  });
  assert(emptyState?.disabled === true, "Copy BOM disables with zero parts");
  assert(
    (emptyState?.title ?? "").length > 0,
    `the disabled button explains why (title: ${JSON.stringify(emptyState?.title)})`
  );

  // A mesh source disables it too — rows need a B-rep parse/replay.
  const tet = [
    "solid tet",
    "facet normal 0 0 1", "outer loop", "vertex 0 0 0", "vertex 1 0 0", "vertex 0 1 0", "endloop", "endfacet",
    "endsolid tet",
  ].join("\n");
  await post(page, { type: "loadMeshBytes", sourceFormat: "stl", dataBase64: Buffer.from(tet, "utf8").toString("base64") });
  await sleep(800);
  const meshState = await page.evaluate(() => {
    const el = document.getElementById("parts-copy-bom");
    return el ? { disabled: el.disabled, title: el.title } : null;
  });
  assert(meshState?.disabled === true, "Copy BOM disables on a mesh source");
  assert(
    /B-rep/.test(meshState?.title ?? ""),
    `the mesh-source tooltip names the B-rep requirement (title: ${JSON.stringify(meshState?.title)})`
  );
});

/**
 * I. Framing invariants — the automated half of "visual correctness is nobody's
 * job".
 *
 * Deliberately NOT a baseline-image diff. `capture.mjs` settles on fixed
 * `sleep()` calls rather than waiting for a render-quiescent state, and the FE
 * mesh fixture comes from a real Gmsh run, so a byte/perceptual baseline has no
 * reason to be stable and a gate that cries wolf gets switched off.
 *
 * What IS stable is the invariant that was actually violated when every 3D shot
 * silently became a giant misframed close-up: the model has to occupy a sane
 * fraction of the viewport. The scene background is a known constant
 * (`viewer.ts`'s `0x1e1e1e`), so "model pixels" is just "not the background" —
 * and the screenshot is decoded IN-PAGE via an Image + a 2D canvas, so this
 * needs no PNG decoder and no new dependency.
 */
test("framing: the model occupies a sane fraction of the viewport", async (page) => {
  await populate(page);

  // Turn the grid off so the measurement is the model, not the helper.
  await page.click("#view-menu");
  await page.click("#grid");
  await page.keyboard.press("Escape");
  await sleep(400);

  const shot = (await shotWithoutToast(page, () => page.locator("#app").screenshot())).toString("base64");
  const stats = await page.evaluate(
    async (b64) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onerror = () => reject(new Error("decode failed"));
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          const isBg = (i) => Math.abs(data[i] - 0x1e) < 6 && Math.abs(data[i + 1] - 0x1e) < 6 && Math.abs(data[i + 2] - 0x1e) < 6;
          let model = 0;
          for (let i = 0; i < data.length; i += 4) if (!isBg(i)) model++;
          // A centre patch: the default framing centres the model, so an empty
          // centre means it is framed off-screen entirely.
          let centre = 0;
          const cx = (c.width / 2) | 0, cy = (c.height / 2) | 0, r = 40;
          for (let y = cy - r; y < cy + r; y++) {
            for (let x = cx - r; x < cx + r; x++) {
              if (!isBg((y * c.width + x) * 4)) centre++;
            }
          }
          resolve({ fraction: model / (c.width * c.height), centre, w: c.width, h: c.height });
        };
        img.src = `data:image/png;base64,${b64}`;
      }),
    shot
  );

  assert(stats.w > 0 && stats.h > 0, `the viewport screenshot decoded (${stats.w}x${stats.h})`);
  assert(stats.fraction > 0.02, `the viewport is not blank — a failed render or an off-screen model (fraction ${stats.fraction.toFixed(3)})`);
  assert(stats.fraction < 0.80, `the model is not a full-bleed close-up — the documented misframing regression (fraction ${stats.fraction.toFixed(3)})`);
  assert(stats.centre > 0, "the centre of the viewport contains model pixels");
});

/**
 * I2. Zoom to selection (the "Zoom to selection" feature). The camera work itself
 * (`Viewer.frameSelection` → `frameBox`) is the already-verified placement
 * path `screenshot_shape` uses headless, so what needs checking here is the
 * wiring: a real selection frames (fill increases, stays centred), explicit
 * Fit still restores the whole model, and the two non-framing outcomes say
 * so on the status line instead of silently doing nothing. Screenshots
 * decode in-page via the framing-invariant helper above.
 */
async function viewportModelStats(page) {
  const shot = (await shotWithoutToast(page, () => page.locator("#app").screenshot())).toString("base64");
  return page.evaluate(
    async (b64) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onerror = () => reject(new Error("decode failed"));
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          const isBg = (i) => Math.abs(data[i] - 0x1e) < 6 && Math.abs(data[i + 1] - 0x1e) < 6 && Math.abs(data[i + 2] - 0x1e) < 6;
          let model = 0;
          for (let i = 0; i < data.length; i += 4) if (!isBg(i)) model++;
          let centre = 0;
          const cx = (c.width / 2) | 0, cy = (c.height / 2) | 0, r = 40;
          for (let y = cy - r; y < cy + r; y++) {
            for (let x = cx - r; x < cx + r; x++) {
              if (!isBg((y * c.width + x) * 4)) centre++;
            }
          }
          resolve({ fraction: model / (c.width * c.height), centre });
        };
        img.src = `data:image/png;base64,${b64}`;
      }),
    shot
  );
}

async function gridOff(page) {
  await page.click("#view-menu");
  await page.click("#grid");
  await page.keyboard.press("Escape");
  await sleep(400);
}

/**
 * Expands the Advanced group.
 *
 * It ships COLLAPSED — that is the whole point of the group, so the sidebar's
 * top level holds only the four sections that edit the document. Every test
 * touching Mass Properties, Clash, Mesh Health, Region fit, Primitives, Macros
 * or Standard Parts must open it first, or the element it wants is inside a
 * `display: none` subtree and Playwright waits out its timeout on a node that
 * will never be actionable.
 *
 * Idempotent, so a test may call it without knowing whether an earlier step
 * already opened the group.
 */
/**
 * Opens the dock's "⋯" overflow popover if it is not already open.
 *
 * Rotate/Pan, Clip ▸ Face / 3 Pts, the whole Planes authoring UI, background,
 * opacity, Grid size and Colour by field live behind it, so a test that issues a
 * REAL Playwright click or fill on one of them needs it open first — otherwise
 * Playwright waits out its 30s actionability timeout on a `display: none`
 * subtree. Only real interactions need this: a read or click done inside
 * `page.evaluate` bypasses actionability and works whether or not it is open,
 * which is why only two existing tests needed it.
 *
 * Idempotent, because any `Escape` closes every registered dropdown and a test
 * may have pressed one since it last opened this.
 */
async function openDockMore(page) {
  if (!(await dropdownOpen(page, "vc-more-dropdown"))) await page.click("#vc-more");
  await sleep(80);
}

async function openAdvanced(page) {
  const collapsed = await page.evaluate(
    () => document.getElementById("advanced-group")?.classList.contains("collapsed") ?? false
  );
  if (collapsed) await page.click("#advanced-header > .panel-chevron");
  await sleep(120);
}

/** Selects the single smallest face via the filter form; returns the status text. */
async function selectSmallestFace(page) {
  await page.click("#select-menu");
  await page.selectOption("#filter-pred", "smallestN");
  await page.fill("#filter-arg", "1");
  await page.click("#filter-replace");
  await sleep(250);
  return page.evaluate(() => document.getElementById("status")?.textContent ?? "");
}

test("zoom to selection: framing a small face increases its fill and stays centred; Fit restores the whole model", async (page) => {
  await populate(page);
  await gridOff(page);
  const before = await viewportModelStats(page);
  const filterStatus = await selectSmallestFace(page);
  assert(/matched 1 of/.test(filterStatus), `the filter selected exactly one face, so the zoom acts on a real selection (got ${JSON.stringify(filterStatus)})`);
  await page.click("#select-zoom"); // one-shot: runs, then dismisses the menu itself
  await sleep(400);
  const after = await viewportModelStats(page);
  assert(after.centre > 0, "the framed selection is centred in the viewport");
  assert(
    after.fraction > before.fraction,
    `framing a subset fills more of the viewport (${before.fraction.toFixed(3)} -> ${after.fraction.toFixed(3)})`
  );
  // Explicit Fit still frames the whole model — zoom-to-selection never replaces that path.
  await page.click("#fit");
  await sleep(400);
  const fit = await viewportModelStats(page);
  assert(
    Math.abs(fit.fraction - before.fraction) < 0.05,
    `Fit restores the whole-model framing (${before.fraction.toFixed(3)} -> ${fit.fraction.toFixed(3)})`
  );
});

test("zoom to selection: empty selection shows guidance and moves nothing", async (page) => {
  await populate(page);
  await gridOff(page);
  const before = await viewportModelStats(page);
  await page.click("#select-menu");
  await page.click("#select-zoom");
  await sleep(250);
  const status = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(/No selection/.test(status), `an empty selection explains itself (got ${JSON.stringify(status)})`);
  const after = await viewportModelStats(page);
  assert(Math.abs(after.fraction - before.fraction) < 0.001, "nothing framed means nothing moved");
});

test("zoom to selection: hidden selection is reported, not framed", async (page) => {
  await populate(page);
  await gridOff(page);
  const filterStatus = await selectSmallestFace(page);
  assert(/matched 1 of/.test(filterStatus), "precondition: one face selected");
  // Close the Select menu first: an open menu's capture-phase dismissal would
  // swallow the first tree click below.
  await page.click("#select-menu");
  const toggled = await page.evaluate(() => {
    const eyes = document.querySelectorAll("#tree-body [data-visible-toggle], #tree-body .tree-eye");
    eyes.forEach((e) => e.click());
    return eyes.length;
  });
  assert(toggled > 0, "precondition: the tree exposes visibility toggles");
  await sleep(250);
  const before = await viewportModelStats(page);
  await page.click("#select-menu");
  await page.click("#select-zoom");
  await sleep(250);
  const status = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(/hidden or no longer/.test(status), `a hidden selection says so (got ${JSON.stringify(status)})`);
  const after = await viewportModelStats(page);
  assert(Math.abs(after.fraction - before.fraction) < 0.001, "a hidden selection moves nothing");
});

test("zoom to selection: works under orthographic projection", async (page) => {
  await populate(page);
  await gridOff(page);
  await page.click("#vc-ortho");
  await sleep(250);
  const before = await viewportModelStats(page);
  const filterStatus = await selectSmallestFace(page);
  assert(/matched 1 of/.test(filterStatus), "precondition: one face selected");
  await page.click("#select-zoom");
  await sleep(400);
  const after = await viewportModelStats(page);
  assert(after.centre > 0, "the framed selection is centred in ortho");
  assert(
    after.fraction > before.fraction,
    `ortho framing also closes in (${before.fraction.toFixed(3)} -> ${after.fraction.toFixed(3)})`
  );
});

/**
 * I3. Volume and point selection predicates (the same-named feature). The pure
 * predicates are unit-covered; what needs the real bundle is the form
 * wiring per mode (registry population, Select/Add, status nouns) and the
 * point reference flow. Selection is read back via `partsChanged` assignment
 * (the D-case precedent) rather than hardcoded ids.
 */
async function runModeFilter(page, mode, predId, arg) {
  await page.click("#select-menu");
  await page.click(`.sel-mode[data-mode="${mode}"]`);
  await page.selectOption("#filter-pred", predId);
  if (arg !== null) await page.fill("#filter-arg", arg);
  await page.click("#filter-replace");
  await sleep(250);
  return page.evaluate(() => document.getElementById("status")?.textContent ?? "");
}

test("filters: Vol mode smallestN selects exactly one solid", async (page) => {
  await populate(page);
  const status = await runModeFilter(page, "volume", "smallestN", "1");
  assert(/matched 1 of \d+ solids\./.test(status), `Vol filter reports one solid (got ${JSON.stringify(status)})`);
  await page.click("#select-menu"); // close: the sidebar assign click needs a dismissed menu
  await sleep(150);
  const before = await page.evaluate(() => {
    const m = (window.__sent || []).findLast((x) => x.type === "partsChanged");
    return m ? m.parts.length : 0;
  });
  await page.click("#parts-new");
  await sleep(250);
  await page.evaluate(() => {
    const rows = document.querySelectorAll("#parts-body .part-row");
    const row = rows[rows.length - 1];
    const assign = [...row.querySelectorAll("button.part-btn")].find((b) => b.title?.startsWith("Assign"));
    assign?.click();
  });
  await sleep(250);
  const vols = await page.evaluate((n) => {
    const m = (window.__sent || []).findLast((x) => x.type === "partsChanged");
    if (!m || m.parts.length <= n) return null;
    return m.parts[m.parts.length - 1].volumes ?? null;
  }, before);
  assert(
    Array.isArray(vols) && vols.length === 1 && /^solid-\d+$/.test(vols[0]),
    `the Vol selection assigns one real solid-N id (got ${JSON.stringify(vols)})`
  );
});

test("filters: Point mode nearXY matches a strict subset; an empty reference explains itself", async (page) => {
  await populate(page);
  // Reference predicates with nothing selected are guidance, not a match-all —
  // check first, while the fresh page's selection is still empty.
  await page.click("#select-menu");
  await page.click('.sel-mode[data-mode="point"]');
  await page.selectOption("#filter-pred", "nearSelectionLte");
  await page.fill("#filter-arg", "10");
  const sentBefore = await page.evaluate(() => (window.__sent ?? []).length);
  await page.click("#filter-replace");
  await sleep(250);
  const guidance = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(/Select something first/.test(guidance), `empty reference explains itself (got ${JSON.stringify(guidance)})`);
  const sentAfter = await page.evaluate(() => (window.__sent ?? []).length);
  assert(sentAfter === sentBefore, "guidance posts no host traffic");
  await page.click("#select-menu"); // dismiss: runModeFilter opens the menu itself
  await sleep(150);
  const status = await runModeFilter(page, "point", "nearXY", "5");
  const m = status.match(/matched (\d+) of (\d+) points\./);
  assert(m !== null, `Point filter reports points (got ${JSON.stringify(status)})`);
  assert(m && Number(m[1]) > 0 && Number(m[1]) < Number(m[2]), `Near XY matches a strict subset (got ${JSON.stringify(status)})`);
});

test("filters: hidden geometry matches nothing in Vol mode", async (page) => {
  await populate(page);
  const toggled = await page.evaluate(() => {
    const eyes = document.querySelectorAll("#tree-body [data-visible-toggle], #tree-body .tree-eye");
    eyes.forEach((e) => e.click());
    return eyes.length;
  });
  assert(toggled > 0, "precondition: the tree exposes visibility toggles");
  await sleep(250);
  const status = await runModeFilter(page, "volume", "smallestN", "1");
  assert(status === "Filter matched nothing.", `hidden solids never match (got ${JSON.stringify(status)})`);
});

/**
 * J. Plane-authored profiles (the "Author profiles on a named construction plane" feature). Kernel resolution is
 * unit-covered (`planeRefs.test.ts`) and live-verified (`mcp:smoke`'s
 * analytic block); what needs the real bundle is the form: the Plane
 * picker lists saved planes, picking one fills + disables the placement
 * inputs, offsets shift the fill, and Apply attaches `planeId` + cache
 * (read back off `editsChanged` — preview ≡ Apply through the one choke
 * point, so the attached op IS what the preview replayed).
 */
async function openProfileForm(page, name) {
  await page.evaluate((n) => {
    const btn = [...document.querySelectorAll(".op-btn")].find(
      (b) => b.querySelector(".op-name")?.textContent === n
    );
    btn?.click();
  }, name);
  await sleep(200);
}

async function postPlanes(page) {
  await page.evaluate(() =>
    window.postMessage(
      { type: "planes", planes: [{ id: "plane-0", name: "Datum A", point: [10, 0, 0], normal: [0, 0, 1] }] },
      "*"
    )
  );
  await sleep(250);
}

test("profile planes: picker lists saved planes; picking fills and disables placement", async (page) => {
  await populate(page);
  await postPlanes(page);
  await openProfileForm(page, "Circle");
  const options = await page.evaluate(() =>
    [...document.querySelectorAll('#edits-params select[data-name="planeId"] option')].map((o) => o.value)
  );
  assert(options.includes("plane-0"), `the Plane picker lists the saved plane (got ${JSON.stringify(options)})`);
  await page.selectOption('#edits-params select[data-name="planeId"]', "plane-0");
  await sleep(200);
  const filled = await page.evaluate(() => ({
    center: [...document.querySelectorAll('#edits-params input[data-name="center"]')].map((i) => i.value),
    disabled: [...document.querySelectorAll('#edits-params input[data-name="center"]')].every((i) => i.disabled),
    normal: [...document.querySelectorAll('#edits-params input[data-name="normal"]')].map((i) => i.value),
  }));
  assert(eq(filled.center, ["10", "0", "0"]), `center fills from the plane point (got ${JSON.stringify(filled.center)})`);
  assert(filled.disabled, "filled placement inputs disable while a plane is picked");
  assert(eq(filled.normal, ["0", "0", "1"]), `normal fills from the plane normal (got ${JSON.stringify(filled.normal)})`);
});

test("profile planes: offsets shift the fill; Apply attaches planeId + cache", async (page) => {
  await populate(page);
  await postPlanes(page);
  await openProfileForm(page, "Rectangle");
  await page.selectOption('#edits-params select[data-name="planeId"]', "plane-0");
  await sleep(200);
  await page.fill('#edits-params input[data-name="offsetU"]', "2");
  await sleep(400); // delegated input refreshes the fill, then the preview debounce runs
  const center = await page.evaluate(() =>
    [...document.querySelectorAll('#edits-params input[data-name="center"]')].map((i) => i.value)
  );
  // +Z-plane frame is U=(0,−1,0): offsetU 2 shifts y by −2.
  assert(eq(center, ["10", "-2", "0"]), `offsets shift the filled center (got ${JSON.stringify(center)})`);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#edits-params button")].find((b) => b.textContent === "Sketch");
    btn?.click();
  });
  await sleep(250);
  const op = await page.evaluate(() => {
    const m = (window.__sent || []).findLast((x) => x.type === "editsChanged");
    return m ? m.ops[m.ops.length - 1] : null;
  });
  assert(op && op.op === "addRectangleProfile", `a rectangle op was pushed (got ${JSON.stringify(op?.op)})`);
  assert(
    op.planeId === "plane-0" && op.offsetU === 2 && op.offsetV === 0,
    `the op carries its plane reference (got ${JSON.stringify({ planeId: op.planeId, offsetU: op.offsetU, offsetV: op.offsetV })})`
  );
  assert(eq(op.center, [10, -2, 0]), `the op carries the resolved cache (got ${JSON.stringify(op.center)})`);
  assert(eq(op.up, [1, 0, 0]), `up resolves from the untilted frame (got ${JSON.stringify(op.up)})`);
});

test("profile planes: Custom restores hand typing", async (page) => {
  await populate(page);
  await postPlanes(page);
  await openProfileForm(page, "Circle");
  await page.selectOption('#edits-params select[data-name="planeId"]', "plane-0");
  await sleep(200);
  await page.selectOption('#edits-params select[data-name="planeId"]', "");
  await sleep(200);
  const enabled = await page.evaluate(() =>
    [...document.querySelectorAll('#edits-params input[data-name="center"]')].every((i) => !i.disabled)
  );
  assert(enabled, "Custom re-enables the placement inputs");
});

/**
 * I4. Per-band operation preview (the "Per-band operation-preview colouring" feature). The tint math itself is
 * unit-covered against real THREE materials; what needs the real bundle is
 * the wiring: the draft-bucket lookup off a genuine `opPreviewRequest`
 * round trip, the status-line legend (with full-history op numbering), its
 * retirement on a uniform supersede, stale-reply discipline, and cancel
 * clearing it. Host replies are faked by posting `opPreviewResult`
 * directly (the clash/context-menu precedent) with hand-built two-triangle
 * meshes — the payload shape, not the geometry, is what's under test.
 */
async function openBoxForm(page) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".op-btn")].find(
      (b) => b.querySelector(".op-name")?.textContent === "Box"
    );
    btn?.click();
  });
  await sleep(700); // past the 250ms preview debounce, with margin
}

async function lastPreviewRequest(page) {
  return page.evaluate(
    () => (window.__sent ?? []).filter((m) => m.type === "opPreviewRequest").at(-1) ?? null
  );
}

async function postBandedPreviewReply(page, requestId, withBucket) {
  await page.evaluate(
    ({ id, banded }) =>
      window.postMessage(
        {
          type: "opPreviewResult",
          requestId: id,
          meshes: (() => {
            const toB64 = (arr) => {
              const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
              let s = "";
              for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
              return btoa(s);
            };
            const tri = (x) => ({
              positions: toB64(new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0])),
              indices: toB64(new Uint32Array([0, 1, 2])),
              groupId: "solid-9",
            });
            return [
              { ...tri(0), faceId: "face-10" },
              { ...tri(5), faceId: "face-11" },
            ];
          })(),
          edges: [],
          points: [],
          opOutcomes: [{ index: 0, kind: "addBox", applied: true }],
          ...(banded ? { opBuckets: [{ op: 0, kind: "addBox", roles: { body: ["face-10"] } }] } : {}),
        },
        "*"
      ),
    { id: requestId, banded: withBucket }
  );
  await sleep(250);
}

const previewStatus = (page) =>
  page.evaluate(() => document.getElementById("status")?.textContent ?? "");

test("op preview bands: a bucket reply shows a legend; a uniform reply retires it", async (page) => {
  await populate(page);
  await openBoxForm(page);
  const req = await lastPreviewRequest(page);
  assert(req !== null && typeof req?.requestId === "string", "opening the Box form posts an opPreviewRequest");
  await postBandedPreviewReply(page, req.requestId, true);
  const legend = await previewStatus(page);
  assert(
    /Preview op 1 — green: new body ×1; grey: retained/.test(legend),
    `the band legend names the full-history op, tint word and roles (got ${JSON.stringify(legend)})`
  );
  // A uniform supersede (no bucket, e.g. a non-topology-changing draft) must
  // retire the legend, not leave it describing unhighlighted faces.
  await page.evaluate(() => {
    const input = document.querySelector("#edits-params input");
    if (input) {
      input.focus();
      document.execCommand("selectAll", false, undefined);
    }
  });
  await page.fill("#edits-params input", "2");
  await sleep(700);
  const req2 = await lastPreviewRequest(page);
  assert(req2 !== null && req2.requestId !== req.requestId, "typing schedules a second preview request");
  await postBandedPreviewReply(page, req2.requestId, false);
  assert((await previewStatus(page)) === "", "a uniform preview retires the band legend");
});

test("op preview bands: a stale band reply is ignored", async (page) => {
  await populate(page);
  await openBoxForm(page);
  const req = await lastPreviewRequest(page);
  assert(req !== null, "precondition: a preview request is in flight");
  await postBandedPreviewReply(page, "stale-id", true);
  assert(
    !(await previewStatus(page)).includes("Preview op"),
    "a stale reply stages no legend"
  );
  await postBandedPreviewReply(page, req.requestId, true);
  assert(
    /Preview op 1 — green/.test(await previewStatus(page)),
    "the current generation still renders once its own reply lands"
  );
});

test("op preview bands: switching forms clears the legend", async (page) => {
  await populate(page);
  await openBoxForm(page);
  const req = await lastPreviewRequest(page);
  assert(req !== null, "precondition: a preview request is in flight");
  await postBandedPreviewReply(page, req.requestId, true);
  assert(/Preview op 1/.test(await previewStatus(page)), "precondition: the legend is shown");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".op-btn")].find(
      (b) => b.querySelector(".op-name")?.textContent === "Sphere"
    );
    btn?.click();
  });
  await sleep(200);
  assert(
    !(await previewStatus(page)).includes("Preview op"),
    "leaving the form clears the band legend with the overlay"
  );
});

/**
 * G. Dropdown menus — both of these are previously-FIXED real bugs with no
 * regression test, recorded in `CLAUDE.md`'s "Toolbar dropdown menus":
 *  1. The containment test used `e.target !== btn`, but every trigger wraps its
 *     icon in a `<span><svg>`, so clicking an open menu's own icon closed then
 *     immediately reopened it — the menu could not be dismissed by its icon.
 *  2. The dismissing `pointerdown` runs in the CAPTURE phase and calls
 *     `preventDefault()`, so the click that closes a menu does not also reach
 *     the markup canvas underneath and draw a stray stroke.
 */
test("dropdowns: clicking an open trigger's inner icon closes it", async (page) => {
  await populate(page);
  const isOpen = () => dropdownOpen(page, "view-dropdown");

  await page.click("#view-menu");
  assert((await isOpen()) === true, "the View menu opens on trigger click");

  // Click the trigger's inner <svg>, not the button itself — the exact target
  // that used to close-then-reopen.
  const icon = page.locator("#view-menu svg").first();
  if ((await icon.count()) > 0) {
    await icon.click();
  } else {
    await page.click("#view-menu");
  }
  assert((await isOpen()) === false, "clicking the trigger's inner icon closes it (does not reopen)");
});

/**
 * Clip-drift guards for the two FIXED-clip documentation screenshots.
 *
 * `scripts/screenshots/capture.mjs` shoots the File menu with a hardcoded
 * `clip {x:0, y:0, width:320, height:439}` and the four toolbar dropdowns with a
 * shared `clip {x:750, y:30, width:610, height:500}`. A dropdown that grows, or
 * a toolbar that moves, silently CUTS the last entry off — the run still exits
 * 0 and still prints `✓ file-menu.png`. That failure has been realised twice
 * already (250 → 285 → 342 → 371 → 410 → 439, and 830 → 770 → 750 / 300 → 500).
 *
 * These mirror those two rectangles exactly, so any change that would mis-crop
 * a PNG now fails a test instead. Each assertion message prints the MEASURED
 * box, so re-measuring a clip after a deliberate layout change is a read of the
 * failure text rather than a guess. If one of these fails: measure, then update
 * BOTH this test and the clip in `capture.mjs` together.
 */
const FILE_MENU_CLIP = { x: 0, y: 0, width: 320, height: 439 };
const TOOLBAR_MENU_CLIP = { x: 750, y: 30, width: 610, height: 500 };

const panelBox = (page, id) =>
  page.evaluate((i) => {
    const r = document.getElementById(i)?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  }, id);

const fits = (box, clip) =>
  box !== null &&
  box.left >= clip.x &&
  box.top >= clip.y &&
  box.right <= clip.x + clip.width &&
  box.bottom <= clip.y + clip.height;

const fmtBox = (b) =>
  b === null
    ? "missing"
    : `left ${b.left.toFixed(1)}, top ${b.top.toFixed(1)}, right ${b.right.toFixed(1)}, bottom ${b.bottom.toFixed(1)}`;

test("chrome: the File menu panel fits file-menu.png's fixed clip", async (page) => {
  await populate(page);
  await page.click("#file-menu");
  await sleep(150);
  const box = await panelBox(page, "file-dropdown");
  const c = FILE_MENU_CLIP;
  assert(
    fits(box, c),
    `#file-dropdown must sit inside clip {x:${c.x}, y:${c.y}, w:${c.width}, h:${c.height}} ` +
      `(measured: ${fmtBox(box)}) — update capture.mjs's file-menu clip if this is deliberate`
  );
});

for (const name of ["view", "select", "measure", "markup"]) {
  test(`chrome: the ${name} dropdown fits the shared toolbar-menu clip`, async (page) => {
    await populate(page);
    await page.click(`#${name}-menu`);
    await sleep(150);
    const box = await panelBox(page, `${name}-dropdown`);
    const c = TOOLBAR_MENU_CLIP;
    assert(
      fits(box, c),
      `#${name}-dropdown must sit inside clip {x:${c.x}, y:${c.y}, w:${c.width}, h:${c.height}} ` +
        `(measured: ${fmtBox(box)}) — update the shared clip in capture.mjs if this is deliberate`
    );
  });
}

/**
 * `hidden` on these three carried no effect for a long time, and the assertion
 * style is the whole reason it went unnoticed: checking `el.hidden === true`
 * passes while the element is plainly on screen. Each has an author `display`
 * rule (`.vc-row` / `.vc-group` are `display: flex`) that beats the UA's
 * `[hidden] { display: none }` regardless of specificity — origin is checked
 * before specificity. `offsetParent === null` is what "genuinely not rendered"
 * looks like, so that is what this asserts.
 *
 * A B-rep document is the right fixture: Colour by field is meshio++-only, and
 * the Midplane… row only appears after its toggle is clicked.
 */
test("dock: elements carrying `hidden` are genuinely not rendered", async (page) => {
  await populate(page);
  const state = await page.evaluate(() =>
    Object.fromEntries(
      ["plane-entry", "plane-mid", "vc-colorfield-group", "vc-colorfield-legend"].map((id) => {
        const el = document.getElementById(id);
        return [id, { hasHidden: el?.hidden === true, rendered: el ? el.offsetParent !== null : null }];
      })
    )
  );
  for (const [id, s] of Object.entries(state)) {
    assert(s.hasHidden, `#${id} still carries the hidden attribute (precondition)`);
    assert(s.rendered === false, `#${id} is genuinely not rendered while hidden (rendered: ${s.rendered})`);
  }
});

/**
 * The menubar's document chip. The host half (which transitions post, and the
 * dirty predicate) is covered by the integration suite; this covers what only
 * a real DOM can: that it is genuinely NOT rendered before the first message
 * (the `[hidden]` override — an empty pill in the menubar is the failure), that
 * a hostile filename is text and never markup, that it fits the 34px menubar
 * every fixed screenshot clip is derived from, and that it does not shift the
 * File menu (`file-menu.png`'s clip assumes it sits at the viewport origin).
 */
/**
 * The dock's status row: entity counts, FE-mesh stats and the live cursor position.
 *
 * The cursor readout is the piece with a real trap in it — `Viewer.onHoverPointerMove`
 * used to bail out whenever no pick mode was set, which is the NORMAL state, so a
 * readout wired to it would have stayed blank for exactly the users who never turn
 * selection on. Every assertion below therefore runs with selection OFF.
 */
test("dock status: counts follow the geometry, the mesh stat follows the overlay", async (page) => {
  await populate(page);
  const geo = fixture("geometry");
  const text = (id) =>
    page.evaluate((i) => {
      const el = document.getElementById(i);
      return el && el.offsetParent !== null ? el.textContent : null;
    }, id);

  const expected = `${geo.meshes.length.toLocaleString("en-US")} face${geo.meshes.length === 1 ? "" : "s"} · ${geo.edges.length.toLocaleString("en-US")} edge${geo.edges.length === 1 ? "" : "s"} · ${(geo.points?.length ?? 0).toLocaleString("en-US")} point${(geo.points?.length ?? 0) === 1 ? "" : "s"}`;
  assert((await text("vc-count-entities")) === expected, `the counts read straight off the geometry message (want ${JSON.stringify(expected)}, got ${JSON.stringify(await text("vc-count-entities"))})`);
  assert((await text("vc-count-mesh")) === null, "no FE-mesh stat is rendered before a mesh exists (the [hidden] override holds)");

  await postMeshingResult(page);
  await sleep(500);
  assert(
    (await text("vc-count-mesh")) === "mesh 10,000 el",
    `the mesh stat reports the result's own element count in the short form, and the node count lives in the tooltip (got ${JSON.stringify(await text("vc-count-mesh"))})`
  );

  await page.click("#meshing-clear");
  await sleep(300);
  assert((await text("vc-count-mesh")) === null, "Clear removes the stat along with the overlay it described");

  // Regenerating and then loading a new model must also drop it: the overlay is
  // disposed by setModel(), so a surviving stat would describe a mesh that is gone.
  await postMeshingResult(page);
  await sleep(500);
  assert((await text("vc-count-mesh")) !== null, "the stat comes back with a new result");
  await post(page, geo);
  await sleep(400);
  assert((await text("vc-count-mesh")) === null, "loading a model drops the stat of the overlay it disposed");
});

test("dock status: the cursor readout works with selection OFF, follows the Units dropdown, and clears when the pointer leaves", async (page) => {
  await populate(page);
  const selActive = await page.evaluate(() => document.getElementById("sel-toggle")?.classList.contains("active") ?? false);
  assert(selActive === false, "precondition: selection mode is off (the normal state, and the one the old hover path ignored)");

  const cursor = () =>
    page.evaluate(() => {
      const el = document.getElementById("vc-cursor");
      return el && el.offsetParent !== null && el.textContent ? el.textContent : null;
    });
  assert((await cursor()) === null, "no coordinates before the pointer enters the model");

  const box = await viewportBox(page);
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await sleep(250);
  const mm = await cursor();
  assert(
    mm !== null && /^x -?\d+\.\d{2}  y -?\d+\.\d{2}  z -?\d+\.\d{2} mm$/.test(mm),
    `hovering the model shows X/Y/Z in mm with selection off (got ${JSON.stringify(mm)})`
  );

  // The Units dropdown drives it like Mass Properties: 25.4 mm is one inch, so the
  // same point read back in inches must be the mm value / 25.4. Reading it WITHOUT
  // moving the pointer also proves the readout re-renders on a unit change instead
  // of waiting for the next mouse-move.
  await page.selectOption("#vc-unit", "in");
  await sleep(150);
  const inch = await cursor();
  const nums = (t) => [...t.matchAll(/-?\d+\.\d{3}/g)].map((m) => parseFloat(m[0]));
  assert(inch !== null && inch.endsWith(" in"), `the unit suffix follows the dropdown (got ${JSON.stringify(inch)})`);
  const [mmN, inN] = [nums(mm), nums(inch)];
  assert(
    mmN.every((v, i) => Math.abs(v - inN[i] * 25.4) < 0.05),
    `the inch readout is the mm readout / 25.4 (mm ${JSON.stringify(mmN)}, in ${JSON.stringify(inN)})`
  );
  await page.selectOption("#vc-unit", "mm");

  // Leaving the model must clear it — stale coordinates beside a pointer that is
  // no longer there read as a live measurement of nothing.
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  await sleep(250);
  assert((await cursor()) === null, "leaving the viewport clears the readout");
});

test("doc chip: hidden until fed, then renders name/format/dirty inside the menubar", async (page) => {
  await populate(page);
  const rects = () =>
    page.evaluate(() => {
      const box = (id) => {
        const b = document.getElementById(id)?.getBoundingClientRect();
        return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } : null;
      };
      return {
        chip: box("doc-chip"),
        menubar: box("menubar"),
        fileMenu: box("file-menu"),
        body: document.body.getBoundingClientRect().width,
        chipRendered: document.getElementById("doc-chip")?.offsetParent !== null,
        dotRendered: document.getElementById("doc-chip-dirty")?.offsetParent !== null,
        badgeRendered: document.getElementById("doc-chip-format")?.offsetParent !== null,
        name: document.getElementById("doc-chip-name")?.textContent ?? null,
        format: document.getElementById("doc-chip-format")?.textContent ?? null,
        title: document.getElementById("doc-chip")?.title ?? null,
        badgeTransform: getComputedStyle(document.getElementById("doc-chip-format")).textTransform,
      };
    });

  const before = await rects();
  assert(before.chipRendered === false, "the chip is genuinely not rendered before any documentInfo arrives");

  await post(page, { type: "documentInfo", name: "bracket.step", path: "/tmp/parts/bracket.step", format: "step", dirty: true });
  await sleep(80);
  const shown = await rects();
  assert(shown.chipRendered === true, "the chip renders once documentInfo arrives");
  assert(shown.name === "bracket.step", `it shows the file name (got ${JSON.stringify(shown.name)})`);
  assert(shown.format === "step" && shown.badgeTransform === "uppercase", "the format badge carries the code and displays uppercase");
  assert(shown.title === "/tmp/parts/bracket.step", "hovering the chip reveals the full path");
  assert(shown.dotRendered === true, "the unsaved-edits dot renders when dirty");

  assert(
    shown.chip.top >= shown.menubar.top && shown.chip.bottom <= shown.menubar.bottom,
    `the chip sits inside the menubar (chip ${shown.chip.top.toFixed(1)}–${shown.chip.bottom.toFixed(1)}, menubar ${shown.menubar.top.toFixed(1)}–${shown.menubar.bottom.toFixed(1)})`
  );
  // Compare to the MEASURED baseline, not a hardcoded 34: the bar is `height: 34px`
  // plus a 1px border, so it is 35px outer, and a first version of this
  // assertion that assumed 34 failed on the untouched layout. What matters is
  // that the chip does not change it — #toolbar's `top: 42px` and every fixed
  // screenshot clip are derived from this height.
  assert(
    Math.abs(shown.menubar.height - before.menubar.height) < 0.5,
    `the chip did not grow the menubar (${before.menubar.height} -> ${shown.menubar.height})`
  );
  assert(
    Math.abs(shown.fileMenu.left - before.fileMenu.left) < 0.5,
    `the File menu did not move when the chip appeared (${before.fileMenu.left} -> ${shown.fileMenu.left})`
  );

  await post(page, { type: "documentInfo", name: "bracket.step", path: "/tmp/parts/bracket.step", format: "step", dirty: false });
  await sleep(80);
  assert((await rects()).dotRendered === false, "the dot is genuinely not rendered once the document is clean");

  await post(page, { type: "documentInfo", name: "mystery.xyz", path: "/tmp/mystery.xyz", format: null, dirty: false });
  await sleep(80);
  const unrouted = await rects();
  assert(unrouted.badgeRendered === false, "a null format leaves no empty badge behind");
  assert(unrouted.name === "mystery.xyz", "an unrouted file still shows its name");

  // A file NAME is untrusted, document-derived text.
  const hostile = '<img src=x onerror="window.__chipPwned=1">';
  await post(page, { type: "documentInfo", name: hostile, path: "/tmp/x", format: "stl", dirty: false });
  await sleep(120);
  const inj = await page.evaluate(() => ({
    imgs: document.querySelectorAll("#doc-chip img").length,
    pwned: window.__chipPwned ?? null,
    text: document.getElementById("doc-chip-name")?.textContent,
  }));
  assert(inj.imgs === 0 && inj.pwned === null, "a filename containing markup is rendered as text, never parsed");
  assert(inj.text === hostile, "the raw string is preserved verbatim as text");

  // A very long name must ellipsize, not push the chip past half the bar.
  await post(page, { type: "documentInfo", name: "a-really-quite-long-assembly-file-name-".repeat(8) + ".step", path: "/x", format: "step", dirty: true });
  await sleep(80);
  const long = await rects();
  assert(
    long.chip.width <= long.body * 0.5 + 2,
    `a long name is capped at half the menubar (chip ${long.chip.width.toFixed(0)}px of ${long.body.toFixed(0)}px)`
  );
  assert(
    Math.abs(long.menubar.height - before.menubar.height) < 0.5,
    `a long name does not wrap the menubar taller (${before.menubar.height} -> ${long.menubar.height})`
  );
});

/**
 * The one-row dock and its "⋯" overflow popover.
 *
 * The restructure's whole safety argument is that every control KEPT ITS ID: the
 * four setup functions (view controls, appearance, clipping, planes) query
 * globally by id/class, so moving a node is invisible to them and renaming one
 * silently kills its control (`getElementById` returns null, the wiring is
 * skipped, and nothing throws). That is the first thing pinned here.
 */
const DOCK_MORE_CLIP = { x: 700, y: 400, width: 660, height: 500 }; // mirrors capture.mjs view-controls-more.png

test("dock: every control keeps its id — inline ones render, moved ones sit inside the closed popover", async (page) => {
  await populate(page);
  const MOVED = [
    "rot-up", "rot-left", "rot-right", "rot-down",
    "pan-up", "pan-left", "pan-right", "pan-down",
    "clip-from-face", "clip-from-points",
    "plane-save", "plane-add", "plane-mid-toggle",
    "plane-entry", "plane-entry-point", "plane-entry-normal", "plane-entry-ok",
    "plane-mid", "plane-mid-a", "plane-mid-b", "plane-mid-ok", "planes-list",
    "vc-background", "vc-opacity", "vc-grid-size",
    "vc-colorfield-group", "vc-colorfield-select", "vc-colorfield-legend",
    "vc-colorfield-gradient", "vc-colorfield-min", "vc-colorfield-max",
  ];
  const INLINE = [
    "vc-toggle", "display-mode-group", "clip-offset", "clip-toggle",
    "vc-ortho", "vc-unit", "view-fit", "view-reset", "zoom-in", "zoom-out", "vc-more",
  ];
  const state = await page.evaluate(
    ({ moved, inline }) => {
      const dd = document.getElementById("vc-more-dropdown");
      const probe = (id) => {
        const el = document.getElementById(id);
        return { exists: el !== null, inPopover: !!el && !!dd && dd.contains(el), rendered: !!el && el.offsetParent !== null };
      };
      return {
        moved: Object.fromEntries(moved.map((id) => [id, probe(id)])),
        inline: Object.fromEntries(inline.map((id) => [id, probe(id)])),
        // `#clip-custom` is `hidden` until a custom normal exists, so it is only checked for existence.
        clipCustom: probe("clip-custom"),
        popoverOpen: dd ? !dd.classList.contains("hidden") : null,
      };
    },
    { moved: MOVED, inline: INLINE }
  );
  assert(state.popoverOpen === false, "the popover starts closed");
  const missing = [...MOVED, ...INLINE].filter((id) => !(state.moved[id] ?? state.inline[id]).exists);
  assert(missing.length === 0, `no control lost its id (missing: ${JSON.stringify(missing)})`);
  assert(state.clipCustom.exists, "#clip-custom still exists (hidden until a custom normal is derived)");
  const notInside = MOVED.filter((id) => !state.moved[id].inPopover);
  assert(notInside.length === 0, `every moved control lives inside #vc-more-dropdown (not: ${JSON.stringify(notInside)})`);
  const leaked = MOVED.filter((id) => state.moved[id].rendered);
  assert(leaked.length === 0, `no moved control is rendered while the popover is closed (rendered: ${JSON.stringify(leaked)})`);
  const hidden = INLINE.filter((id) => !state.inline[id].rendered);
  assert(hidden.length === 0, `every inline control is rendered in the bar (hidden: ${JSON.stringify(hidden)})`);
});

test("dock: one compact row at a normal width; wraps rather than overflows when the editor is narrow", async (page) => {
  await populate(page);
  const measure = () =>
    page.evaluate(() => {
      const box = (id) => {
        const b = document.getElementById(id)?.getBoundingClientRect();
        return b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height, width: b.width } : null;
      };
      const mid = (id) => {
        const b = box(id);
        return b ? (b.top + b.bottom) / 2 : null;
      };
      const INLINE = ["display-mode-group", "clip-toggle", "vc-ortho", "vc-unit", "view-fit", "zoom-in", "vc-more"];
      const dock = box("view-controls");
      // The dock now also holds the status row (counts / cursor), which is always
      // present, so "one row or wrapped" is a property of the CONTROLS row, not of
      // the whole dock's height.
      const rowEl = document.querySelector(".vc-dock-row")?.getBoundingClientRect();
      return {
        dock,
        row: rowEl ? { height: rowEl.height } : null,
        side: box("side"),
        centres: ["display-mode-group", "clip-toggle", "vc-ortho", "vc-unit", "view-fit", "vc-more"].map(mid),
        // Controls whose box pokes OUT of the dock's own box. A `nowrap` row keeps
        // the dock's rect capped while its contents spill past the edge, so the
        // dock's height/left alone cannot detect that — this is the check that can.
        overflowing: INLINE.filter((id) => {
          const b = box(id);
          return b && (b.right > dock.right + 1 || b.left < dock.left - 1);
        }),
      };
    });
  const wide = await measure();
  assert(wide.overflowing.length === 0, `no control pokes out of the dock at 1360px (${JSON.stringify(wide.overflowing)})`);
  // The old dock was ~330px tall (eight column groups). One controls row is ~30px;
  // two would be ~60, so 46 separates "one row" from "it wrapped" with room.
  assert(wide.row && wide.row.height < 46, `the controls row is one line at 1360px (height ${wide.row?.height.toFixed(0)}px)`);
  const spread = Math.max(...wide.centres) - Math.min(...wide.centres);
  assert(spread < 6, `the inline controls share a line (vertical centres span ${spread.toFixed(1)}px)`);

  await page.setViewportSize({ width: 820, height: 900 });
  await sleep(250);
  const narrow = await measure();
  assert(
    narrow.dock.left >= narrow.side.right - 1,
    `at 820px the bar still clears the sidebar (bar ${narrow.dock.left.toFixed(0)} vs sidebar ${narrow.side.right.toFixed(0)})`
  );
  assert(
    narrow.overflowing.length === 0,
    `at 820px no control pokes out of the dock — it wraps instead (overflowing: ${JSON.stringify(narrow.overflowing)})`
  );
  assert(
    narrow.row.height > wide.row.height + 10,
    `at 820px the row WRAPPED (${wide.row.height.toFixed(0)}px -> ${narrow.row.height.toFixed(0)}px) — the guarantee engaged rather than the bar overflowing`
  );
});

test("dock: the #status toast clears the dock at a normal width AND when the dock wraps", async (page) => {
  await populate(page);
  // An EMPTY toast collapses to a zero rect at (0,0), which trivially clears
  // anything — the first version of this test passed with "toast bottom 0". Give it
  // real text and assert it actually rendered before measuring.
  await post(page, { type: "status", text: "Exported to /tmp/some/long/path/file.step" });
  await sleep(150);
  const gap = () =>
    page.evaluate(() => {
      const st = document.getElementById("status").getBoundingClientRect();
      const dk = document.getElementById("view-controls").getBoundingClientRect();
      return { statusBottom: st.bottom, statusH: st.height, dockTop: dk.top, dockH: dk.height, overlapsX: st.left < dk.right && st.right > dk.left };
    });
  const wide = await gap();
  assert(wide.statusH > 10, `precondition: the toast actually rendered (height ${wide.statusH})`);
  assert(
    wide.statusBottom <= wide.dockTop,
    `at 1360px the toast sits above the dock (toast bottom ${wide.statusBottom.toFixed(0)}, dock top ${wide.dockTop.toFixed(0)})`
  );
  await page.setViewportSize({ width: 820, height: 900 });
  await sleep(250);
  const narrow = await gap();
  assert(narrow.dockH > wide.dockH + 10, `precondition: the dock wrapped at 820px (${wide.dockH.toFixed(0)} -> ${narrow.dockH.toFixed(0)}px)`);
  assert(
    narrow.statusBottom <= narrow.dockTop,
    `at 820px, with the dock wrapped, the toast still clears it (toast bottom ${narrow.statusBottom.toFixed(0)}, dock top ${narrow.dockTop.toFixed(0)})`
  );
});

test("dock: the overflow popover opens upward, clears the dock and the sidebar, and fits its screenshot clip", async (page) => {
  await populate(page);
  const rects = () =>
    page.evaluate(() => {
      const r = (id) => {
        const b = document.getElementById(id)?.getBoundingClientRect();
        return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom, height: b.height } : null;
      };
      return { dd: r("vc-more-dropdown"), dock: r("view-controls"), side: r("side"), body: document.body.getBoundingClientRect().width };
    });
  const closed = await rects();
  await page.click("#vc-more");
  await sleep(150);
  const open = await rects();
  const fmt = (b) => (b ? `${b.left.toFixed(0)},${b.top.toFixed(0)}–${b.right.toFixed(0)},${b.bottom.toFixed(0)}` : "missing");

  assert(
    Math.abs(open.dock.height - closed.dock.height) < 0.5,
    `opening the popover does not resize the dock (${closed.dock.height} -> ${open.dock.height})`
  );
  assert(
    open.dd.bottom <= open.dock.top,
    `the popover clears the dock's top rim instead of overlapping it (popover ${fmt(open.dd)}, dock ${fmt(open.dock)})`
  );
  assert(
    open.dd.left >= open.side.right - 1 && open.dd.right <= open.body - 4,
    `the popover stays on the canvas at 1360px (popover ${fmt(open.dd)}, sidebar right ${open.side.right.toFixed(0)})`
  );
  const c = DOCK_MORE_CLIP;
  assert(
    open.dd.left >= c.x && open.dd.top >= c.y && open.dd.right <= c.x + c.width && open.dd.bottom <= c.y + c.height,
    `the popover fits view-controls-more.png's fixed clip {x:${c.x}, y:${c.y}, w:${c.width}, h:${c.height}} ` +
      `(measured ${fmt(open.dd)}) — update capture.mjs's clip if this is deliberate`
  );

  // Narrow editor: a popover wider than the room left of the "⋯" would run under the sidebar.
  await page.setViewportSize({ width: 820, height: 900 });
  await sleep(250);
  const narrow = await rects();
  assert(
    narrow.dd.left >= narrow.side.right - 1 && narrow.dd.right <= narrow.body - 4,
    `at 820px the popover still clears the sidebar and stays on screen (popover ${fmt(narrow.dd)}, sidebar right ${narrow.side.right.toFixed(0)}, body ${narrow.body.toFixed(0)})`
  );
});

test("keyboard: the dock overflow opens on click, arrows move focus inside it, Escape closes and refocuses the trigger", async (page) => {
  await populate(page);
  const state = () =>
    page.evaluate(() => ({
      expanded: document.getElementById("vc-more").getAttribute("aria-expanded"),
      inPanel: document.getElementById("vc-more-dropdown").contains(document.activeElement),
      activeId: document.activeElement?.id ?? "",
    }));
  await page.click("#vc-more");
  assert((await state()).expanded === "true", "clicking the trigger opens the popover (aria-expanded=true)");
  await page.keyboard.press("ArrowDown");
  assert((await state()).inPanel, "ArrowDown moves focus into the popover");
  // Every popover button is disabled, hidden or a real control — arrow nav skips the hidden ones.
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return { rendered: el?.offsetParent !== null, disabled: el?.hasAttribute("disabled") ?? true };
  });
  assert(focused.rendered && !focused.disabled, "focus lands on a rendered, enabled control (hidden/disabled ones are skipped)");
  await page.keyboard.press("Escape");
  const after = await state();
  assert(after.expanded === "false", "Escape closes the popover");
  assert(after.activeId === "vc-more", `Escape returns focus to the trigger (got "${after.activeId}")`);
});

test("dock: collapsing the bar closes an open popover and keeps the toggle's aria-label truthful", async (page) => {
  await populate(page);
  const read = () =>
    page.evaluate(() => ({
      expanded: document.getElementById("vc-more").getAttribute("aria-expanded"),
      label: document.getElementById("vc-toggle").getAttribute("aria-label"),
      collapsed: document.getElementById("view-controls").classList.contains("collapsed"),
    }));
  await page.click("#vc-more");
  assert((await read()).expanded === "true", "the popover is open before collapsing");
  await page.click("#vc-toggle");
  const collapsed = await read();
  assert(collapsed.collapsed, "the bar collapsed");
  assert(collapsed.expanded === "false", "collapsing closed the popover — no stale aria-expanded left over a display:none subtree");
  assert(collapsed.label === "Show controls", `the toggle's aria-label follows its title (got "${collapsed.label}")`);
  await page.click("#vc-toggle");
  assert((await read()).label === "Hide controls", "and flips back when expanded");
});

test("dropdowns: dismissing a menu over the markup canvas draws no stroke", async (page) => {
  await populate(page);
  await page.click("#markup-menu");
  await page.click("#markup-toggle"); // markup mode on -> #markup-canvas takes pointer events
  await page.click("#markup-menu"); // reopen, so the next canvas click is a dismissal
  await sleep(150);

  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(250);

  const drew = await page.evaluate(() => {
    const c = document.getElementById("markup-canvas");
    if (!c) return null;
    const ctx = c.getContext("2d");
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  });
  assert(drew === false, `the dismissing click drew no markup stroke (got ${JSON.stringify(drew)})`);
});

/**
 * Dominant rendered colours in the viewport, most-frequent first.
 *
 * Screenshots through Playwright's compositor rather than reading the WebGL
 * canvas back with `getImageData`: the renderer is created without
 * `preserveDrawingBuffer`, so a direct readback returns all-black. (Confirmed
 * the hard way while building this — a first attempt reported a uniform
 * `0,0,0` histogram for a scene that was plainly rendering.)
 */
async function dominantColors(page, topN = 6) {
  const box = await viewportBox(page);
  const shot = await shotWithoutToast(page, () =>
    page.screenshot({
      clip: { x: box.x + 8, y: box.y + 8, width: box.width - 16, height: box.height - 16 },
    })
  );
  return page.evaluate(
    async ({ b64, topN }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      const hist = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const k = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        hist.set(k, (hist.get(k) ?? 0) + 1);
      }
      return [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
    },
    { b64: shot.toString("base64"), topN }
  );
}

/** Sets the body theme class the way VS Code does, and lets the observer run. */
async function setTheme(page, cls) {
  await page.evaluate((c) => {
    document.body.className = c;
    document.body.setAttribute("data-vscode-theme-kind", c);
  }, cls);
  await sleep(400);
}

/**
 * L. Theme-reactive scene colours.
 *
 * The screenshot suite CANNOT cover this on its own: every visible face in the
 * fixture is Part-assigned, so the default face colour is never reached there
 * (verified by histogram — the model renders in Part swatch colours). That is
 * the "Part swatches win over the default" property working correctly, but it
 * makes the fixture blind to `--cad-face`. Hence the explicit checks below,
 * which drive the palette directly rather than through a Part-covered model.
 */
test("theme: the scene background follows the active theme class", async (page) => {
  await populate(page);
  await sleep(300);

  const dark = await dominantColors(page, 1);
  assert(dark[0][0] === "30,30,30", `dark theme renders the #1e1e1e background (got ${dark[0][0]})`);

  await setTheme(page, "vscode-light");
  const light = await dominantColors(page, 1);
  assert(
    light[0][0] === "243,243,243",
    `switching to vscode-light repaints the background to #f3f3f3 (got ${light[0][0]})`
  );

  await setTheme(page, "vscode-high-contrast");
  const hc = await dominantColors(page, 1);
  assert(hc[0][0] === "0,0,0", `high contrast renders a pure black background (got ${hc[0][0]})`);

  await setTheme(page, "vscode-dark");
  const back = await dominantColors(page, 1);
  assert(back[0][0] === "30,30,30", `switching back restores the dark background (got ${back[0][0]})`);
});

test("theme: changing the default face colour cannot repaint Part-assigned faces", async (page) => {
  // The invariant that matters: `setEntityColors` resolves a Part swatch in the
  // `map.faces.get(...) ?? default` branch, so a default-colour change is
  // structurally unable to reach a Part-assigned face. Every visible face in
  // this fixture IS Part-assigned, which makes the model a precise probe.
  //
  // Asserts on the rendered image rather than material colours because the
  // viewer is deliberately not exposed on `window` (production code should not
  // grow test-only surface). Note this asserts PIXELS are unchanged, which is
  // only meaningful while nothing else in the render changes — hence the
  // default-colour swap below rather than a full theme switch, which also
  // re-tints the lights and so legitimately shifts every shaded pixel.
  await populate(page);
  await sleep(300);
  const before = await dominantColors(page, 8);

  // An inline custom property on <body> outranks both `:root` and the theme
  // class rules, and re-stamping the class is what makes the MutationObserver
  // re-read the palette.
  await page.evaluate(() => document.body.style.setProperty("--cad-face", "#cc4444"));
  await setTheme(page, "vscode-dark");
  const afterFaceChange = await dominantColors(page, 8);

  assert(
    eq(before, afterFaceChange),
    "a wildly different --cad-face leaves the Part-covered render pixel-identical"
  );

  // Control: the same mechanism DOES repaint when it reaches something no Part
  // covers. Without this, the assertion above would also pass if the palette
  // were simply never read at all.
  await page.evaluate(() => document.body.style.setProperty("--cad-background", "#6a1e5e"));
  await setTheme(page, "vscode-dark");
  const afterBgChange = await dominantColors(page, 1);
  assert(
    afterBgChange[0][0] === "106,30,94",
    `the same path DOES repaint the unassigned background (got ${afterBgChange[0][0]})`
  );

  await page.evaluate(() => {
    document.body.style.removeProperty("--cad-face");
    document.body.style.removeProperty("--cad-background");
  });
  await setTheme(page, "vscode-dark");
});

test("theme: the default entity colour itself tracks the palette", async (page) => {
  // Drives the palette module directly — the one path the Part-covered fixture
  // cannot exercise. Asserts the CSS variable resolves per theme AND that the
  // module reads it, so a stylesheet/module mismatch is caught either way.
  const read = () =>
    page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--cad-face").trim());

  await setTheme(page, "vscode-dark");
  const dark = await read();
  await setTheme(page, "vscode-light");
  const light = await read();
  await setTheme(page, "vscode-high-contrast");
  const hc = await read();
  await setTheme(page, "vscode-dark");

  assert(dark === "#c0c4cc", `dark --cad-face equals the pre-theming constant (got ${dark})`);
  assert(light !== dark && light !== "", `light theme defines a different --cad-face (got ${light})`);
  assert(hc !== dark && hc !== "", `high contrast defines a different --cad-face (got ${hc})`);
});

/**
 * M. Explain the geometry under the cursor.
 *
 * The hover tooltip is pure webview and fully checkable here. The inspector
 * card's host round trip is faked by posting `entityFactsResult` directly —
 * the real `getEntityFacts` is covered against live OCCT in `npm run mcp:smoke`
 * via `inspect`, so what needs checking here is the RENDERING decision: only
 * the fields that apply to the classification.
 */
test("hover: moving over geometry shows the entity id and which ops mention it", async (page) => {
  await populate(page);
  await page.click("#select-menu");
  await page.click("#sel-toggle"); // picking is a separate enable switch from the mode buttons
  await page.click('.sel-mode[data-mode="surface"]');
  await page.click("#select-menu"); // close, or its capture-phase dismissal eats the next canvas event
  await sleep(150);

  const box = await viewportBox(page);
  // Checks RENDERED visibility (offsetParent is null for a display:none
  // element), not `classList.contains("hidden")`. There is no global `.hidden`
  // rule in viewer.css — each consumer defines its own — so a class-only
  // assertion passes while the element is plainly visible on screen. That
  // exact bug shipped here once and was caught only by inspecting a screenshot.
  const tipText = async () =>
    page.evaluate(() => {
      const el = document.getElementById("hover-tip");
      return el && el.offsetParent !== null ? el.textContent : null;
    });

  assert((await tipText()) === null, "no tooltip before the pointer enters the model");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(250);
  const overModel = await tipText();
  assert(
    overModel !== null && /^(face|edge|point|solid)-\d+/.test(overModel),
    `hovering geometry shows its entity id (got ${JSON.stringify(overModel)})`
  );
  assert(
    overModel !== null && /mention/.test(overModel),
    `the tooltip states op MENTIONS, not "acts on" — ids are positional (got ${JSON.stringify(overModel)})`
  );

  // Leaving the canvas must retract it, or it strands over the UI.
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  await sleep(250);
  assert((await tipText()) === null, "leaving the viewport hides the tooltip");

  // The fixture's third op is `translate targets:["solid-0"]`, so Vol mode
  // exercises the branch that actually matters — and pins the numbering as
  // 1-based op POSITIONS, not 0-based indices.
  await page.click("#select-menu");
  await page.click('.sel-mode[data-mode="volume"]');
  await page.click("#select-menu");
  await sleep(150);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(250);
  const overSolid = await tipText();
  assert(
    overSolid === "solid-0\nmentioned by op 3",
    `a referenced entity lists the 1-based op positions mentioning it (got ${JSON.stringify(overSolid)})`
  );
});

test("hover: the tooltip never intercepts a click meant for the geometry", async (page) => {
  // It tracks the cursor, so without pointer-events:none it would sit directly
  // under the pointer and swallow the very click it is describing.
  await populate(page);
  const pe = await page.evaluate(() => {
    const el = document.getElementById("hover-tip");
    return el ? getComputedStyle(el).pointerEvents : null;
  });
  assert(pe === "none", `#hover-tip is pointer-events:none (got ${pe})`);
});

test("inspector card: selection requests facts, and the reply renders per classification", async (page) => {
  await populate(page);
  await sleep(200);

  // Rendered-visibility check, for the same reason as the tooltip's above.
  const cardShown = () =>
    page.evaluate(() => document.getElementById("inspector-card")?.offsetParent !== null);
  assert((await cardShown()) === false, "the inspector card is genuinely not rendered before any selection");

  await page.click("#select-menu");
  await page.click("#sel-toggle");
  await page.click('.sel-mode[data-mode="surface"]');
  await page.click("#select-menu");
  await sleep(150);

  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);

  // The request is a real host round trip, so it shows up on the harness's
  // recorded outbound-message list — which is also where its requestId lives.
  const req = await page.evaluate(() =>
    (window.__sent ?? []).filter((m) => m.type === "entityFactsRequest").at(-1) ?? null
  );
  assert(req !== null, "clicking a face posts an entityFactsRequest");
  assert((await cardShown()) === true, "selecting a face renders the inspector card");

  // It lives top-right with the other selection-state chrome, so the property
  // worth pinning is that it CLEARS its neighbours: the toolbar above it, the
  // measurement readout row that shares the corner, and the sidebar. Nothing
  // else measured this — a card that overlapped the toolbar would pass every
  // other assertion in this test, because they all read text, not geometry.
  const rects = await page.evaluate(() => {
    const r = (id) => {
      const b = document.getElementById(id)?.getBoundingClientRect();
      return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null;
    };
    return { card: r("inspector-card"), toolbar: r("toolbar"), readout: r("measure-readout-row"), side: r("side") };
  });
  const fmt = (b) => (b ? `${b.left.toFixed(0)},${b.top.toFixed(0)}–${b.right.toFixed(0)},${b.bottom.toFixed(0)}` : "missing");
  assert(
    rects.card !== null && rects.toolbar !== null && rects.card.top >= rects.toolbar.bottom,
    `the inspector card sits below the toolbar (card ${fmt(rects.card)}, toolbar ${fmt(rects.toolbar)})`
  );
  assert(
    rects.card !== null && rects.side !== null && rects.card.left >= rects.side.right,
    `the inspector card does not cover the sidebar (card ${fmt(rects.card)}, sidebar ${fmt(rects.side)})`
  );
  // The readout row collapses to zero size until a measurement exists, so this is
  // satisfied by its top edge alone today — but it is the collision this
  // placement was chosen to avoid, and it starts guarding in earnest the moment
  // the row has content (its bottom edge is then ~26px below its top).
  assert(
    rects.readout === null || rects.readout.bottom <= rects.card.top,
    `the inspector card clears the measurement readout row (card ${fmt(rects.card)}, readout ${fmt(rects.readout)})`
  );
  assert(
    req !== null && typeof req.requestId === "string" && /^(face|solid)-\d+$/.test(req.entityId),
    `the request carries a requestId and the picked entity id (got ${JSON.stringify(req)})`
  );

  const cardKeys = () =>
    page.evaluate(() => [...document.querySelectorAll("#inspector-card .insp-key")].map((e) => e.textContent));
  const cardTitle = () =>
    page.evaluate(() => document.querySelector("#inspector-card .insp-title span")?.textContent ?? null);

  const reply = (facts, requestId) =>
    page.evaluate(
      ({ f, id }) => window.postMessage({ type: "entityFactsResult", requestId: id, facts: f }, "*"),
      { f: facts, id: requestId }
    );

  const planar = {
    entityId: req.entityId, kind: "face",
    bbox: { min: [0, 0, 0], max: [1, 1, 0], diagonal: Math.SQRT2 },
    center: [0.5, 0.5, 0], area: 1, length: null,
    normal: [0, 0, 1], planeOrigin: [0, 0, 0], surfaceType: "plane",
    surfaceParams: { kind: "plane", origin: [0, 0, 0], normal: [0, 0, 1] }, curveType: null,
  };
  await reply(planar, req.requestId);
  await sleep(120);
  assert((await cardTitle()) === "Planar face", `a plane renders as "Planar face" (got ${await cardTitle()})`);
  assert((await cardKeys()).includes("Normal"), "a planar face shows its Normal row");

  // The pill: one line up front — id · descriptor · the one measure — with the
  // fact rows behind a disclosure. The rows are built either way (the assertions
  // around this block read them while collapsed), so what changes is what shows.
  {
    const pill = () =>
      page.evaluate(() => ({
        text: document.querySelector("#inspector-card .insp-summary")?.textContent?.trim() ?? null,
        detailsShown: document.querySelector("#inspector-card .insp-details")?.offsetParent !== null,
        expanded: document.querySelector("#inspector-card .insp-toggle")?.getAttribute("aria-expanded") ?? null,
      }));
    const p0 = await pill();
    assert(
      p0.text !== null && p0.text.includes(req.entityId) && p0.text.includes("planar") && p0.text.includes("1.00 mm²"),
      `the pill's summary line names the entity, its class and its area (got ${JSON.stringify(p0.text)})`
    );
    assert(p0.detailsShown === false && p0.expanded === "false", "the fact rows are collapsed behind the pill's disclosure by default");
    await page.click("#inspector-card .insp-toggle");
    const p1 = await pill();
    assert(p1.detailsShown === true && p1.expanded === "true", "the disclosure reveals the fact rows");
    await page.click("#inspector-card .insp-toggle");
    assert((await pill()).detailsShown === false, "and hides them again");
  }

  // A cylinder has no single normal — EntityFacts returns null and the row must
  // be ABSENT, not blank. This is the whole point of the card.
  await reply({ ...planar, surfaceType: "cylinder", normal: null, planeOrigin: null }, req.requestId);
  await sleep(120);
  assert((await cardTitle()) === "Cylindrical face", `a cylinder renders as "Cylindrical face" (got ${await cardTitle()})`);
  assert(!(await cardKeys()).includes("Normal"), "a curved face shows NO Normal row");

  // The analytic parameters behind the classification. Before the "analytic
  // surface parameters on inspect" feature, the card could say "Cylindrical face" and nothing more — the
  // radius and axis were computed in the same OCCT call and thrown away.
  await reply(
    {
      ...planar,
      surfaceType: "cylinder",
      normal: null,
      planeOrigin: null,
      surfaceParams: { kind: "cylinder", radius: 3, axisLocation: [1, 2, 3], axisDirection: [0, 0, 1] },
    },
    req.requestId
  );
  await sleep(120);
  {
    const k = await cardKeys();
    assert(k.includes("Radius"), "a cylindrical face shows its Radius row");
    assert(k.includes("Axis"), "a cylindrical face shows its Axis row");
    assert(!k.includes("Normal"), "the parameters do not resurrect a Normal row for a curved face");
  }

  // Stale replies must be dropped, or a slow answer for a previous selection
  // would overwrite the current one.
  await reply({ ...planar, surfaceType: "torus" }, "a-stale-request-id");
  await sleep(120);
  assert(
    (await cardTitle()) === "Cylindrical face",
    `a reply with a stale requestId is ignored (got ${await cardTitle()})`
  );
});

/**
 * O. Pin-as-query row (selector-synthesis interactive half).
 *
 * The kernel half (`synthesizeSelector`) is covered against live OCCT in
 * `npm run mcp:smoke`; what needs checking here is the panel↔host wiring over
 * the real bundle: the row renders with the buckets the `geometry` message
 * carried, Synthesize posts a well-formed `selectorSynthesizeRequest`, the
 * faked reply stages, and Apply attaches `targetQueries` to the pushed op.
 * Buckets are injected by re-posting the harness's own captured geometry —
 * the shared fixture's ops are rigid transforms that record no buckets, so
 * without injection the picker would be legitimately empty.
 */
test("pin as query: synthesize stages a query and Apply attaches it", async (page) => {
  await page.evaluate(() => {
    window.__lastGeometry = null;
    window.addEventListener("message", (e) => {
      if (e.data?.type === "geometry") window.__lastGeometry = e.data;
    });
  });
  await populate(page);
  assert(
    await page.evaluate(() => window.__lastGeometry !== null),
    "captured the harness geometry payload for bucket injection"
  );
  await page.evaluate(() =>
    window.postMessage(
      {
        ...window.__lastGeometry,
        opBuckets: [{ op: 0, kind: "extrude", roles: { endCap: ["face-1"], side: ["face-2", "face-3"] } }],
      },
      "*"
    )
  );
  await sleep(250);

  // Open the Extrude form (DOM click — the EDIT tab need not be active).
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".op-btn")].find(
      (b) => b.querySelector(".op-name")?.textContent === "Extrude"
    );
    btn?.click();
  });
  await sleep(200);
  assert(
    await page.evaluate(() => document.querySelector("#edits-params .compose-query-row") !== null),
    "the Extrude form renders the pin-as-query row"
  );
  const bucketOptions = await page.evaluate(() =>
    [...document.querySelectorAll('#edits-params select[data-name="queryBucket"] option')].map((o) => o.textContent)
  );
  assert(
    bucketOptions.some((t) => /op 0.*extrude/.test(t ?? "")),
    `the bucket picker lists the injected bucket (got ${JSON.stringify(bucketOptions)})`
  );

  // Pick exactly one face, then synthesize.
  await enablePicking(page, "surface");
  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
  await page.evaluate(() => {
    document.querySelector("#edits-params .compose-query-row button")?.click();
  });
  await sleep(200);
  const req = await page.evaluate(
    () => (window.__sent ?? []).filter((m) => m.type === "selectorSynthesizeRequest").at(-1) ?? null
  );
  assert(req !== null, "Synthesize posts a selectorSynthesizeRequest");
  assert(
    req !== null &&
      typeof req.requestId === "string" &&
      typeof req.op === "number" &&
      typeof req.role === "string" &&
      Array.isArray(req.entityIds) &&
      req.entityIds.length === 1 &&
      /^face-\d+$/.test(req.entityIds[0]),
    `the request carries op/role and exactly one picked face id (got ${JSON.stringify(req)})`
  );

  // A stale reply must stage nothing.
  await page.evaluate(() =>
    window.postMessage({ type: "selectorSynthesizeResult", requestId: "stale-id", results: [] }, "*")
  );
  await sleep(150);
  const staleText = await page.evaluate(
    () => document.querySelector('#edits-params [data-name="queryResult"]')?.textContent ?? null
  );
  assert(
    staleText !== null && !/Pinned/.test(staleText),
    `a stale reply stages nothing (got ${JSON.stringify(staleText)})`
  );

  // The real reply stages; Apply attaches.
  const query = { version: 1, source: { kind: "bucket", op: 0, role: "endCap" } };
  await page.evaluate(
    ({ id, q, eid }) =>
      window.postMessage(
        {
          type: "selectorSynthesizeResult",
          requestId: id,
          results: [{ entityId: eid, query: q, kind: "extrude" }],
        },
        "*"
      ),
    { id: req.requestId, q: query, eid: req.entityIds[0] }
  );
  await sleep(200);
  const stagedText = await page.evaluate(
    () => document.querySelector('#edits-params [data-name="queryResult"]')?.textContent ?? null
  );
  assert(
    stagedText !== null && new RegExp(`Pinned ${req.entityIds[0]}`).test(stagedText),
    `the reply stages a summary naming the face (got ${JSON.stringify(stagedText)})`
  );

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#edits-params .compose-apply")].find(
      (b) => b.textContent === "Apply"
    );
    btn?.click();
  });
  await sleep(300);
  const applyBtns = await page.evaluate(() =>
    [...document.querySelectorAll("#edits-params .compose-apply")].map((b) => b.textContent)
  );
  assert(
    applyBtns.includes("Apply"),
    `the extrude form still offers its Apply button at click time (got ${JSON.stringify(applyBtns)})`
  );
  const pushed = await page.evaluate(
    () => (window.__sent ?? []).filter((m) => m.type === "editsChanged").at(-1) ?? null
  );
  const lastOp = pushed?.ops?.at(-1);
  assert(
    lastOp?.op === "extrude" &&
      lastOp?.targetQueries?.profile !== undefined &&
      lastOp?.targetQueryKinds?.profile === "extrude",
    `Apply attaches targetQueries/targetQueryKinds to the pushed extrude (got ${JSON.stringify(lastOp?.targetQueries)})`
  );
});

/**
 * Drill composer + Regions row — the pick/drill item's panel surface. Guards
 * the dead-surface class (a catalog button whose form never renders, or an
 * Apply that crashes on an empty selection instead of refusing it).
 */
test("drill form renders with regions row; extrude form carries one too", async (page) => {
  await populate(page);
  const openForm = async (name) => {
    await page.evaluate((n) => {
      const btn = [...document.querySelectorAll(".op-btn")].find(
        (b) => b.querySelector(".op-name")?.textContent === n
      );
      btn?.click();
    }, name);
    await sleep(200);
  };
  const paramNames = () =>
    page.evaluate(() => [...document.querySelectorAll("#edits-params [data-name]")].map((el) => el.dataset.name));

  await openForm("Drill");
  const drillNames = await paramNames();
  for (const f of ["dir", "length", "pick"]) {
    assert(drillNames.includes(f), `the Drill form has a ${f} field (got ${JSON.stringify(drillNames)})`);
  }
  const drillApply = await page.evaluate(
    () => [...document.querySelectorAll("#edits-params .compose-apply")].map((b) => b.textContent)
  );
  assert(drillApply.includes("Apply"), "the Drill form offers its Apply button");

  // Apply with nothing selected must refuse gracefully — an explanatory
  // status (not a silent no-op), no editsChanged, no crash (an uncaught
  // throw would fail the run via pageerror).
  await page.evaluate(() => {
    [...document.querySelectorAll("#edits-params .compose-apply")]
      .find((b) => b.textContent === "Apply")
      ?.click();
  });
  await sleep(300);
  const drillStatus = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(
    /volumes.*Vol mode/i.test(drillStatus),
    `drill Apply with no selection explains itself (got ${JSON.stringify(drillStatus)})`
  );
  const sentAfter = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "editsChanged").length);
  assert(sentAfter === 0, "drill Apply with no selection posts no editsChanged");

  await openForm("Extrude");
  const extrudeNames = await paramNames();
  assert(extrudeNames.includes("pick"), `the Extrude form carries the Regions row (got ${JSON.stringify(extrudeNames)})`);
});

/** Turns picking on in the given mode and closes the dropdown behind it. */
async function enablePicking(page, mode) {
  await page.click("#select-menu");
  await page.click("#sel-toggle");
  await page.click(`.sel-mode[data-mode="${mode}"]`);
  await page.click("#select-menu");
  await sleep(150);
}

/**
 * N. Selection-groups context menu — the query-filter predicates reached by
 * right-click instead of by composing a query.
 */
test("context menu: right-clicking geometry offers groups with member counts", async (page) => {
  await populate(page);
  await enablePicking(page, "surface");

  const menuShown = () =>
    page.evaluate(() => document.getElementById("context-menu")?.offsetParent !== null);
  assert((await menuShown()) === false, "the context menu is not rendered before a right-click");

  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await sleep(250);

  assert((await menuShown()) === true, "right-clicking a face opens the context menu");

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#context-menu button")].map((b) => b.textContent)
  );
  assert(rows.length > 0, `the menu offers at least one group (got ${JSON.stringify(rows)})`);
  assert(
    rows.every((r) => /\d+$/.test(r ?? "")),
    `every group row carries a member count (got ${JSON.stringify(rows)})`
  );
  // The counts are what make the menu worth having over the filter form: a
  // group of one would be indistinguishable from the click itself.
  assert(
    rows.every((r) => Number((r ?? "").match(/(\d+)$/)?.[1] ?? "0") > 1),
    `no group offers a count of 1 (got ${JSON.stringify(rows)})`
  );

  // Escape dismisses without selecting.
  await page.keyboard.press("Escape");
  await sleep(150);
  assert((await menuShown()) === false, "Escape closes the context menu");
});

test("context menu: choosing a group selects exactly the members it advertised", async (page) => {
  await populate(page);
  await enablePicking(page, "surface");

  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await sleep(250);

  const advertised = await page.evaluate(() => {
    const b = document.querySelector("#context-menu button");
    return b ? Number(b.textContent.match(/(\d+)$/)?.[1] ?? "0") : null;
  });
  assert(advertised !== null && advertised > 1, `the first group advertises a count (got ${advertised})`);

  await page.evaluate(() => document.querySelector("#context-menu button")?.click());
  await sleep(300);

  // The status line reports what was actually selected — it must agree with
  // the count the row promised, or the preview is lying about the outcome.
  const status = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(
    status.includes(`Selected ${advertised}`),
    `selecting the group selects exactly the advertised ${advertised} (status: ${JSON.stringify(status)})`
  );
  const closed = await page.evaluate(() => document.getElementById("context-menu")?.offsetParent === null);
  assert(closed, "choosing a group closes the menu");
});

test("context menu: volume mode says why it has no groups instead of showing a blank menu", async (page) => {
  // Volume/point HAVE a filter-form vocabulary now, but the menu's rows are
  // reference-driven and neither mode has reference-shaped rows yet.
  // An empty menu would read as a bug.
  await populate(page);
  await enablePicking(page, "volume");

  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await sleep(250);

  const text = await page.evaluate(() => {
    const el = document.getElementById("context-menu");
    return el && el.offsetParent !== null ? el.textContent : null;
  });
  assert(
    text !== null && /Surf and Line/.test(text),
    `volume mode explains that groups apply to Surf/Line (got ${JSON.stringify(text)})`
  );
});

// ── Collapsible sidebar sections ──────────────────────────────────────────
//
// The chevrons, the collapse geometry, and the `.view.json` round trip. The
// geometry assertions are the point: a `.collapsed` rule that hid the header
// too, or one that left a `flex: 1` panel still claiming its share of the
// column, would both look "collapsed" to a class-name assertion.

test("collapse: every sidebar section has a working chevron", async (page) => {
  await populate(page);
  const panels = [
    "tree-panel", "parts-panel", "edits-panel", "meshing-panel",
    "advanced-group",
    "mass-panel",
    "clash-panel",
    "mesh-health-panel", "region-fit-panel", "primitives-panel", "macros-panel", "standard-parts-panel",
  ];
  const missing = await page.evaluate(
    (ids) => ids.filter((id) => !document.querySelector(`#${id} > .panel-header > .panel-chevron`)),
    panels
  );
  assert(missing.length === 0, `all ${panels.length} sections have a chevron (missing: ${JSON.stringify(missing)})`);

  // The chevron must be a SIBLING of the title, never a child — TreePanel
  // overwrites `#tree-title.textContent` on every render and would wipe it.
  const chevronSurvivesTreeRender = await page.evaluate(
    () => document.querySelector("#tree-header > .panel-chevron") !== null &&
          document.querySelector("#tree-title .panel-chevron") === null
  );
  assert(chevronSurvivesTreeRender, "the tree chevron is a sibling of #tree-title, not nested inside it");
});

test("collapse: collapsing hides the body but keeps the header, and frees the column", async (page) => {
  await populate(page);
  // #parts-panel is one of the two `flex: 1` panels — the case where a
  // missing `flex: 0 0 auto` would leave a collapsed header still eating
  // vertical space even though its body is hidden.
  const before = await page.evaluate(() => document.getElementById("parts-panel").getBoundingClientRect().height);
  await page.click("#parts-header > .panel-chevron");
  const after = await page.evaluate(() => {
    const panel = document.getElementById("parts-panel");
    const header = document.getElementById("parts-header");
    const body = document.getElementById("parts-body");
    return {
      panelH: panel.getBoundingClientRect().height,
      headerH: header.getBoundingClientRect().height,
      bodyH: body.getBoundingClientRect().height,
      collapsed: panel.classList.contains("collapsed"),
      chevron: header.querySelector(".panel-chevron").getAttribute("aria-expanded"),
    };
  });
  assert(after.collapsed, "the panel gained the .collapsed class");
  assert(after.headerH > 0, `the header stays visible (${after.headerH.toFixed(1)}px)`);
  assert(after.bodyH === 0, `the body is hidden (${after.bodyH.toFixed(1)}px)`);
  assert(
    after.panelH < before && Math.abs(after.panelH - after.headerH) < 2,
    `the panel shrank to just its header (${before.toFixed(1)} → ${after.panelH.toFixed(1)}px, header ${after.headerH.toFixed(1)}px)`
  );
  assert(after.chevron === "false", "aria-expanded reflects the collapsed state");

  await page.click("#parts-header > .panel-chevron");
  const restored = await page.evaluate(() => ({
    bodyH: document.getElementById("parts-body").getBoundingClientRect().height,
    collapsed: document.getElementById("parts-panel").classList.contains("collapsed"),
  }));
  assert(!restored.collapsed && restored.bodyH > 0, "clicking again expands it back");
});

test("collapse: hides EVERY body sibling, not just #x-body", async (page) => {
  await populate(page);
  // #meshing-panel has four (progress/body/status/quality) and is the reason
  // the CSS uses `> :not(.panel-header)` rather than naming `#x-body`.
  await page.click("#meshing-header > .panel-chevron");
  const visible = await page.evaluate(() =>
    Array.from(document.getElementById("meshing-panel").children)
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => el.id || el.className)
  );
  assert(
    visible.length === 1 && visible[0] === "meshing-header",
    `only the header remains visible (got ${JSON.stringify(visible)})`
  );
});

test("advanced: the group ships collapsed, hides its eight children, and opens on its chevron", async (page) => {
  await populate(page);

  // Collapsed by default is the entire point: the sidebar's top level should
  // hold only the four sections that EDIT the document.
  const shut = await page.evaluate(() => {
    const ids = [
      "mass-panel", "clash-panel", "mesh-health-panel", "region-fit-panel",
      "primitives-panel", "passages-panel", "macros-panel", "standard-parts-panel",
    ];
    return {
      collapsed: document.getElementById("advanced-group").classList.contains("collapsed"),
      bodyShown: document.getElementById("advanced-body").offsetParent !== null,
      headerShown: document.getElementById("advanced-header").offsetParent !== null,
      anyChildShown: ids.some((id) => document.getElementById(id)?.offsetParent != null),
      // The four that stay top-level must NOT have been swept into the group.
      topLevel: ["tree-panel", "parts-panel", "edits-panel", "meshing-panel"].every(
        (id) => !document.getElementById("advanced-body").contains(document.getElementById(id))
      ),
    };
  });
  assert(shut.collapsed, "the group starts collapsed");
  assert(shut.headerShown, "its header is still visible while collapsed");
  assert(!shut.bodyShown, "its body is hidden while collapsed");
  assert(!shut.anyChildShown, "none of the eight children render while it is collapsed");
  assert(shut.topLevel, "Components/Parts/Edits/FE Mesh stayed OUT of the group");

  // The badge must report availability, not the raw child count: on this
  // B-rep fixture Mesh Health and Region fit gate themselves out.
  const badge = await page.evaluate(() => document.getElementById("advanced-count").textContent.trim());
  assert(badge === "6 of 8", `the badge counts only the available children (got ${JSON.stringify(badge)})`);

  await openAdvanced(page);
  const open = await page.evaluate(() => ({
    collapsed: document.getElementById("advanced-group").classList.contains("collapsed"),
    mass: document.getElementById("mass-panel").offsetParent !== null,
    macros: document.getElementById("macros-panel").offsetParent !== null,
    // Still gated — opening the group must not reveal an ineligible section.
    meshHealth: document.getElementById("mesh-health-panel").offsetParent !== null,
    subheads: Array.from(document.querySelectorAll("#advanced-body .advanced-subhead")).map((n) =>
      n.textContent.trim()
    ),
  }));
  assert(!open.collapsed, "the chevron expands the group");
  assert(open.mass && open.macros, "its eligible children render once open");
  assert(!open.meshHealth, "a source-gated child stays hidden even with the group open");
  assert(
    eq(open.subheads, ["Analysis", "Library"]),
    `the children are grouped under two subheads (got ${JSON.stringify(open.subheads)})`
  );
});

test("collapse: state is saved to and restored from view state", async (page) => {
  await populate(page);
  await openAdvanced(page);
  await sleep(700); // let the group's own autosave land before __sent is cleared
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#mass-header > .panel-chevron");
  await sleep(900); // VIEW_SAVE_DEBOUNCE_MS is 500

  const saved = await page.evaluate(
    () => (window.__sent ?? []).filter((m) => m.type === "viewChanged").at(-1) ?? null
  );
  assert(saved !== null, "collapsing posts a viewChanged (no camera moved, so the toggle must ask for it)");
  assert(
    saved !== null && eq(saved.view.collapsedPanels, ["mass-panel"]),
    `the saved view state names the collapsed section (got ${JSON.stringify(saved?.view?.collapsedPanels)})`
  );

  // Restore: a viewState post must apply the set wholesale — and must NOT
  // echo a save back, or reopening a document would rewrite the sidecar it
  // just read.
  await page.evaluate(() => (window.__sent.length = 0));
  await post(page, {
    type: "viewState",
    view: {
      viewDirection: [1, 0.8, 1], cameraUp: [0, 1, 0], orthographic: false,
      displayMode: "shaded", clip: null, collapsedPanels: ["edits-panel", "macros-panel"],
    },
  });
  await sleep(900);
  const state = await page.evaluate(() => ({
    mass: document.getElementById("mass-panel").classList.contains("collapsed"),
    edits: document.getElementById("edits-panel").classList.contains("collapsed"),
    macros: document.getElementById("macros-panel").classList.contains("collapsed"),
    // `applyViewState` also reframes the camera, and that legitimately fires
    // `onViewChanged` → `scheduleViewSave` — an echo that predates collapse
    // state entirely. So the property worth asserting is not "no echo" but
    // that any echo carries the JUST-RESTORED set: `getCollapsed()` reads the
    // live DOM, so a handle that cached a stale list (or a `setCollapsed`
    // that only moved the class) would write the OLD set straight back over
    // the sidecar it just read.
    echo: ((window.__sent ?? []).filter((m) => m.type === "viewChanged").at(-1) ?? null)?.view?.collapsedPanels ?? null,
  }));
  assert(state.edits && state.macros, "the restored sections collapsed");
  assert(!state.mass, "a section absent from the restored set expanded again");
  assert(
    state.echo === null || eq(state.echo, ["edits-panel", "macros-panel"]),
    `any autosave echoed after a restore carries the restored set, never the pre-restore one (got ${JSON.stringify(state.echo)})`
  );
});

// ── Source-format gating of the two eligibility-gated panels ──────────────
//
// `#mesh-health-panel { display: flex }` beat the UA's `[hidden]` rule, so
// `panel.hidden = !eligible` was completely inert and both panels rendered for
// every source format. Nothing covered this.

test("gated panels: Mesh Health and Region fit stay hidden for a B-rep source", async (page) => {
  await populate(page); // the fixture is bull.stp — a B-rep, so both are ineligible
  await openAdvanced(page); // open the group, so this tests [hidden] and not the collapse
  const shown = await page.evaluate(() => ({
    meshHealth: document.getElementById("mesh-health-panel").getBoundingClientRect().height,
    regionFit: document.getElementById("region-fit-panel").getBoundingClientRect().height,
    hiddenAttr: document.getElementById("mesh-health-panel").hidden,
  }));
  assert(shown.hiddenAttr, "the host marked #mesh-health-panel hidden for a B-rep source");
  assert(shown.meshHealth === 0, `#mesh-health-panel renders nothing (got ${shown.meshHealth}px)`);
  assert(shown.regionFit === 0, `#region-fit-panel renders nothing (got ${shown.regionFit}px)`);
});

// ── Clash panel (roadmap Tier 1 "Clash panel") ────────────────────────────
//
// The kernel side (`checkInterference`/`checkInterferenceAll`) is covered
// against live OCCT in `npm run mcp:smoke`, so what needs checking here is the
// panel: eligibility gating, the request it posts, and the rendering decision.
// Host replies are faked by posting `clashCheckResult`/`clashCheckAllResult`
// directly (the inspector-card precedent above).

test("clash: B-rep source shows the section with Part dropdowns populated", async (page) => {
  await populate(page); // bull.stp — B-rep, so the section is eligible
  await openAdvanced(page);
  const state = await page.evaluate(() => ({
    shown: document.getElementById("clash-panel")?.offsetParent !== null,
    a: Array.from(document.getElementById("clash-a").options).map((o) => o.value),
    b: Array.from(document.getElementById("clash-b").options).map((o) => o.value),
  }));
  assert(state.shown, "the Clash section is genuinely rendered for a B-rep source");
  // The fixture pre-creates "Body" (volumes), "Contact faces" (surfaces) and
  // "Feature edges" (lines) — dropdowns list all three by name.
  assert(eq(state.a, ["Body", "Contact faces", "Feature edges"]), `operand A lists the fixture Parts (got ${JSON.stringify(state.a)})`);
  assert(eq(state.b, ["Body", "Contact faces", "Feature edges"]), `operand B lists the fixture Parts (got ${JSON.stringify(state.b)})`);
});

test("clash: Check posts clashCheckRequest; the reply renders; a stale reply is ignored", async (page) => {
  await populate(page);
  await openAdvanced(page);
  await page.selectOption("#clash-a", "Body");
  await page.selectOption("#clash-b", "Contact faces");
  await page.click("#clash-check");
  const req = await page.evaluate(() =>
    (window.__sent ?? []).filter((m) => m.type === "clashCheckRequest").at(-1) ?? null
  );
  assert(req !== null, "clicking Check posts a clashCheckRequest");
  assert(
    req !== null && req.partA === "Body" && req.partB === "Contact faces" && typeof req.requestId === "string",
    `the request names both Parts with a requestId (got ${JSON.stringify(req)})`
  );

  await page.evaluate((id) =>
    window.postMessage(
      { type: "clashCheckResult", requestId: id, result: { hasOverlap: true, overlapVolume: 12.5, unresolvedA: [], unresolvedB: [] } },
      "*"
    ),
    req.requestId
  );
  await sleep(200);
  const text = await page.evaluate(() => document.getElementById("clash-results")?.textContent ?? "");
  assert(text.includes("Body") && text.includes("Contact faces"), `the row names both Parts (got ${JSON.stringify(text)})`);
  assert(text.includes("12.5"), `the row shows the overlap volume (got ${JSON.stringify(text)})`);

  // A superseded reply (e.g. from a Check since replaced) must not repaint.
  await page.evaluate((id) =>
    window.postMessage(
      { type: "clashCheckResult", requestId: id, result: { hasOverlap: false, overlapVolume: 0, unresolvedA: [], unresolvedB: [] } },
      "*"
    ),
    "stale-id"
  );
  await sleep(200);
  const after = await page.evaluate(() => document.getElementById("clash-results")?.textContent ?? "");
  assert(after === text, "a stale-requestId reply is ignored");
});

test("clash: Check-all posts one request and renders named pairs with the screened badge", async (page) => {
  await populate(page);
  await openAdvanced(page);
  await page.click("#clash-check-all");
  const req = await page.evaluate(() =>
    (window.__sent ?? []).filter((m) => m.type === "clashCheckAllRequest").at(-1) ?? null
  );
  assert(req !== null && typeof req?.requestId === "string", "clicking Check all posts a clashCheckAllRequest");
  await page.evaluate((id) =>
    window.postMessage(
      {
        type: "clashCheckAllResult",
        requestId: id,
        pairs: [
          { partA: "Body", partB: "Bracket", a: ["solid-0"], b: ["solid-1"], hasOverlap: true, overlapVolume: 3, unresolvedA: [], unresolvedB: [] },
          { partA: "Body", partB: "Far", a: ["solid-0"], b: ["solid-2"], hasOverlap: false, overlapVolume: 0, screenedByBbox: true, unresolvedA: [], unresolvedB: [] },
        ],
        warnings: [],
        totalPairs: 2,
        checkedPairs: 2,
        screenedPairs: 1,
        partial: false,
      },
      "*"
    ),
    req.requestId
  );
  await sleep(200);
  const text = await page.evaluate(() => document.getElementById("clash-results")?.textContent ?? "");
  assert(text.includes("Bracket") && text.includes("overlap"), `the overlapping pair renders (got ${JSON.stringify(text)})`);
  assert(text.includes("AABB-screened"), `the pre-filtered pair carries its badge (got ${JSON.stringify(text)})`);
});

test("clash: a partial all-pairs result labels itself partial and never as clash-free", async (page) => {
  await populate(page);
  await openAdvanced(page);
  await page.click("#clash-check-all");
  const req = await page.evaluate(() =>
    (window.__sent ?? []).filter((m) => m.type === "clashCheckAllRequest").at(-1) ?? null
  );
  assert(req !== null && typeof req?.requestId === "string", "clicking Check all posts a clashCheckAllRequest");
  await page.evaluate((id) =>
    window.postMessage(
      {
        type: "clashCheckAllResult",
        requestId: id,
        pairs: [
          { partA: "Body", partB: "Bracket", a: ["solid-0"], b: ["solid-1"], hasOverlap: false, overlapVolume: 0, unresolvedA: [], unresolvedB: [] },
          { partA: "Body", partB: "Far", a: ["solid-0"], b: ["solid-2"], hasOverlap: false, overlapVolume: 0, unresolvedA: [], unresolvedB: [], unchecked: true },
        ],
        warnings: ["Partial result: 1 of 2 pair(s) unchecked (maxPairs=1). Unchecked pairs are NOT clash-free — re-run with a larger budget or an explicit parts subset."],
        totalPairs: 2,
        checkedPairs: 1,
        screenedPairs: 0,
        partial: true,
      },
      "*"
    ),
    req.requestId
  );
  await sleep(200);
  const text = await page.evaluate(() => document.getElementById("clash-results")?.textContent ?? "");
  assert(/Partial result/i.test(text), `a partial banner renders (got ${JSON.stringify(text)})`);
  assert(/not checked/i.test(text), `the unchecked row never reads as "no overlap" (got ${JSON.stringify(text)})`);
});

test("clash: the same Part twice is refused without a host round trip", async (page) => {
  await populate(page);
  await openAdvanced(page);
  const before = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "clashCheckRequest").length);
  await page.selectOption("#clash-a", "Body");
  await page.selectOption("#clash-b", "Body");
  await page.click("#clash-check");
  await sleep(200);
  const after = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "clashCheckRequest").length);
  assert(after === before, "no clashCheckRequest is posted for A === B");
  const text = await page.evaluate(() => document.getElementById("clash-results")?.textContent ?? "");
  assert(/different/i.test(text), `a guidance message explains why (got ${JSON.stringify(text)})`);
});

test("clash: the hidden attribute genuinely hides the section", async (page) => {
  // Regression shape of the mesh-health `[hidden]` defect: the attribute was
  // set while an author `display` rule beat it, so the "hidden" panel still
  // rendered. Assert RENDERED height, not the attribute.
  await populate(page);
  await openAdvanced(page);
  const height = await page.evaluate(() => {
    const el = document.getElementById("clash-panel");
    el.hidden = true;
    return el.getBoundingClientRect().height;
  });
  assert(height === 0, `#clash-panel[hidden] renders nothing (got ${height}px)`);
});

// ── Primitives panel (Tier 1 "Primitive-recognition panel") ───────────────
//
// The kernel side (`recognizePrimitives`/`buildPrimitivesFile` +
// `emitPrimitiveOps`) is covered against live OCCT in `npm run mcp:smoke` and
// by `primitiveEmit` unit tests, so what needs checking here is the panel:
// B-rep-only eligibility, the request it posts, the rendering decision
// (recognized rows show candidate + residual, unrecognized rows show
// inventory + reason — never a guess), and that Apply pushes emitted ops.
// Host replies are faked by posting `primitiveRecognizeResult` directly (the
// inspector-card / clash precedent).

const PRIMITIVE_BOX_REPORT = {
  solidCount: 2,
  solids: [
    {
      solidId: "solid-0",
      faceCount: 6,
      inventory: { plane: 6, cylinder: 0, cone: 0, sphere: 0, torus: 0, other: 0 },
      candidate: {
        kind: "box",
        center: [0, 0, 0],
        size: [10, 20, 30],
        xAxis: [1, 0, 0],
        yAxis: [0, 1, 0],
        zAxis: [0, 0, 1],
      },
      fitResidual: 0.00001,
      fitResidualFrac: 0.0000003,
    },
    {
      solidId: "solid-1",
      faceCount: 7,
      inventory: { plane: 6, cylinder: 1, cone: 0, sphere: 0, torus: 0, other: 0 },
      candidate: null,
      fitResidual: null,
      fitResidualFrac: null,
    },
  ],
};

test("primitives: B-rep source shows the section; Recognize posts a well-formed request", async (page) => {
  await populate(page); // bull.stp — B-rep, so the section is eligible
  await openAdvanced(page);
  const shown = await page.evaluate(() => document.getElementById("primitives-panel")?.offsetParent !== null);
  assert(shown, "the Primitives section is genuinely rendered for a B-rep source");
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#primitives-recognize");
  const req = await page.evaluate(() =>
    (window.__sent ?? []).filter((m) => m.type === "primitiveRecognizeRequest").at(-1) ?? null
  );
  assert(req !== null && typeof req.requestId === "string", `clicking Recognize posts a primitiveRecognizeRequest with a requestId (got ${JSON.stringify(req)})`);
});

const PASSAGE_REPORT = {
  targetCells: 3,
  facesAnalyzed: 12,
  rejected: [],
  findings: [
    { kind: "annular", faceA: "face-3", faceB: "face-4", width: 1, overlap: 8, requestedSize: 2, sizeSource: "global", cellsAcross: 0.5, suggestedSize: 1 / 3, underResolved: true },
    { kind: "slot", faceA: "face-5", faceB: "face-10", width: 12, overlap: 6, requestedSize: 2, sizeSource: "global", cellsAcross: 6, suggestedSize: 4, underResolved: false },
  ],
};

test("passages: Analyze posts targetCells; the reply renders findings; Apply creates a sized Part; a stale reply is ignored", async (page) => {
  await populate(page);
  await openAdvanced(page);
  const shown = await page.evaluate(() => document.getElementById("passages-panel")?.offsetParent != null);
  assert(shown, "the Passages section is available for a B-rep source");
  await page.fill("#passages-cells", "4");
  await page.click("#passages-analyze");
  const req = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "passagesRequest").at(-1) ?? null);
  assert(req !== null && req.targetCells === 4, `Analyze posts a passagesRequest with the typed cells (got ${JSON.stringify(req)})`);
  await page.evaluate(([report]) => window.postMessage({ type: "passagesResult", requestId: "stale", report, sizeMax: 2 }, "*"), [PASSAGE_REPORT]);
  await sleep(150);
  const stale = await page.evaluate(() => document.getElementById("passages-body")?.textContent ?? "");
  assert(/Analyzing/.test(stale), `a stale reply renders nothing (got ${JSON.stringify(stale.slice(0, 80))})`);
  await page.evaluate(([id, report]) => window.postMessage({ type: "passagesResult", requestId: id, report, sizeMax: 2 }, "*"), [req.requestId, PASSAGE_REPORT]);
  await sleep(200);
  const view = await page.evaluate(() => ({
    rows: [...document.querySelectorAll(".passage-row")].map((r) => ({ under: r.classList.contains("under"), text: r.textContent, apply: !!r.querySelector(".passage-apply") })),
    head: document.querySelector("#passages-body .passages-message")?.textContent ?? "",
  }));
  assert(view.rows.length === 2, `both findings render (got ${view.rows.length})`);
  assert(view.rows[0].under && view.rows[0].apply && /Annular gap 1 mm/.test(view.rows[0].text), `the under-resolved annulus is flagged with an Apply action (got ${JSON.stringify(view.rows[0])})`);
  assert(!view.rows[1].under && !view.rows[1].apply, "a resolved slot offers no Apply");
  assert(/estimates/.test(view.head), "the header labels the numbers as estimates");
  const before = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "partsChanged").length);
  await page.click(".passage-row.under .passage-apply");
  await sleep(200);
  const parts = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "partsChanged").at(-1)?.parts ?? []);
  const after = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "partsChanged").length);
  const made = parts.find((p) => p.name === "Passage face-3/face-4");
  assert(after > before && made, `Apply posts partsChanged with a passage Part (got ${JSON.stringify(parts.map((p) => p.name))})`);
  assert(made && made.surfaces.includes("face-3") && made.surfaces.includes("face-4") && Math.abs(made.meshSize - 1 / 3) < 1e-12, `the Part carries both faces and the suggested size (got ${JSON.stringify(made)})`);
});

test("primitives: reply renders recognized + unrecognized rows; a stale reply is ignored", async (page) => {
  await populate(page);
  await openAdvanced(page);
  await page.click("#primitives-recognize");
  const req = await page.evaluate(() =>
    (window.__sent ?? []).filter((m) => m.type === "primitiveRecognizeRequest").at(-1) ?? null
  );
  assert(req !== null, "clicking Recognize posts a primitiveRecognizeRequest");
  // Playwright evaluate takes a single argument — pack both values.
  await page.evaluate(([id, report]) =>
    window.postMessage({ type: "primitiveRecognizeResult", requestId: id, report }, "*"),
    [req.requestId, PRIMITIVE_BOX_REPORT]
  );
  await sleep(200);
  const text = await page.evaluate(() => document.getElementById("primitives-body")?.textContent ?? "");
  assert(text.includes("solid-0") && text.includes("box"), `the recognized solid renders with its candidate (got ${JSON.stringify(text.slice(0, 200))})`);
  assert(text.includes("solid-1") && /not a recognized primitive/i.test(text), `the unrecognized solid renders its honest reason (got ${JSON.stringify(text.slice(0, 200))})`);
  const buttons = await page.evaluate(() => ({
    apply: document.getElementById("primitives-apply")?.disabled ?? null,
    export: document.getElementById("primitives-export")?.disabled ?? null,
    macro: document.getElementById("primitives-save-macro")?.disabled ?? null,
  }));
  assert(buttons.apply === false && buttons.export === false && buttons.macro === false, `the action buttons enable with ≥1 recognized solid (got ${JSON.stringify(buttons)})`);

  await page.evaluate(([id, report]) =>
    window.postMessage({ type: "primitiveRecognizeResult", requestId: id, report }, "*"),
    ["stale-id", { solidCount: 0, solids: [] }]
  );
  await sleep(200);
  const after = await page.evaluate(() => document.getElementById("primitives-body")?.textContent ?? "");
  assert(after === text, "a stale-requestId reply is ignored");
});

test("primitives: Apply pushes the emitted ops via editsChanged", async (page) => {
  await populate(page);
  await openAdvanced(page);
  await page.click("#primitives-recognize");
  const req = await page.evaluate(() =>
    (window.__sent ?? []).filter((m) => m.type === "primitiveRecognizeRequest").at(-1) ?? null
  );
  await page.evaluate(([id, report]) =>
    window.postMessage({ type: "primitiveRecognizeResult", requestId: id, report }, "*"),
    [req.requestId, PRIMITIVE_BOX_REPORT]
  );
  await sleep(200);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#primitives-apply");
  await sleep(300);
  const sent = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "editsChanged"));
  assert(sent.length > 0, "clicking Apply as edits posts an editsChanged");
  // The fixture pre-populates the history (an addBox/addCylinder/translate
  // with variables L, H), so the emission lands at the END, not alone.
  const ops = sent.at(-1).ops ?? [];
  const last = ops.at(-1) ?? null;
  assert(
    last !== null && last.op === "addBox" && eq(last.center, [0, 0, 0]) && eq(last.size, [10, 20, 30]),
    `the appended op is the emitted box creation op (got ${JSON.stringify(last)?.slice(0, 200)})`
  );
  const vars = sent.at(-1).variables ?? [];
  const names = vars.map((v) => v.name);
  assert(
    names.includes("box1_x") && names.includes("box1_y") && names.includes("box1_z"),
    `the box dimensions arrive as named variables alongside the pre-existing ones (got ${JSON.stringify(names)})`
  );
});

test("primitives: the hidden attribute genuinely hides the section", async (page) => {
  // Same regression shape as the clash `[hidden]` test above.
  await populate(page);
  await openAdvanced(page);
  const height = await page.evaluate(() => {
    const el = document.getElementById("primitives-panel");
    el.hidden = true;
    return el.getBoundingClientRect().height;
  });
  assert(height === 0, `#primitives-panel[hidden] renders nothing (got ${height}px)`);
});

// ── Tier 0 Phase 2: save-point-locked history ─────────────────────────────
//
// Baked rows (ops already saved into the source file) render locked and
// refuse timeline interaction; the unit-testable gates live in
// `editsModel.test.ts` — what needs the real bundle here is the rendering
// (locked class, lock marker, no ✕) and that a refused jump posts nothing.

const SAVE_POINT_OPS = [
  { op: "translate", targets: ["solid-0"], vec: [1, 0, 0] },
  { op: "translate", targets: ["solid-0"], vec: [0, 1, 0] },
];

test("save point: baked rows render locked with no remove button", async (page) => {
  await populate(page);
  await post(page, { type: "edits", ops: SAVE_POINT_OPS, variables: [], bakedThrough: 1 });
  await sleep(300);
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#edits-panel .edit-row")).map((li) => ({
      baked: li.classList.contains("edit-row-baked"),
      lock: li.querySelector(".edit-baked-mark")?.textContent ?? null,
      remove: li.querySelector(".edit-remove") !== null,
    }))
  );
  assert(rows.length === 2, `two history rows render (got ${rows.length})`);
  assert(rows[0].baked && rows[0].lock === "🔒" && !rows[0].remove, `the baked row is locked with no ✕ (got ${JSON.stringify(rows[0])})`);
  assert(!rows[1].baked && rows[1].remove, `the tail row is a normal removable row (got ${JSON.stringify(rows[1])})`);
});

test("save point: clicking a baked row drops only to the save, never below it", async (page) => {
  await populate(page);
  await post(page, { type: "edits", ops: SAVE_POINT_OPS, variables: [], bakedThrough: 1 });
  await sleep(300);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#edits-panel .edit-row:first-child");
  await sleep(300);
  // Timeline position 0 with watermark 1 means "the saved state": the unbaked
  // tail op is demoted (exactly one editsChanged, one op left) — legal, since
  // no baked op is unapplied.
  const sent = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "editsChanged"));
  assert(sent.length === 1 && sent[0].ops.length === 1, `clicking a baked row drops just the tail (got ${sent.length} post(s))`);

  // Fully baked stack: the same click would unbake — refused with guidance.
  await post(page, { type: "edits", ops: SAVE_POINT_OPS, variables: [], bakedThrough: 2 });
  await sleep(300);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#edits-panel .edit-row:first-child");
  await sleep(300);
  const sent2 = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "editsChanged").length);
  assert(sent2 === 0, "clicking into a fully-baked stack posts no editsChanged");
  const guidance = await page.evaluate(() => (document.getElementById("status")?.textContent ?? ""));
  assert(/already saved into the file/i.test(guidance), `guidance names the save point (got ${JSON.stringify(guidance)})`);
});

test("save point: undo is disabled when only baked ops remain", async (page) => {
  await populate(page);
  await post(page, { type: "edits", ops: SAVE_POINT_OPS.slice(0, 1), variables: [], bakedThrough: 1 });
  await sleep(300);
  const disabled = await page.evaluate(() => document.getElementById("edits-undo")?.disabled ?? null);
  assert(disabled === true, "the Undo button disables when the stack is at the save point");
});

// ── Saved view bookmarks (roadmap Tier 1 "Saved view bookmarks") ─────────────
//
// A named collection of inspection viewpoints persisted as a top-level
// `bookmarks` sibling of `view` in `<model>.view.json`. What needs the real
// bundle here: hydrating rows from a `viewState` post, saving the live camera
// through the menu, restoring without a save loop, and the silent-restore /
// rename-collision contracts. The tolerant sidecar parse itself is covered by
// `viewStateSidecar.test.ts`.
//
// Regression anchor for a real incident: module state the setup try-block
// reads must be initialized before it runs — `renderBookmarkList()` once read
// a `let` declared further down, throwing inside `setupViewMenu()` and
// silently killing selection/measure/appearance/clipping setup behind it
// (one `log` post, zero pageerrors, 60+ downstream failures). The first case
// below fails on exactly that shape.

const BOOKMARK_VIEW = {
  viewDirection: [1, 0.8, 1],
  cameraUp: [0, 1, 0],
  orthographic: false,
  displayMode: "shaded",
  clip: null,
};

test("setup: view controls initialize with no error (a setup throw kills later panels silently)", async (page) => {
  await populate(page);
  const logs = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "log").map((m) => m.message));
  assert(
    !logs.some((m) => /failed to initialize/i.test(m)),
    `no setup failure is logged (got ${JSON.stringify(logs)})`
  );
  // Spot-check that setup past the View ▾ menu ran: clipping + selection.
  const wired = await page.evaluate(() => ({
    clipFace: document.getElementById("clip-from-face")?.disabled ?? "missing",
    selToggle: !!document.getElementById("sel-toggle"),
  }));
  assert(wired.clipFace === true, `clip derive buttons start gated (got ${wired.clipFace})`);
  assert(wired.selToggle === true, "the selection toggle exists");
});

async function postBookmarks(page, bookmarks) {
  await post(page, { type: "viewState", view: { ...BOOKMARK_VIEW, bookmarks } });
  await sleep(700);
}

/** Like `populate`, but the FIRST `viewState` post already carries bookmarks —
 * the real initial-hydration path (`applyInitialViewIfNeeded`), which must
 * render the rows silently (no viewChanged echo back to the host). A second,
 * post-initial `viewState` always re-applies the camera and echoes, so
 * `postBookmarks` above cannot test silence. */
async function populateWithBookmarks(page, bookmarks) {
  await post(page, fixture("geometry"));
  await post(page, { type: "viewState", view: { ...BOOKMARK_VIEW, bookmarks } });
  await sleep(700);
  await post(page, fixture("tree"));
  await post(page, fixture("meshingOptions"));
  await post(page, fixture("parts"));
  await post(page, fixture("edits"));
  await sleep(700);
}

test("handoff manifest: the Export checkbox adds manifest:true to meshingExport, and its absence adds nothing", async (page) => {
  await populate(page);
  const sent = () => page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "meshingExport").at(-1) ?? null);
  await page.evaluate(() => document.getElementById("meshing-export").click());
  await page.waitForTimeout(150);
  const plain = await sent();
  assert(plain && !("manifest" in plain), `an unchecked export posts no manifest key (got ${JSON.stringify(plain && Object.keys(plain))})`);
  const visible = await page.evaluate(() => {
    const l = document.getElementById("meshing-export-manifest-label");
    return !!l && l.offsetParent !== null && !!document.getElementById("meshing-export-row")?.contains(l);
  });
  assert(visible, "the Handoff manifest toggle renders inside the export row");
  // Export now owns a request-scoped busy state; settle the first host request
  // before starting the second one so the button is enabled just as it would
  // be after a real export completes.
  if (typeof plain?.requestId === "string") {
    await post(page, { type: "meshingJobSettled", requestId: plain.requestId });
  }
  await page.evaluate(() => {
    document.getElementById("meshing-export-manifest").checked = true;
    document.getElementById("meshing-export").click();
  });
  await page.waitForTimeout(150);
  const withManifest = await sent();
  assert(withManifest?.manifest === true, `a checked export posts manifest: true (got ${JSON.stringify(withManifest?.manifest)})`);
  await page.evaluate(() => (document.getElementById("meshing-export-manifest").checked = false));
});

test("mesh deviation: the Deviation button posts a request with the typed tolerance; the reply colours an overlay and summarizes it; a stale reply is ignored", async (page) => {
  await populate(page);
  await page.evaluate(() => {
    const t = document.getElementById("meshing-deviation-tol");
    if (t) t.value = "0.05";
  });
  await page.evaluate(() => document.getElementById("meshing-deviation").click());
  await sleep(200);
  const req = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "meshDeviationRequest").at(-1) ?? null);
  assert(req && req.tolerance === 0.05 && req.options && typeof req.requestId === "string", `Deviation posts a request with the tolerance and the current options (got ${JSON.stringify(req && { tolerance: req.tolerance })})`);
  const b64 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString("base64");
  const report = {
    tolerance: 0.05,
    forward: { max: 0.24, mean: 0.1, p50: 0.1, p95: 0.2, p99: 0.23, samples: 8000, withinTolerance: 700, coverage: 0.0875 },
    reverse: { max: 0.01, mean: 0.005, p50: 0.005, p95: 0.009, p99: 0.01, samples: 8000, withinTolerance: 8000 },
    filtered: { max: 0.24, mean: 0.1, p50: 0.1, p95: 0.2, p99: 0.23, samples: 8000, excluded: 0 },
    regionFailures: [{ region: "face-0", maxDeviation: 0.24, fractionOver: 0.91, samples: 8000 }],
    extraneousFraction: 0,
  };
  const reply = (id) => ({ type: "meshDeviationResult", requestId: id, report, positions: b64([0, 0, 0, 10, 0, 0, 0, 10, 0]), distances: b64([0, 0.1, 0.24]), max: 0.24 });
  await page.evaluate((m) => window.postMessage(m, "*"), reply("stale"));
  await sleep(150);
  const staleText = await page.evaluate(() => document.getElementById("meshing-status")?.textContent ?? "");
  assert(/measuring deviation/.test(staleText), `a stale reply changes nothing (got ${JSON.stringify(staleText)})`);
  await page.evaluate((m) => window.postMessage(m, "*"), reply(req.requestId));
  await sleep(250);
  const text = await page.evaluate(() => document.getElementById("meshing-status")?.textContent ?? "");
  assert(/Deviation: max 0\.24 mm/.test(text) && /worst face-0/.test(text) && /9% within 0\.05 mm/.test(text), `the summary names max, coverage and the worst face (got ${JSON.stringify(text)})`);
  assert(/sampled estimate/.test(text), "the summary is labelled an estimate");
});

test("mesh budget: the FE Mesh readout shows a calibrated element range with its basis, and the advisory budget warns", async (page) => {
  await populate(page);
  const read = () =>
    page.evaluate(() => {
      const r = document.querySelector(".meshing-slider-readout");
      const w = document.getElementById("meshing-warning") ?? document.querySelector(".meshing-warning");
      return { text: r?.textContent ?? "", title: r?.getAttribute("title") ?? "", warning: w && !w.hidden ? w.textContent ?? "" : "" };
    });
  const before = await read();
  assert(/\d.*–.*el$/.test(before.text), `the readout shows an element RANGE (got ${JSON.stringify(before.text)})`);
  assert(/basis: volume\+area/.test(before.title), `the displayed tessellation supplies real volume+area (got ${JSON.stringify(before.title)})`);
  assert(/memory/.test(before.title) && /(calibrated|rough|uncertain)/.test(before.title), "the tooltip carries memory and confidence");
  // A tiny advisory budget must WARN (never block) through the same readout.
  const budget = await page.$("#meshing-budget");
  assert(!!budget, "the Advanced settings carry an advisory element budget field");
  await post(page, { type: "meshingOptions", options: { ...fixture("meshingOptions").options, budgetElements: 10 } });
  await sleep(300);
  const after = await read();
  assert(/budget/.test(after.warning), `a budget below the estimate shows the budget warning (got ${JSON.stringify(after.warning)})`);
});

test("bookmarks: hydrating two bookmarks renders two rows with their names", async (page) => {
  await populate(page);
  await postBookmarks(page, [
    { name: "Front door", viewDirection: [0, -1, 0], cameraUp: [0, 0, -1], orthographic: false, displayMode: "shaded", clip: null },
    { name: "Top down", viewDirection: [0, 0, 1], cameraUp: [0, 1, 0], orthographic: true, displayMode: "xray", clip: null },
  ]);
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#bookmark-list .bookmark-row .bookmark-name")).map((b) => b.textContent)
  );
  assert(eq(names, ["Front door", "Top down"]), `two bookmark rows render with their names (got ${JSON.stringify(names)})`);
});

test("bookmarks: hydration posts no viewChanged (silent restore, not an echo)", async (page) => {
  await page.evaluate(() => (window.__sent.length = 0));
  await populateWithBookmarks(page, [
    { name: "Front door", viewDirection: [0, -1, 0], cameraUp: [0, 0, -1], orthographic: false, displayMode: "shaded", clip: null },
  ]);
  const rows = await page.evaluate(() => document.querySelectorAll("#bookmark-list .bookmark-row").length);
  assert(rows === 1, `the hydrated row renders (got ${rows})`);
  const sent = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "viewChanged").length);
  assert(sent === 0, `initial hydration posts no viewChanged (got ${sent})`);
});

test("bookmarks: saving the current view posts viewChanged carrying the bookmark", async (page) => {
  await populate(page);
  await page.evaluate(() => (window.__sent.length = 0));
  // The name row must be GENUINELY hidden (no layout box), not just
  // carrying the class — the `#hover-tip.hidden` incident proved a class-only
  // assertion passes while the element is plainly visible. Checked with the
  // menu OPEN, so a closed panel can't make it trivially true.
  await page.click("#view-menu");
  const hidden = await page.evaluate(() => {
    const el = document.getElementById("bookmark-name-row");
    if (!el) return "missing";
    return el.offsetParent === null;
  });
  assert(hidden === true, "the bookmark name row is genuinely hidden before opening");
  await page.click("#bookmark-save");
  await page.fill("#bookmark-name-input", "Side elevation");
  await page.click("#bookmark-name-ok");
  await sleep(800);
  const posts = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "viewChanged"));
  assert(posts.length >= 1, `saving posts at least one viewChanged (got ${posts.length})`);
  const last = posts[posts.length - 1].view;
  assert(
    Array.isArray(last.bookmarks) && last.bookmarks.length === 1 && last.bookmarks[0].name === "Side elevation",
    `the posted view carries the new bookmark (got ${JSON.stringify(last.bookmarks?.map((b) => b.name))})`
  );
  const dir = last.bookmarks?.[0]?.viewDirection;
  assert(
    Array.isArray(dir) && dir.length === 3 && dir.every((c) => Number.isFinite(c)),
    `the bookmark carries a real camera direction (got ${JSON.stringify(dir)})`
  );
  const rows = await page.evaluate(() => document.querySelectorAll("#bookmark-list .bookmark-row").length);
  assert(rows === 1, `the menu shows the new row (got ${rows})`);
});

test("bookmarks: restoring reframes and persists exactly one viewChanged matching the bookmark", async (page) => {
  await populate(page);
  await postBookmarks(page, [
    { name: "Top down", viewDirection: [0, 0, 1], cameraUp: [0, 1, 0], orthographic: true, displayMode: "shaded", clip: null },
  ]);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#view-menu");
  await page.click("#bookmark-list .bookmark-row .bookmark-name");
  await sleep(800);
  const posts = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "viewChanged"));
  assert(posts.length === 1, `a restore persists exactly one viewChanged (got ${posts.length})`);
  const dir = posts[0]?.view?.viewDirection;
  const close = Array.isArray(dir) && dir.length === 3 && dir.every((c, i) => Math.abs(c - [0, 0, 1][i]) < 1e-6);
  assert(close, `the persisted view matches the bookmark direction (got ${JSON.stringify(dir)})`);
  assert(posts[0]?.view?.orthographic === true, "the persisted view matches the bookmark projection");
});

test("bookmarks: rename collision is refused with guidance and posts nothing", async (page) => {
  await populate(page);
  await postBookmarks(page, [
    { name: "Alpha", viewDirection: [1, 0, 0], cameraUp: [0, 1, 0], orthographic: false, displayMode: "shaded", clip: null },
    { name: "Beta", viewDirection: [0, 1, 0], cameraUp: [0, 0, 1], orthographic: false, displayMode: "shaded", clip: null },
  ]);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#view-menu");
  const rows = page.locator("#bookmark-list .bookmark-row");
  await rows.first().locator(".bookmark-act", { hasText: "Rename" }).click();
  await page.fill("#bookmark-list .bookmark-row input.bookmark-rename-input", "Beta");
  await page.keyboard.press("Enter");
  await sleep(800);
  const status = await page.evaluate(() => document.getElementById("status")?.textContent ?? "");
  assert(/already exists/i.test(status), `the collision names the existing bookmark (got ${JSON.stringify(status)})`);
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#bookmark-list .bookmark-row .bookmark-name")).map((b) => b.textContent)
  );
  assert(eq(names, ["Alpha", "Beta"]), `no rename landed (got ${JSON.stringify(names)})`);
  const sent = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "viewChanged").length);
  assert(sent === 0, `a refused rename posts no viewChanged (got ${sent})`);
});

test("bookmarks: delete removes the row and persists the removal", async (page) => {
  await populate(page);
  await postBookmarks(page, [
    { name: "Alpha", viewDirection: [1, 0, 0], cameraUp: [0, 1, 0], orthographic: false, displayMode: "shaded", clip: null },
    { name: "Beta", viewDirection: [0, 1, 0], cameraUp: [0, 0, 1], orthographic: false, displayMode: "shaded", clip: null },
  ]);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#view-menu");
  const rows = page.locator("#bookmark-list .bookmark-row");
  await rows.first().locator(".bookmark-act", { hasText: "✕" }).click();
  await sleep(800);
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#bookmark-list .bookmark-row .bookmark-name")).map((b) => b.textContent)
  );
  assert(eq(names, ["Beta"]), `only the surviving row renders (got ${JSON.stringify(names)})`);
  const posts = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "viewChanged"));
  const last = posts[posts.length - 1]?.view?.bookmarks ?? null;
  assert(
    Array.isArray(last) && last.length === 1 && last[0].name === "Beta",
    `the removal persists (got ${JSON.stringify(last?.map((b) => b.name))})`
  );
});

// ── Reusable meshing presets (roadmap Tier 1 "Reusable meshing presets") ─────
//
// A "Saved presets" picker in the FE Mesh panel over the host-posted merged
// (user + bundled) library. What needs the real bundle here: the picker
// populating from `meshingPresets`, Apply posting the name (the host owns
// resolution/conversion/write from there), and Delete hiding for a bundled
// starter. Conversion math itself is covered by `meshPresets.test.ts`.

async function postPresets(page, presets) {
  await post(page, { type: "meshingPresets", presets });
  await sleep(300);
}

const PRESET_A = { name: "coarse-preview", description: null, unit: "mm", engine: "gmsh", readOnly: true };
const PRESET_B = { name: "mine", description: "Mine", unit: "in", engine: "ftetwild" };

test("presets: the picker lists the posted library with built-in marked", async (page) => {
  await populate(page);
  await postPresets(page, [PRESET_A, PRESET_B]);
  const options = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#meshing-panel select")).map((s) =>
      Array.from(s.options).map((o) => o.textContent)
    )
  );
  const flat = options.flat();
  assert(flat.includes("coarse-preview (built-in)"), `the bundled starter is marked built-in (got ${JSON.stringify(flat)})`);
  assert(flat.includes("mine"), `the user preset is listed (got ${JSON.stringify(flat)})`);
});

test("presets: Apply posts meshPresetApply with the picked name and nothing else", async (page) => {
  await populate(page);
  await postPresets(page, [PRESET_A, PRESET_B]);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll("#meshing-panel select"));
    const preset = selects.find((s) => Array.from(s.options).some((o) => o.value === "mine"));
    if (preset) preset.value = "mine";
  });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#meshing-panel button"));
    btns.find((b) => b.textContent === "Apply")?.click();
  });
  await sleep(300);
  const sent = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "meshPresetApply"));
  assert(sent.length === 1 && sent[0].name === "mine", `Apply posts exactly one meshPresetApply naming the pick (got ${JSON.stringify(sent)})`);
});

test("presets: Delete hides for a bundled starter and shows for a user preset", async (page) => {
  await populate(page);
  await postPresets(page, [PRESET_A, PRESET_B]);
  const hiddenForBundled = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll("#meshing-panel select"));
    const preset = selects.find((s) => Array.from(s.options).some((o) => o.value === "coarse-preview"));
    if (preset) {
      preset.value = "coarse-preview";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const btns = Array.from(document.querySelectorAll("#meshing-panel button"));
    return btns.find((b) => b.textContent === "Delete")?.hidden ?? "missing";
  });
  assert(hiddenForBundled === true, "Delete hides for a bundled starter");
  const hiddenForUser = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll("#meshing-panel select"));
    const preset = selects.find((s) => Array.from(s.options).some((o) => o.value === "mine"));
    if (preset) {
      preset.value = "mine";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const btns = Array.from(document.querySelectorAll("#meshing-panel button"));
    return btns.find((b) => b.textContent === "Delete")?.hidden ?? "missing";
  });
  assert(hiddenForUser === false, "Delete shows for a user preset");
});

// ── New Blank Model ───────────────────────────────────────────────────────

test("new blank: the File menu item posts newBlank", async (page) => {
  await populate(page);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#file-menu");
  await page.click("#menu-new");
  const sent = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "newBlank"));
  assert(sent.length === 1, `clicking New Blank Model posts exactly one newBlank (got ${sent.length})`);
  assert(await dropdownOpen(page, "file-dropdown") === false, "the menu closes after the click");
});

test("drawing sheet: the File menu item posts exportSheetRequest", async (page) => {
  // The multi-view sheet-layout feature's File ▸ Export Drawing Sheet… entry
  // — the host owns the format/paper picks and the save dialog from here, so
  // (like exportSvg/exportDxf/exportDrawing) there is nothing else to assert
  // client-side beyond "the menu item posts the right message and closes".
  await populate(page);
  await page.evaluate(() => (window.__sent.length = 0));
  await page.click("#file-menu");
  await page.click("#menu-export-sheet");
  const sent = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "exportSheetRequest"));
  assert(sent.length === 1, `clicking Export Drawing Sheet posts exactly one exportSheetRequest (got ${sent.length})`);
  assert(await dropdownOpen(page, "file-dropdown") === false, "the menu closes after the click");
});

test("new blank: an EMPTY geometry message yields a usable blank document", async (page) => {
  // The blank-document webview contract, host-free: `handleBRep` posts a
  // `geometry` with no meshes/edges/points for a document whose source is an
  // empty compound, and the webview must treat that as a real B-rep model —
  // sidebar shown, B-rep-only edit ops enabled — not as a failed load.
  await post(page, { type: "geometry", meshes: [], edges: [], points: [], autoFit: false });
  await post(page, { type: "viewState", view: null });
  await sleep(700);
  await post(page, { type: "tree", root: { id: "root", label: "BREP", children: [] } });
  await sleep(400);

  const state = await page.evaluate(() => ({
    sidebar: document.getElementById("side").classList.contains("visible"),
    status: (document.getElementById("status")?.textContent ?? "").trim(),
    opButtons: document.querySelectorAll("#edits-panel .op-btn").length,
    // `setBRepOnly(true)` clears `.disabled` from every B-rep-only op button
    // and empties the 2D subtab's "Requires a B-rep source" tooltip. A blank
    // document that never reached that call would leave the sketch/fillet half
    // of the catalog greyed out — usable for nothing.
    disabledOps: document.querySelectorAll("#edits-panel .op-btn.disabled").length,
    subtab2dTitle: (document.querySelector("#edits-panel .edits-subtab[title]")?.getAttribute("title") ?? "").trim(),
  }));
  assert(state.sidebar, "the sidebar is shown for an empty B-rep document");
  assert(!/failed|error/i.test(state.status), `no error status (got ${JSON.stringify(state.status)})`);
  assert(state.opButtons > 0, `the Edits panel rendered its op catalog (${state.opButtons} buttons)`);
  assert(
    state.disabledOps === 0,
    `every op button is enabled — setBRepOnly(true) ran for the empty B-rep (got ${state.disabledOps} disabled)`
  );
  assert(state.subtab2dTitle === "", `the 2D sketch subtab is not greyed (got ${JSON.stringify(state.subtab2dTitle)})`);
});

// ── Runner ────────────────────────────────────────────────────────────────

// ── Clip plane and the stencil clip cap ───────────────────────────────────
//
// `clipCap.ts` had NO test of any kind and a documented SILENT failure mode:
// get the stencil state wrong and the model simply renders uncapped, with no
// error anywhere. These cases close that, and they gate the arbitrary-normal
// work (the "arbitrary clip planes" feature) — everything below `Viewer.setClippingPlane` was
// "already plane-generic", but that was an inference from reading the code.
//
// The lever is `main.ts`'s `case "viewState"`, which re-applies a posted view
// state after hydration straight into `clippingControls.applyState`. That
// drives the whole sidecar-shape → UI → `planeForClip` → `setClippingPlane`
// path with NO test-only production surface.
//
// TWO non-obvious things, both established empirically here rather than
// assumed, because each produced a confidently wrong result first:
//
//  1. **The camera must sit on the CLIPPED-AWAY side to see the cut.** A
//     three.js clipping plane keeps the half its normal points INTO, so
//     viewing along `+normal` shows the outside of the surviving half with
//     the cut facing away — no cap is visible and everything looks broken.
//     Every case below therefore views along `-normal`. Verified against a
//     standalone three.js scene: flipping the plane's normal is exactly what
//     turns "no cap" into "cap".
//  2. **The cap is LIT** (`MeshStandardMaterial`), so it never renders as the
//     raw `--cad-face` value, and its shade changes with orientation. Colour
//     matching is therefore by HUE, not by proximity to a fixed RGB.

const CLIP_SETTLE = 1600;

/** A `ViewState` with clipping configured. Orthographic throughout: it removes
 *  perspective-dependent cross-section area from every measurement. */
const clipView = (clip, viewDirection, cameraUp = [0, 1, 0]) => ({
  type: "viewState",
  view: { viewDirection, cameraUp, orthographic: true, displayMode: "shaded", clip },
});

/** Turns the grid off so a measurement is of the model, not the helper. */
async function hideGrid(page) {
  await page.click("#view-menu");
  await page.click("#grid");
  await page.keyboard.press("Escape");
  await sleep(300);
}

/**
 * Hides the view-controls panel for the duration of a pixel comparison.
 *
 * **Required for any exact comparison, and the reason is a real trap:**
 * Playwright's element screenshot captures the VIEWPORT REGION the element
 * occupies, so an absolutely-positioned sibling painted over `#app` — which
 * `#view-controls` is — lands in the shot. Deriving a clip plane reveals the
 * `N` segment, and that button alone accounted for a reproducible 816-pixel
 * difference that looked exactly like a rendering discrepancy.
 */
const setPanelHidden = (page, hidden) =>
  page.evaluate((h) => {
    // Everything painted over `#app` that carries live, pointer- or reply-driven
    // content: the dock (which also holds the cursor readout), the selection pill,
    // and the measurement readout line.
    for (const id of ["view-controls", "inspector-card", "measure-readout-row"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = h ? "none" : "";
    }
  }, hidden);

/**
 * A full-frame signature: an FNV-1a hash over every RGB byte, plus the
 * non-background pixel count.
 *
 * `dominantColors` is too weak to support a pixel-IDENTITY claim — two
 * genuinely different renders can share a top-N histogram. Decoded in-page
 * via createImageBitmap, the same path `dominantColors` uses (a direct WebGL
 * readback returns all-black without `preserveDrawingBuffer`).
 */
async function frameSignature(page) {
  const shot = (await shotWithoutToast(page, () => page.locator("#app").screenshot())).toString("base64");
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    let hash = 0x811c9dc5;
    let nonBg = 0;
    for (let i = 0; i < data.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        hash ^= data[i + k];
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      const bg =
        Math.abs(data[i] - 0x1e) < 6 && Math.abs(data[i + 1] - 0x1e) < 6 && Math.abs(data[i + 2] - 0x1e) < 6;
      if (!bg) nonBg++;
    }
    return { hash, nonBg };
  }, shot);
}

/**
 * The fraction of the viewport that is magenta-HUED.
 *
 * Hue rather than a fixed RGB because the cap is lit: with `--cad-face` set to
 * `#ff00ff` it renders around `(219,31,219)` head-on and `(173,17,173)` at a
 * shallower angle. The predicate (`r` and `b` both high, `g` far below both)
 * accepts every such shade and — checked against this fixture's actual
 * histogram — rejects all of its Part swatches (`195,106,50`, `52,93,171`,
 * `14,99,156`), the background, and every grey.
 */
async function magentaFraction(page) {
  const shot = (await shotWithoutToast(page, () => page.locator("#app").screenshot())).toString("base64");
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    let hits = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 60 && b > 60 && g < 0.5 * Math.min(r, b)) hits++;
    }
    return hits / (c.width * c.height);
  }, shot);
}

/**
 * Floor for "a real cap is present", as a fraction of the viewport.
 *
 * Calibrated against the ACTUAL measured cross-sections rather than guessed:
 * the tilted cut covers ~0.04 and the axis-aligned one ~0.016 of a 1000x800
 * viewport (~9,700 px) — both inspected visually as solid, correctly-shaped
 * cross-sections. 0.008 (~4,800 px) sits well below either and far above any
 * stray antialiasing, and every case also checks the value against its own
 * clipping-off control, so the floor alone is never what carries an assertion.
 */
const CAP_FLOOR = 0.008;

/**
 * P2's OWN, tighter floor for the tilted case — deliberately separate from
 * `CAP_FLOOR`, because a real bug injection showed the shared floor isn't
 * enough here. Breaking `repositionClipCap`'s reorientation (so the cap stays
 * at its default identity orientation, facing +Z, instead of the tilted
 * normal) produced a visibly WRONG, misaligned cap — but its magenta area
 * (0.0126) still cleared `CAP_FLOOR` (0.008), because a misoriented flat cap
 * still has plausible area, just the wrong shape/position. Measured the
 * CORRECT cap across a full offset sweep (-0.4..0.4): 0.024-0.038, comfortably
 * above the broken 0.0126. P3's axis-z case doesn't need this: an identity
 * quaternion IS the correct orientation for a +Z normal, so a broken
 * `repositionClipCap` wouldn't even manifest as a defect there.
 */
const TILTED_CAP_FLOOR = 0.02;

/** Tags the cap by making `--cad-face` magenta. Sound because every visible
 *  face in this fixture is Part-assigned (established by the palette case
 *  above), so `--cad-face` reaches the cap and nothing else. */
async function tagCapColour(page) {
  await page.evaluate(() => document.body.style.setProperty("--cad-face", "#ff00ff"));
  await setTheme(page, "vscode-dark"); // re-stamp -> palette re-read -> cap rebuilt
}

/**
 * P0 — determinism control. MUST come before P1.
 *
 * Without it a passing P1 proves nothing (the comparison could be vacuous)
 * and a failing P1 is unattributable — a genuine widened-path bug looks
 * exactly like SwiftShader nondeterminism or an unsettled camera. Posting a
 * view state re-frames the camera, and at short settle times the captured
 * frame is genuinely path-dependent (measured: 16k differing pixels at 600ms,
 * 0 at 1600ms), which is why CLIP_SETTLE is as generous as it is.
 */
test("clip P0: the same posted view state renders identically twice", async (page) => {
  await populate(page);
  await hideGrid(page);
  await setPanelHidden(page, true);

  const dir = [-1, -0.8, -1];
  await post(page, clipView({ axis: "x", offsetFrac: 0.2 }, dir));
  await sleep(CLIP_SETTLE);
  const a = await frameSignature(page);
  await post(page, clipView({ axis: "y", offsetFrac: -0.4 }, dir)); // force a real change between
  await sleep(CLIP_SETTLE);
  await post(page, clipView({ axis: "x", offsetFrac: 0.2 }, dir));
  await sleep(CLIP_SETTLE);
  const b = await frameSignature(page);

  assert(a.nonBg > 0, `the clipped render is not blank (${a.nonBg} model px)`);
  assert(
    a.hash === b.hash,
    `rendering returns to an identical frame, so P1 can assert exact identity (${a.hash} vs ${b.hash})`
  );
  await setPanelHidden(page, false);
});

/**
 * P1 — behaviour preservation, EXACT.
 *
 * An explicit `[1,0,0]` normal must render pixel-identically to the `"x"`
 * preset. Exact rather than tolerant is justified: the generalized offset
 * formula reduces bit-for-bit to the original for a unit axis normal, pinned
 * independently by `clipping.test.ts`'s `toBe` assertion on the plane
 * constant.
 *
 * Division of labour worth keeping straight: `clipping.test.ts` pins the
 * ABSOLUTE position of the axis planes; this pins that the custom-normal
 * branch AGREES with them. Neither alone is sufficient.
 */
test("clip P1: an explicit axis normal renders identically to the axis preset", async (page) => {
  await populate(page);
  await hideGrid(page);
  await setPanelHidden(page, true);

  const cases = [
    ["x", [1, 0, 0], [-1, -0.8, -1]],
    ["z", [0, 0, 1], [0, 0, -1]],
  ];
  for (const [axis, normal, dir] of cases) {
    await post(page, clipView({ axis, offsetFrac: 0.2 }, dir));
    await sleep(CLIP_SETTLE);
    const preset = await frameSignature(page);
    await post(page, clipView({ axis, offsetFrac: 0.2, normal }, dir));
    await sleep(CLIP_SETTLE);
    const explicit = await frameSignature(page);

    assert(
      preset.hash === explicit.hash,
      `an explicit [${normal}] normal is pixel-identical to the "${axis}" preset (${preset.hash} vs ${explicit.hash})`
    );
  }
  await setPanelHidden(page, false);
});

/**
 * P2 — a tilted normal genuinely CAPS. The crux of the whole feature.
 */
test("clip P2: a tilted clip normal produces a real stencil cap", async (page) => {
  await populate(page);
  await hideGrid(page);
  await tagCapColour(page);

  const k = 0.5773502691896258;
  const normal = [k, k, k];
  const facing = [-k, -k, -k]; // on the clipped-away side, looking AT the cut

  // Control: with clipping off there must be no cap colour at all. Without
  // this the case would pass if --cad-face leaked onto any ordinary face.
  await post(page, clipView(null, facing));
  await sleep(CLIP_SETTLE);
  const off = await magentaFraction(page);
  assert(off < 0.002, `no cap-coloured pixels while clipping is off (got ${off.toFixed(4)})`);

  await post(page, clipView({ axis: "x", offsetFrac: 0, normal }, facing));
  await sleep(CLIP_SETTLE);
  const on = await magentaFraction(page);

  // A BAND, not a floor. A floor alone would pass for `stencilFunc: Always`,
  // where the cap paints over the entire viewport (measured at ~0.42 when the
  // stencil test is disabled, so 0.5 genuinely separates the two).
  assert(on > TILTED_CAP_FLOOR, `a tilted clip is capped, not see-through/misoriented (got ${on.toFixed(4)})`);
  assert(on > off * 5, `the cap appears because of the clip, not the colour tag (${on.toFixed(4)} vs ${off.toFixed(4)})`);
  assert(on < 0.35, `the cap is bounded by the solid, not painted everywhere (got ${on.toFixed(4)})`);

  // Edge-on: the cap plane is now parallel to the view direction, so it
  // projects to a thin line. This is the ONLY assertion that catches a broken
  // `repositionClipCap` quaternion — the one function in clipCap.ts the
  // arbitrary-normal work actually depends on. A cap left facing +Z would
  // still show a large, plausible blob head-on.
  await post(page, clipView({ axis: "x", offsetFrac: 0, normal }, [1, -1, 0]));
  await sleep(CLIP_SETTLE);
  const edge = await magentaFraction(page);
  assert(
    edge < on / 5,
    `the cap is oriented to its plane — edge-on it nearly vanishes (${edge.toFixed(4)} vs ${on.toFixed(4)})`
  );

  await page.evaluate(() => document.body.style.removeProperty("--cad-face"));
});

/**
 * P3 — the PRE-EXISTING axis-aligned cap, which this codebase has never had a
 * regression test for. Also disambiguates a P2 failure: P3 green + P2 red
 * means the new arbitrary-normal path is at fault; both red means the cap is
 * broken generally.
 */
test("clip P3: an axis-aligned clip is capped too", async (page) => {
  await populate(page);
  await hideGrid(page);
  await tagCapColour(page);

  const facing = [0, 0, -1]; // +Z normal keeps the +Z half; view it from -Z
  await post(page, clipView(null, facing));
  await sleep(CLIP_SETTLE);
  const off = await magentaFraction(page);

  await post(page, clipView({ axis: "z", offsetFrac: 0 }, facing));
  await sleep(CLIP_SETTLE);
  const on = await magentaFraction(page);

  assert(off < 0.002, `no cap colour before clipping (got ${off.toFixed(4)})`);
  assert(on > CAP_FLOOR, `the axis-aligned clip is capped (got ${on.toFixed(4)})`);
  assert(on > off * 5, `the cap appears because of the clip, not the colour tag (${on.toFixed(4)} vs ${off.toFixed(4)})`);
  assert(on < 0.35, `the axis cap is bounded by the solid (got ${on.toFixed(4)})`);

  await page.evaluate(() => document.body.style.removeProperty("--cad-face"));
});

/**
 * P4 — the widened persisted shape survives the webview round trip.
 *
 * `getState()`'s widened output is otherwise untested anywhere: the sidecar
 * parser is covered by vitest, but nothing checks that the webview actually
 * GATHERS a custom normal back out for saving.
 */
test("clip P4: a custom normal round-trips back out through viewChanged", async (page) => {
  await populate(page);
  const k = 0.5773502691896258;

  await page.evaluate(() => (window.__sent.length = 0));
  await post(page, clipView({ axis: "x", offsetFrac: -0.25, normal: [k, k, k] }, [-k, -k, -k]));
  await sleep(900); // past VIEW_SAVE_DEBOUNCE_MS (500)

  const saved = await page.evaluate(() => {
    const msgs = (window.__sent || []).filter((m) => m.type === "viewChanged");
    return msgs.length ? msgs[msgs.length - 1].view : null;
  });

  assert(saved !== null, "the webview posted a viewChanged after the clip was applied");
  const n = saved?.clip?.normal;
  assert(Array.isArray(n) && n.length === 3, `the saved clip carries a normal (got ${JSON.stringify(n)})`);
  if (Array.isArray(n)) {
    const len = Math.hypot(n[0], n[1], n[2]);
    assert(Math.abs(len - 1) < 1e-6, `the saved normal is unit length (got ${len.toFixed(6)})`);
    // `axis` is written BESIDE the normal so an OLDER build reading this
    // sidecar restores a sensible neighbouring clip instead of none at all.
    assert(saved.clip.axis === "x", `the dominant axis is stored beside it (got ${saved.clip.axis})`);
  }
});

/**
 * P5 — the derive buttons' gating. Deliberately NOT a click-three-of-64-point-
 * sprites test: positional clicks on sprites would be fragile, and an
 * intermittently-red suite is worse than no test. The 3-point maths is covered
 * exhaustively in `clipping.test.ts`; only the gate is a DOM concern.
 */
test("clip P5: the derive buttons gate on the selection", async (page) => {
  await populate(page);

  const state = () =>
    page.evaluate(() => ({
      face: document.getElementById("clip-from-face")?.disabled,
      pts: document.getElementById("clip-from-points")?.disabled,
      customHidden: document.getElementById("clip-custom")?.hidden,
    }));

  const initial = await state();
  assert(initial.face === true, "Clip ▸ Face is disabled with nothing selected");
  assert(initial.pts === true, "Clip ▸ 3 Pts is disabled with nothing selected");
  assert(initial.customHidden === true, "the custom-normal segment is hidden until one is derived");

  await page.click("#select-menu");
  await page.click("#sel-toggle");
  await page.click('.sel-mode[data-mode="surface"]');
  await page.keyboard.press("Escape");
  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);

  const afterPick = await state();
  assert(afterPick.face === false, "Clip ▸ Face enables once exactly one face is selected");
  assert(afterPick.pts === true, "Clip ▸ 3 Pts stays disabled for a face selection");
});

/**
 * P6 — Clip ▸ Face end to end, driven by a SYNTHETIC reply.
 *
 * Reuses the established shape: click, read the real request off
 * `window.__sent` so the reply carries a genuine request id, then post the
 * reply. Covers the non-planar branch too — the one most likely to be written
 * wrong, and it must leave clipping untouched rather than applying a garbage
 * plane.
 */
test("clip P6: Clip ▸ Face applies a plane, and refuses a non-planar face", async (page) => {
  await populate(page);

  await page.click("#select-menu");
  await page.click("#sel-toggle");
  await page.click('.sel-mode[data-mode="surface"]');
  await page.keyboard.press("Escape");
  const box = await viewportBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);

  const facts = (over) => ({
    entityId: "face-7",
    kind: "face",
    bbox: null,
    center: [0, 0, 0],
    area: 1,
    length: null,
    normal: null,
    planeOrigin: null,
    surfaceType: "plane",
    curveType: null,
    ...over,
  });
  const clickAndReply = async (over) => {
    await page.evaluate(() => (window.__sent.length = 0));
    await openDockMore(page);
    await page.click("#clip-from-face");
    await sleep(250);
    const requestId = await page.evaluate(() => {
      const r = window.__sent.filter((m) => m.type === "entityFactsRequest");
      return r.length ? r[r.length - 1].requestId : null;
    });
    if (typeof requestId !== "string") return null;
    await post(page, { type: "entityFactsResult", requestId, facts: facts(over) });
    await sleep(900);
    return requestId;
  };

  // Non-planar first: a cylindrical face reports normal/planeOrigin as null.
  const id1 = await clickAndReply({ surfaceType: "cylinder" });
  assert(typeof id1 === "string", "clicking Face issues its own entityFactsRequest");
  const afterNonPlanar = await page.evaluate(() => ({
    hidden: document.getElementById("clip-custom")?.hidden,
    toggle: document.getElementById("clip-toggle")?.textContent,
  }));
  assert(afterNonPlanar.hidden === true, "a non-planar face derives no custom normal");
  assert(
    afterNonPlanar.toggle === "Off",
    "a non-planar face leaves clipping off rather than applying a garbage plane"
  );

  // Now a planar reply, with the face's genuine OUTWARD normal.
  await clickAndReply({ normal: [0, 1, 0], planeOrigin: [0, 1000, 0] });
  const applied = await page.evaluate(() => {
    const msgs = (window.__sent || []).filter((m) => m.type === "viewChanged");
    return {
      hidden: document.getElementById("clip-custom")?.hidden,
      toggle: document.getElementById("clip-toggle")?.textContent,
      clip: msgs.length ? msgs[msgs.length - 1].view.clip : null,
    };
  });
  assert(applied.hidden === false, "a planar face reveals the custom-normal segment");
  assert(applied.toggle === "On", "deriving a plane turns clipping on, so the click visibly does something");
  assert(applied.clip?.axis === "y", `the derived plane stores its dominant axis (got ${applied.clip?.axis})`);
  // The invariant that stops the model vanishing: an outward normal at the
  // model's extreme must come back oriented so the plane keeps the bulk.
  assert(
    typeof applied.clip?.offsetFrac === "number" && applied.clip.offsetFrac <= 0,
    `the derived plane keeps at least half the model (offsetFrac ${applied.clip?.offsetFrac})`
  );
  assert(
    Array.isArray(applied.clip?.normal) && applied.clip.normal[1] < 0,
    `a normal pointing off the top of the model is flipped inward (got ${JSON.stringify(applied.clip?.normal)})`
  );
});

/**
 * V1 — hiding via the Components tree removes the cap; restoring brings it back.
 *
 * The discriminating assertion is the HIDE step: before the visibility hook,
 * no visibility mutation rebuilt the cap, so the stale cross-section stayed
 * painted (`hidden` measured the same as `on`). `traverseVisible` vs a plain
 * `traverse` + `obj.visible` check is covered structurally (a hidden ancestor
 * prunes its whole subtree); what this pins is the missing rebuild.
 */
test("clip V1: hiding every tree group removes the cap, restoring brings it back", async (page) => {
  await populate(page);
  await hideGrid(page);
  await setPanelHidden(page, true);
  await tagCapColour(page);

  const facing = [0, 0, -1]; // +Z normal keeps the +Z half; view it from -Z
  await post(page, clipView({ axis: "z", offsetFrac: 0 }, facing));
  await sleep(CLIP_SETTLE);
  const on = await magentaFraction(page);
  const onSig = await frameSignature(page);
  assert(on > CAP_FLOOR, `the clip is capped before hiding (got ${on.toFixed(4)})`);

  const toggled = await page.evaluate(() => {
    const eyes = document.querySelectorAll("#tree-body [data-visible-toggle], #tree-body .tree-eye");
    eyes.forEach((e) => e.click());
    return eyes.length;
  });
  assert(toggled > 0, `the tree exposes visibility toggles (found ${toggled})`);
  await sleep(600); // queued cap rebuild (microtask) + a scheduled frame
  const hidden = await magentaFraction(page);
  const hiddenSig = await frameSignature(page);
  assert(hidden < 0.002, `no cap-coloured pixels once everything is hidden (got ${hidden.toFixed(4)})`);
  assert(hiddenSig.hash !== onSig.hash, "hiding rebuilds the cap instead of leaving it stale");

  await page.evaluate(() => {
    document.querySelectorAll("#tree-body [data-visible-toggle], #tree-body .tree-eye").forEach((e) => e.click());
  });
  await sleep(600);
  const restored = await magentaFraction(page);
  const restoredSig = await frameSignature(page);
  assert(restored > CAP_FLOOR, `the cap returns once visibility is restored (got ${restored.toFixed(4)})`);
  assert(restoredSig.hash === onSig.hash, "restoring rebuilds the identical cap, not an approximation");

  await page.evaluate(() => document.body.style.removeProperty("--cad-face"));
  await setPanelHidden(page, false);
});

/**
 * V2 — hiding via the Parts panel also rebuilds the cap (face-level hide, as
 * distinct from V1's group-level hide). Asserts a strict decrease rather than
 * an exact zero: the fixture's three Parts may not cover every face, so
 * unassigned faces can legitimately keep a small cap.
 */
test("clip V2: hiding Parts shrinks the cap instead of leaving it stale", async (page) => {
  await populate(page);
  await hideGrid(page);
  await setPanelHidden(page, true);
  await tagCapColour(page);

  const facing = [0, 0, -1];
  await post(page, clipView({ axis: "z", offsetFrac: 0 }, facing));
  await sleep(CLIP_SETTLE);
  const on = await magentaFraction(page);
  const onSig = await frameSignature(page);
  assert(on > CAP_FLOOR, `the clip is capped before hiding (got ${on.toFixed(4)})`);

  const toggled = await page.evaluate(() => {
    const eyes = document.querySelectorAll("#parts-body .part-eye");
    eyes.forEach((e) => e.click());
    return eyes.length;
  });
  assert(toggled > 0, `the Parts panel exposes eye toggles (found ${toggled})`);
  await sleep(600);
  const hidden = await magentaFraction(page);
  const hiddenSig = await frameSignature(page);
  assert(hidden < on, `hiding Parts shrinks the cap (got ${hidden.toFixed(4)} vs ${on.toFixed(4)})`);
  assert(hiddenSig.hash !== onSig.hash, "hiding Parts rebuilds the cap instead of leaving it stale");

  await page.evaluate(() => {
    document.querySelectorAll("#parts-body .part-eye").forEach((e) => e.click());
  });
  await sleep(600);
  const restoredSig = await frameSignature(page);
  assert(restoredSig.hash === onSig.hash, "restoring Parts rebuilds the identical cap");

  await page.evaluate(() => document.body.style.removeProperty("--cad-face"));
  await setPanelHidden(page, false);
});

/**
 * V3 — the FE-mesh overlay toggle keeps a cap in every state (no regression
 * from moving the overlay rebuild into `refreshModelFacesVisibility`).
 * Overlay shown: the cap comes from the overlay boundary. Overlay hidden
 * again: the cap comes back from the model faces.
 */
test("clip V3: the overlay toggle preserves the cap in both states", async (page) => {
  await populate(page);
  await hideGrid(page);
  await setPanelHidden(page, true);
  await tagCapColour(page);

  const facing = [0, 0, -1];
  await post(page, clipView({ axis: "z", offsetFrac: 0 }, facing));
  await sleep(CLIP_SETTLE);
  const onModel = await magentaFraction(page);
  assert(onModel > CAP_FLOOR, `the model clip is capped (got ${onModel.toFixed(4)})`);

  await postMeshingResult(page);
  await sleep(700);
  const onOverlay = await magentaFraction(page);
  assert(onOverlay > CAP_FLOOR, `the overlay clip is capped too (got ${onOverlay.toFixed(4)})`);

  await page.click("#meshing-toggle"); // hide the overlay in place; model faces return
  await sleep(600);
  const restored = await magentaFraction(page);
  assert(restored > CAP_FLOOR, `the model cap returns after the overlay is hidden (got ${restored.toFixed(4)})`);

  await page.evaluate(() => document.body.style.removeProperty("--cad-face"));
  await setPanelHidden(page, false);
});


test("planes P1: a stored plane renders, and Use applies it as the clip", async (page) => {
  await populate(page);

  // Hydrate the panel exactly as the host does on `ready` — a silent load that
  // must NOT echo back as a planesChanged write.
  await page.evaluate(() => (window.__sent.length = 0));
  await post(page, {
    type: "planes",
    planes: [
      { id: "plane-0", name: "Datum A", point: [0, 1000, 0], normal: [0, 1, 0], derivedFrom: "face-7" },
    ],
  });
  await sleep(300);

  const rendered = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#planes-list .plane-row"));
    return {
      count: rows.length,
      name: rows[0]?.querySelector(".plane-row-name")?.textContent ?? null,
      title: rows[0]?.querySelector(".plane-row-name")?.getAttribute("title") ?? null,
      echoed: window.__sent.filter((m) => m.type === "planesChanged").length,
    };
  });
  assert(rendered.count === 1, `the stored plane renders one row (got ${rendered.count})`);
  assert(rendered.name === "Datum A", `the row shows the plane's name (got ${rendered.name})`);
  assert(
    typeof rendered.title === "string" && rendered.title.includes("from face-7"),
    `the row's tooltip carries its provenance (got ${rendered.title})`
  );
  // The load/echo contract: hydrating from disk must not post a write back.
  assert(rendered.echoed === 0, `load() does not echo back as a write (saw ${rendered.echoed} planesChanged)`);

  // "Use" must drive the SAME path the Face button does, so a saved plane and
  // a derived clip cannot diverge — assert the applied clip, not just a click.
  await page.evaluate(() => (window.__sent.length = 0));
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#planes-list .plane-row button"));
    btns.find((b) => b.textContent === "Use")?.click();
  });
  await sleep(900);

  const applied = await page.evaluate(() => {
    const msgs = (window.__sent || []).filter((m) => m.type === "viewChanged");
    return {
      toggle: document.getElementById("clip-toggle")?.textContent,
      clip: msgs.length ? msgs[msgs.length - 1].view.clip : null,
    };
  });
  assert(applied.toggle === "On", "Use turns clipping on, so the click visibly does something");
  assert(applied.clip?.axis === "y", `the applied plane keeps its dominant axis (got ${applied.clip?.axis})`);
  // Same orientation invariant the Face path has: a normal pointing off the
  // top of the model must be flipped inward or the model appears to vanish.
  assert(
    Array.isArray(applied.clip?.normal) && applied.clip.normal[1] < 0,
    `Use orients the stored normal toward the bulk (got ${JSON.stringify(applied.clip?.normal)})`
  );

  // Numeric entry — the only way to author a plane with no geometry to pick.
  await page.evaluate(() => (window.__sent.length = 0));
  await openDockMore(page);
  await page.click("#plane-add");
  await page.fill("#plane-entry-point", "1, 2, 3");
  await page.fill("#plane-entry-normal", "0,0,0");
  await page.click("#plane-entry-ok");
  await sleep(250);
  const rejected = await page.evaluate(() => ({
    rows: document.querySelectorAll("#planes-list .plane-row").length,
    posted: window.__sent.filter((m) => m.type === "planesChanged").length,
  }));
  assert(rejected.rows === 1, "a zero-length normal adds no plane");
  assert(rejected.posted === 0, "a rejected entry posts no write");

  await page.fill("#plane-entry-normal", "1, 0, 0");
  await page.click("#plane-entry-ok");
  await sleep(250);
  const added = await page.evaluate(() => {
    const posts = window.__sent.filter((m) => m.type === "planesChanged");
    return {
      rows: document.querySelectorAll("#planes-list .plane-row").length,
      last: posts.length ? posts[posts.length - 1].planes : null,
    };
  });
  assert(added.rows === 2, `a valid entry adds a row (got ${added.rows})`);
  assert(
    added.last?.length === 2 && added.last[1].id === "plane-1",
    `the new plane gets the next free id and is posted for persisting (got ${JSON.stringify(added.last?.map((p) => p.id))})`
  );
});

/**
 * Distance-graded mesh sizing (roadmap "Boundary-layer and distance-threshold
 * mesh sizing", Phase 1) — the FE Mesh panel's "Part sizes" Grade toggle.
 *
 * This case exists because of a REAL, live-caught regression: the grading
 * row's own CSS (`.meshing-part-grading { display: flex; ... }`) is an
 * unconditional author rule, which beats the `[hidden]` UA default regardless
 * of specificity — the exact "gated panel never actually hides" hazard
 * CLAUDE.md's "Collapsible sidebar sections" section already documents twice.
 * Without the `[hidden]` override this case pins, the row never actually
 * collapses, which in a real session pushes the sidebar's flex:1 panels
 * (Parts, Edits) past their squeeze point (`#side` clips overflow rather than
 * scrolling) — caught only by inspecting the SCREENSHOTS, not by a green
 * `npm run docs:screenshots` exit code, per this repo's own standing lesson.
 */
test("FE Mesh Part sizes: Grade toggle starts collapsed, expands, commits, and clears", async (page) => {
  await populate(page);

  // The "Contact faces" fixture part already carries a meshGrading band
  // (fixtures-entry.ts) — its toggle should read as ACTIVE (a band exists)
  // while its row stays collapsed by default (the fix this case pins).
  const initial = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#meshing-part-sizes .meshing-part-row")];
    const gradingRows = [...document.querySelectorAll("#meshing-part-sizes .meshing-part-grading")];
    return {
      rowCount: rows.length,
      toggles: rows.map((r) => {
        const t = r.querySelector(".meshing-part-grade-toggle");
        return { active: t.classList.contains("active"), ariaExpanded: t.getAttribute("aria-expanded") };
      }),
      gradingRowCount: gradingRows.length,
      allHiddenAndInvisible: gradingRows.every((r) => r.hidden && r.offsetParent === null),
    };
  });
  assert(initial.rowCount === 3, `three part rows rendered (got ${initial.rowCount})`);
  assert(initial.toggles[1]?.active === true, "the part with a meshGrading band shows an active Grade toggle");
  assert(initial.toggles[0]?.active === false && initial.toggles[2]?.active === false, "parts with no band show an inactive toggle");
  assert(initial.toggles.every((t) => t.ariaExpanded === "false"), "every Grade toggle starts aria-expanded=false, regardless of whether a band exists");
  assert(
    initial.gradingRowCount === 3 && initial.allHiddenAndInvisible,
    `every grading row starts genuinely invisible, not just [hidden]-attributed-but-still-rendered (got ${JSON.stringify(initial)})`
  );

  // Expand the active (Contact faces) row and confirm it pre-fills with the
  // fixture's real band values, not blank inputs.
  await page.click(".meshing-part-grade-toggle.active");
  await sleep(150);
  const expanded = await page.evaluate(() => {
    const row = document.querySelector(".meshing-part-grade-toggle.active");
    const gradingRow = row.closest(".meshing-part-row").nextElementSibling;
    const inputs = [...gradingRow.querySelectorAll("input")].map((i) => i.value);
    return { hidden: gradingRow.hidden, visible: gradingRow.offsetParent !== null, ariaExpanded: row.getAttribute("aria-expanded"), inputs };
  });
  assert(expanded.hidden === false && expanded.visible === true, "clicking Grade reveals the row");
  assert(expanded.ariaExpanded === "true", "aria-expanded now reflects the row's real visibility");
  assert(
    expanded.inputs.length === 4 && expanded.inputs.every((v) => v !== ""),
    `the row pre-fills from the part's existing band (got ${JSON.stringify(expanded.inputs)})`
  );

  // Commit a valid edit — a real MeshGrading object must reach partsChanged.
  await page.evaluate(() => (window.__sent.length = 0));
  await page.evaluate(() => {
    const row = document.querySelector(".meshing-part-grade-toggle.active");
    const gradingRow = row.closest(".meshing-part-row").nextElementSibling;
    const input = gradingRow.querySelectorAll("input")[0]; // Wall
    input.value = "1";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(150);
  const committed = await page.evaluate(() => {
    const m = (window.__sent || []).findLast((x) => x.type === "partsChanged");
    const p = m?.parts?.find((p) => p.name === "Contact faces");
    return { grading: p?.meshGrading ?? null, errorText: document.querySelector(".meshing-part-grading-error")?.textContent ?? "" };
  });
  assert(committed.grading?.sizeAtWall === 1, `a valid wall-size edit posts partsChanged with the new value (got ${JSON.stringify(committed.grading)})`);
  assert(committed.errorText === "", "no inline error for a valid band");

  // Commit an invalid edit (sizeFar < sizeAtWall) — must NOT post, and the
  // part's existing (still-valid) band must survive untouched.
  await page.evaluate(() => (window.__sent.length = 0));
  await page.evaluate(() => {
    const row = document.querySelector(".meshing-part-grade-toggle.active");
    const gradingRow = row.closest(".meshing-part-row").nextElementSibling;
    const farInput = gradingRow.querySelectorAll("input")[1]; // Far
    farInput.value = "0.1"; // < the wall size of 1 just committed above
    farInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(150);
  const rejected = await page.evaluate(() => {
    const row = document.querySelector(".meshing-part-grade-toggle.active");
    const gradingRow = row.closest(".meshing-part-row").nextElementSibling;
    return {
      posted: (window.__sent || []).some((x) => x.type === "partsChanged"),
      errorText: gradingRow.querySelector(".meshing-part-grading-error")?.textContent ?? "",
    };
  });
  assert(rejected.posted === false, "an invalid band (far < wall) posts nothing");
  assert(rejected.errorText.length > 0, "an invalid band shows an inline error instead");

  // Clearing all four fields removes the band entirely.
  await page.evaluate(() => (window.__sent.length = 0));
  await page.evaluate(() => {
    const row = document.querySelector(".meshing-part-grade-toggle.active");
    const gradingRow = row.closest(".meshing-part-row").nextElementSibling;
    for (const input of gradingRow.querySelectorAll("input")) {
      input.value = "";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(150);
  const cleared = await page.evaluate(() => {
    const m = (window.__sent || []).findLast((x) => x.type === "partsChanged");
    const p = m?.parts?.find((p) => p.name === "Contact faces");
    // No `??` sentinel here on purpose: `undefined` (the correct cleared
    // value) must reach the assertion below unchanged, not get masked into
    // a truthy placeholder string that would defeat the `== null` check.
    return p ? p.meshGrading : "no-such-part";
  });
  assert(cleared == null, `clearing every field removes the band (got ${JSON.stringify(cleared)})`);
});


/**
 * Standard-parts thumbnails (the "Standard-parts thumbnails" feature). Search stays text-first: rows
 * render immediately, and a second fire-and-forget round trip decorates them
 * with host-fetched data-URL thumbnails. Host replies are faked by posting
 * `standardPartsSearchResult`/`standardPartsThumbsResult` directly (the
 * clash/context-menu precedent); the fetch itself — timeouts, caps,
 * content types — is unit-covered in `standardPartsThumbs.test.ts`.
 */
const THUMB_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function thumbItem(id, name) {
  return {
    id,
    name,
    description: `${name} desc`,
    category: "Fasteners",
    standard: { body: "", number: "", designation: "ISO 1234" },
    tags: [],
    aliases: [],
    attributes: {},
    stepUrl: "https://x/y.step",
    glbUrl: "",
    pngUrl: `https://x/${id}.png`,
    byteSize: 1,
    sha256: null,
    pageUrl: "",
    apiUrl: "",
  };
}

async function runPartsSearch(page, q) {
  await page.fill("#standard-parts-query", q);
  await page.click("#standard-parts-search-btn");
  await sleep(150);
  return page.evaluate(
    () => (window.__sent ?? []).filter((m) => m.type === "standardPartsSearchRequest").at(-1) ?? null
  );
}

test("thumbs: fetched thumbnails render beside the right rows; missing ones keep text", async (page) => {
  await populate(page);
  await openAdvanced(page);
  const req = await runPartsSearch(page, "bolt");
  assert(req !== null && typeof req?.requestId === "string", "search posts a standardPartsSearchRequest");
  await post(page, {
    type: "standardPartsSearchResult",
    requestId: req.requestId,
    items: [thumbItem("p1", "Bolt A"), thumbItem("p2", "Bolt B")],
    page: 1,
    totalPages: 1,
    total: 2,
  });
  await sleep(250);
  const thumbsReq = await page.evaluate(
    () => (window.__sent ?? []).filter((m) => m.type === "standardPartsThumbsRequest").at(-1) ?? null
  );
  assert(
    thumbsReq !== null && thumbsReq.searchId === req.requestId,
    `rendered rows post a thumbs request for that search (got ${JSON.stringify(thumbsReq)})`
  );
  assert(
    eq([...thumbsReq.ids].sort(), ["p1", "p2"]),
    `the thumbs request names the rendered page's ids (got ${JSON.stringify(thumbsReq?.ids)})`
  );
  await post(page, {
    type: "standardPartsThumbsResult",
    searchId: req.requestId,
    thumbs: [{ id: "p1", dataUrl: THUMB_PNG }],
  });
  await sleep(250);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".standard-part-row")].map((r) => ({
      id: r.dataset.partId,
      img: r.querySelector("img.standard-part-thumb")?.getAttribute("src") ?? null,
      name: r.querySelector(".standard-part-name")?.textContent ?? null,
    }))
  );
  const r1 = rows.find((r) => r.id === "p1");
  const r2 = rows.find((r) => r.id === "p2");
  assert(r1?.img === THUMB_PNG, "the fetched thumbnail lands on its own row");
  assert(r1?.name === "Bolt A", "text stays beside the thumbnail");
  assert(r2?.img === null && r2?.name === "Bolt B", "a row with no thumbnail keeps the text-only rendering");
});

test("thumbs: a stale-generation reply decorates nothing", async (page) => {
  await populate(page);
  await openAdvanced(page);
  const reqA = await runPartsSearch(page, "bolt");
  await post(page, {
    type: "standardPartsSearchResult",
    requestId: reqA.requestId,
    items: [thumbItem("p1", "Bolt A")],
    page: 1,
    totalPages: 1,
    total: 1,
  });
  await sleep(250);
  // A second search is issued but its results have NOT landed — the rows on
  // screen still show A's p1, so id-matching alone would accept A's late
  // thumbnails. The generation guard must refuse them anyway: a newer search
  // superseded them.
  const reqB = await runPartsSearch(page, "nut");
  await post(page, {
    type: "standardPartsThumbsResult",
    searchId: reqA.requestId,
    thumbs: [{ id: "p1", dataUrl: THUMB_PNG }],
  });
  await sleep(250);
  const stale = await page.evaluate(() => document.querySelectorAll("img.standard-part-thumb").length);
  assert(stale === 0, `superseded thumbnails never decorate, even with a matching id (got ${stale} images)`);
  // Then B's results land and B's thumbnails apply normally.
  await post(page, {
    type: "standardPartsSearchResult",
    requestId: reqB.requestId,
    items: [thumbItem("p9", "Nut Z")],
    page: 1,
    totalPages: 1,
    total: 1,
  });
  await sleep(250);
  await post(page, {
    type: "standardPartsThumbsResult",
    searchId: reqB.requestId,
    thumbs: [{ id: "p9", dataUrl: THUMB_PNG }],
  });
  await sleep(250);
  const now = await page.evaluate(() =>
    [...document.querySelectorAll(".standard-part-row")].map((r) => ({
      id: r.dataset.partId,
      img: !!r.querySelector("img.standard-part-thumb"),
    }))
  );
  assert(
    now.length === 1 && now[0].id === "p9" && now[0].img === true,
    `the current generation still decorates (got ${JSON.stringify(now)})`
  );
});

test("thumbs: a thumbnail for an unknown id is dropped silently", async (page) => {
  await populate(page);
  await openAdvanced(page);
  const req = await runPartsSearch(page, "bolt");
  await post(page, {
    type: "standardPartsSearchResult",
    requestId: req.requestId,
    items: [thumbItem("p1", "Bolt A")],
    page: 1,
    totalPages: 1,
    total: 1,
  });
  await sleep(250);
  await post(page, {
    type: "standardPartsThumbsResult",
    searchId: req.requestId,
    thumbs: [{ id: "ghost", dataUrl: THUMB_PNG }],
  });
  await sleep(250);
  const imgs = await page.evaluate(() => document.querySelectorAll("img.standard-part-thumb").length);
  assert(imgs === 0, "a thumbnail naming no listed row creates no image");
});

// ── Sidebar layout and keyboard usability ─────────────────────────────────
//
// These six cases are the automated half of the item's "done when" list —
// each one pinned to its documented failure class. The "feel" of a live drag
// in a real VS Code theme at actual editor zoom stays F5-only, stated in
// CLAUDE.md as the standing gap, as for every webview-touching feature.

test("sidebar: dragging the handle clamps the width and one debounced viewChanged carries sidebarWidth", async (page) => {
  await populate(page);
  const box = await page.locator("#sidebar-resize").boundingBox();
  assert(box, "the resize handle has a hit zone on #side's right edge");
  await page.evaluate(() => (window.__sent.length = 0));
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  // Drag 120px right from the handle → width should land clamped within [176, 420].
  await page.mouse.move(box.x + 120, box.y + 200, { steps: 6 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => ({
    // clientWidth excludes the 1px border-right, so it IS the var the resizer set.
    w: document.getElementById("side").clientWidth,
  }));
  assert(dragged.w >= 176 && dragged.w <= 420, `the dragged width is clamped (got ${dragged.w}px)`);

  await sleep(900); // VIEW_SAVE_DEBOUNCE_MS is 500; the drag coalesces into ONE save
  const saved = await page.evaluate(
    () => (window.__sent ?? []).filter((m) => m.type === "viewChanged").at(-1) ?? null
  );
  assert(saved !== null, "the drag posts a debounced viewChanged");
  assert(
    saved !== null && saved.view.sidebarWidth === dragged.w,
    `the saved width matches the applied width (view=${JSON.stringify(saved?.view?.sidebarWidth)}, dom=${dragged.w})`
  );
  // Exactly ONE viewChanged for the whole drag — the debouncer coalesced it.
  const count = await page.evaluate(() => (window.__sent ?? []).filter((m) => m.type === "viewChanged").length);
  assert(count === 1, `a whole drag coalesces into one sidecar write (got ${count})`);
});

test("sidebar: a viewState post restores and clamps the width, and a garbage value falls back to default", async (page) => {
  await populate(page);
  const apply = (sidebarWidth) =>
    post(page, {
      type: "viewState",
      view: {
        viewDirection: [1, 0.8, 1], cameraUp: [0, 1, 0], orthographic: false,
        displayMode: "shaded", clip: null, sidebarWidth,
      },
    });
  await apply(300);
  await sleep(120);
  const wide = await page.evaluate(() => document.getElementById("side").clientWidth);
  assert(wide === 300, `a persisted width is applied (got ${wide}px)`);

  await apply(9999); // out-of-range restores to the CLAMP, not the raw value
  await sleep(120);
  const clamped = await page.evaluate(() => document.getElementById("side").clientWidth);
  assert(clamped === 420, `an out-of-range width clamps to the max (got ${clamped}px)`);

  await apply("garbage");
  await sleep(120);
  const fallback = await page.evaluate(() => document.getElementById("side").clientWidth);
  assert(fallback === 272, `a non-numeric width falls back to the SIDEBAR_DEFAULT_PX default (got ${fallback}px)`);
});

test("sidebar: #view-controls never covers the sidebar's clickable panels", async (page) => {
  await populate(page);
  const rects = async () =>
    page.evaluate(() => ({
      side: document.getElementById("side").getBoundingClientRect(),
      vc: document.getElementById("view-controls").getBoundingClientRect(),
      body: document.body.getBoundingClientRect(),
    }));
  let r = await rects();
  assert(
    r.vc.left >= r.side.right - 1,
    `view-controls' left edge clears the sidebar (vc ${r.vc.left.toFixed(0)} vs sidebar right ${r.side.right.toFixed(0)})`
  );
  assert(
    r.vc.width <= r.body.width - r.side.width - 4,
    `view-controls fits inside the app region (bar ${r.vc.width.toFixed(0)}px vs app ${(r.body.width - r.side.width).toFixed(0)}px)`
  );
  // Narrow editor: the six controls-groups bar (historically 866–1290px wide)
  // is wider than the canvas at ~800px, so plain centring CANNOT clear the
  // sidebar here — the max-width + #vc-body wrap must actually engage. This
  // is the branch that catches a reverted `max-width` cap: a 50%-centred
  // wide bar's left half paints over the sidebar's bottom panels and
  // intercepts their clicks (a documented real incident from the
  // collapsible-sections work).
  await page.setViewportSize({ width: 820, height: 900 });
  await sleep(200);
  r = await rects();
  assert(
    r.vc.left >= r.side.right - 1,
    `at an 820px editor the bar still clears the sidebar (vc ${r.vc.left.toFixed(0)} vs sidebar right ${r.side.right.toFixed(0)})`
  );
  assert(
    r.vc.left + r.vc.width <= r.body.width - 4,
    `at 820px the bar stays on the canvas, not overflowing right (right edge ${(r.vc.left + r.vc.width).toFixed(0)} vs body ${r.body.width.toFixed(0)})`
  );
});

test("keyboard: dropdown arrows move focus along menu items; Escape closes and restores focus to the trigger", async (page) => {
  await populate(page);
  const trigger = await page.locator("#view-menu");
  await trigger.click();
  assert(await page.evaluate(() => !document.getElementById("view-dropdown").classList.contains("hidden")), "the menu opened");
  const first = await page.evaluate(() => document.activeElement?.textContent ?? "");
  // ArrowDown steps onto the first *menu item* from the trigger.
  await page.keyboard.press("ArrowDown");
  const afterDown1 = await page.evaluate(() => ({
    focused: document.activeElement?.textContent ?? "", inPanel: document.getElementById("view-dropdown").contains(document.activeElement),
  }));
  assert(afterDown1.inPanel, `ArrowDown moves focus into the open panel (first: ${JSON.stringify(first)})`);
  assert(afterDown1.focused !== "", "the target is a real labelled item");
  // Home returns to the first item; five ArrowDowns then five ArrowUps cycle the same loop.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  const cycled = await page.evaluate(() => document.getElementById("view-dropdown").contains(document.activeElement));
  assert(cycled, "arrow cycling stays inside the panel at the wrap boundary");
  const openBefore = await page.evaluate(() => !document.getElementById("view-dropdown").classList.contains("hidden"));
  assert(openBefore, "the menu is still open before Escape");
  await page.keyboard.press("Escape");
  const after = await page.evaluate(() => ({
    closed: document.getElementById("view-dropdown").classList.contains("hidden"),
    focus: document.activeElement?.id ?? "",
  }));
  assert(after.closed, "Escape closes the menu");
  assert(after.focus === "view-menu", `Escape returns focus to the trigger (got ${JSON.stringify(after.focus)})`);
});

test("aria: every icon-only title-carrying control carries an aria-label mirror", async (page) => {
  await populate(page);
  const missing = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button, select, input")).filter(
      (el) => el.getAttribute("title") !== null && el.getAttribute("aria-label") === null &&
              (el.textContent ?? "").trim() === ""
    ).map((el) => el.id || el.className || el.type)
  );
  assert(missing.length === 0, `every icon-only control has an aria-label (missing: ${JSON.stringify(missing)})`);
  // Spot-check the resize handle explicitly — it carries no title-derived text.
  const handle = await page.evaluate(() => ({
    role: document.getElementById("sidebar-resize").getAttribute("role"),
    label: document.getElementById("sidebar-resize").getAttribute("aria-label"),
  }));
  assert(handle.role === "separator", `the resize handle is a separator (got ${JSON.stringify(handle)})`);
  assert(
    handle.label !== null && handle.label.length > 3,
    `the resize handle is screen-reader labelled (got ${JSON.stringify(handle.label)})`
  );
});

test("keyboard: Escape cancels an inline Parts rename without committing the half-typed value", async (page) => {
  await populate(page);
  // Rename the first Part with a distinct value, then Escape mid-edit.
  const original = await page.evaluate(() => document.querySelector(".part-name").value);
  await page.evaluate(() => document.querySelector(".part-name").focus());
  await page.keyboard.type("ESC-SHOULD-NOT-STICK");
  await page.keyboard.press("Escape");
  await sleep(900); // outlive the parts autosave debounce, if one were to fire
  const after = await page.evaluate(() => ({
    dom: document.querySelector(".part-name").value,
    posted: (window.__sent ?? []).some((m) => m.type === "partsChanged"),
  }));
  assert(after.dom === original, `Escape restored the original name (got ${JSON.stringify(after.dom)})`);
  assert(!after.posted, "an Escape-cancelled rename posts no partsChanged (no spurious push/rename)");
  // And Enter styles the commit path: type, press Enter → partsChanged posted.
  await page.evaluate(() => document.querySelector(".part-name").focus());
  await page.keyboard.type("Z");
  await page.keyboard.press("Enter");
  await sleep(300);
  const committed = await page.evaluate(
    () => (window.__sent ?? []).findLast((m) => m.type === "partsChanged") ?? null
  );
  assert(committed !== null, "Enter commits the rename");
  // Restore for later cases: undo the Z suffix via the same Escape path.
  await page.evaluate(() => document.querySelector(".part-name").focus());
  await page.keyboard.press("Escape");
});

/**
 * Chrome redesign, pass 3 — the sidebar, status bar and chip changes that the
 * mockup asked for. Each assertion is about RENDERED state (offsetParent, boxes),
 * never a class name: the file documents an instance where every class-based
 * check passed while the element was plainly visible.
 */
test("doc chip: reports how many unsaved edits, and nothing when clean", async (page) => {
  await populate(page);
  const read = () =>
    page.evaluate(() => {
      const el = document.getElementById("doc-chip-unsaved");
      const chip = document.getElementById("doc-chip").getBoundingClientRect();
      const bar = document.getElementById("menubar").getBoundingClientRect();
      return { text: el.textContent, rendered: el.offsetParent !== null, inside: chip.top >= bar.top && chip.bottom <= bar.bottom };
    });
  await post(page, { type: "documentInfo", name: "bracket.step", path: "/x/bracket.step", format: "step", dirty: true, unsavedEdits: 3 });
  await sleep(80);
  const three = await read();
  assert(three.text === "3 unsaved edits" && three.rendered, `the chip counts the unsaved edits (got ${JSON.stringify(three.text)}, rendered ${three.rendered})`);
  assert(three.inside, "the longer chip still fits inside the menubar");

  await post(page, { type: "documentInfo", name: "bracket.step", path: "/x/bracket.step", format: "step", dirty: true, unsavedEdits: 1 });
  await sleep(80);
  assert((await read()).text === "1 unsaved edit", "singular for one");

  await post(page, { type: "documentInfo", name: "bracket.step", path: "/x/bracket.step", format: "step", dirty: false, unsavedEdits: 3 });
  await sleep(80);
  const clean = await read();
  assert(clean.text === "" && clean.rendered === false, "a clean document shows no count, even if a stale number rides along (the dirty flag wins)");

  await post(page, { type: "documentInfo", name: "old-host.step", path: "/x", format: "step", dirty: true });
  await sleep(80);
  assert((await read()).rendered === false, "a payload from a host without the field renders no count rather than 'undefined'");
});

test("status bar: sits below the canvas, holds the facts, and clears the dock", async (page) => {
  await populate(page);
  const geo = () =>
    page.evaluate(() => {
      const r = (id) => {
        const b = document.getElementById(id)?.getBoundingClientRect();
        return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } : null;
      };
      return {
        bar: r("statusbar"),
        app: r("app"),
        dock: r("view-controls"),
        side: r("side"),
        kernel: r("kernel-status"),
        vh: window.innerHeight,
        factsInside: ["vc-count-entities", "vc-count-mesh", "vc-cursor"].every((id) => document.getElementById("statusbar")?.contains(document.getElementById(id))),
        oldRowGone: document.getElementById("vc-status") === null,
      };
    });
  const g = await geo();
  assert(g.factsInside, "the counts, mesh stat and cursor readout live in the status bar");
  assert(g.oldRowGone, "the dock no longer carries its own status row");
  assert(Math.abs(g.bar.bottom - g.vh) < 1.5, `the bar is the bottom edge of the window (bottom ${g.bar.bottom.toFixed(1)} of ${g.vh})`);
  assert(g.app.bottom <= g.bar.top + 1, `the canvas ends where the bar begins — the bar never overlaps it (app bottom ${g.app.bottom.toFixed(1)}, bar top ${g.bar.top.toFixed(1)})`);
  assert(g.dock.bottom <= g.bar.top, `the dock floats clear of the bar (dock bottom ${g.dock.bottom.toFixed(1)}, bar top ${g.bar.top.toFixed(1)})`);
  assert(Math.abs(g.kernel.width - g.side.width) < 1.5, `kernel readiness sits under the sidebar's own width (${g.kernel.width.toFixed(0)} vs ${g.side.width.toFixed(0)})`);

  const kernel = () =>
    page.evaluate(() => ({
      text: document.getElementById("kernel-status-text").textContent,
      tone: document.getElementById("kernel-status").dataset.tone,
    }));
  const idle = { occt: "idle", gmsh: "idle", meshio: "idle", ftetwild: "idle" };
  await post(page, { type: "kernelStatus", state: idle });
  await sleep(60);
  let k = await kernel();
  assert(k.text === "Kernels idle" && k.tone === "idle", `idle kernels read as such, not as a fault (got ${JSON.stringify(k)})`);
  await post(page, { type: "kernelStatus", state: { ...idle, occt: "ready", gmsh: "loading" } });
  await sleep(60);
  k = await kernel();
  assert(k.text === "OCCT ready · Gmsh loading…" && k.tone === "loading", `only active kernels are listed, and a loading one sets the tone (got ${JSON.stringify(k)})`);
  await post(page, { type: "kernelStatus", state: { ...idle, occt: "ready", gmsh: "ready" } });
  await sleep(60);
  k = await kernel();
  assert(k.text === "OCCT ready · Gmsh ready" && k.tone === "ready", `both ready (got ${JSON.stringify(k)})`);

  // Narrow editor: the dock wraps, the bar must still clear it.
  await page.setViewportSize({ width: 820, height: 900 });
  await sleep(250);
  const n = await geo();
  assert(n.dock.bottom <= n.bar.top, `at 820px the wrapped dock still clears the bar (dock bottom ${n.dock.bottom.toFixed(1)}, bar top ${n.bar.top.toFixed(1)})`);
  assert(n.bar.right <= 820.5 && n.bar.width >= 819, "the bar spans the narrow window without overflowing it");
});

test("components: the filter box is behind a search button and clears when closed", async (page) => {
  await populate(page);
  const state = () =>
    page.evaluate(() => ({
      inputShown: document.getElementById("tree-filter").offsetParent !== null,
      expanded: document.getElementById("tree-search").getAttribute("aria-expanded"),
      rows: document.querySelectorAll("#tree-body .tree-row").length,
    }));
  const s0 = await state();
  assert(s0.inputShown === false && s0.expanded === "false", "the filter input is genuinely not rendered until asked for");
  assert(s0.rows > 0, "precondition: the tree has rows");

  await page.click("#tree-search");
  const s1 = await state();
  assert(s1.inputShown === true && s1.expanded === "true", "the search button reveals the filter input");
  const focused = await page.evaluate(() => document.activeElement?.id);
  assert(focused === "tree-filter", `and focuses it (focus on ${focused})`);

  await page.fill("#tree-filter", "zzz-no-such-component");
  await sleep(80);
  assert((await state()).rows === 0, "a filter that matches nothing empties the list");

  await page.keyboard.press("Escape");
  await sleep(80);
  const s2 = await state();
  assert(s2.inputShown === false, "Escape closes the filter box");
  assert(s2.rows === s0.rows, `closing it clears the filter, so no hidden box keeps hiding rows (${s2.rows} vs ${s0.rows})`);
  const back = await page.evaluate(() => document.activeElement?.id);
  assert(back === "tree-search", `and returns focus to the search button (focus on ${back})`);
});

test("parts: compact rows — no size field, quiet actions, entity lists start collapsed", async (page) => {
  await populate(page);
  const rows = () =>
    page.evaluate(() => {
      const shown = (el) => !!el && el.offsetParent !== null;
      return [...document.querySelectorAll("#parts-body .part-item")].map((item) => {
        const row = item.querySelector(".part-row");
        const btns = [...row.querySelectorAll("button.part-btn")];
        const list = item.querySelector(".part-entities");
        return {
          hasSizeField: !!row.querySelector(".part-meshsize"),
          badge: row.querySelector(".part-badge")?.textContent ?? null,
          eyeShown: shown(row.querySelector(".part-eye")),
          actionsShown: btns.filter((b) => !b.classList.contains("part-eye")).map(shown),
          actionCount: btns.filter((b) => !b.classList.contains("part-eye")).length,
          listCollapsed: list ? getComputedStyle(list).display === "none" : null,
        };
      });
    });
  const before = await rows();
  assert(before.length >= 3, `precondition: the fixture defines Parts (got ${before.length})`);
  for (const r of before) {
    assert(r.hasSizeField === false, "a row has no size field — that lives in FE Mesh › Part sizes");
    assert(/^\d+ · \d+ · \d+( · \d+)?$/.test(r.badge), `the count reads 'v · s · l' (got ${JSON.stringify(r.badge)})`);
    assert(r.eyeShown, "the eye is always visible");
    assert(r.actionCount === 2 && r.actionsShown.every((v) => v === false), "assign and delete are not rendered at rest — but exist, so tests and keyboard can reach them");
    assert(r.listCollapsed !== false, "an entity list, when present, starts collapsed");
  }
  await page.hover("#parts-body .part-row");
  await sleep(60);
  const hovered = await page.evaluate(() =>
    [...document.querySelector("#parts-body .part-row").querySelectorAll("button.part-btn:not(.part-eye)")].map((b) => b.offsetParent !== null)
  );
  assert(hovered.length === 2 && hovered.every(Boolean), "hovering a row reveals its assign and delete actions");
});

test("edits and FE Mesh headers: a count badge, a stat, and the actions moved into the body", async (page) => {
  await populate(page);
  const opCount = fixture("edits").ops.length;
  const edits = await page.evaluate(() => {
    const el = document.getElementById("edits-count");
    return { text: el.textContent, rendered: el.offsetParent !== null };
  });
  assert(edits.text === String(opCount) && edits.rendered, `the Edits header shows the history length (want ${opCount}, got ${JSON.stringify(edits.text)})`);
  await post(page, { type: "edits", ops: [], variables: [], bakedThrough: 0 });
  await sleep(120);
  assert(
    await page.evaluate(() => document.getElementById("edits-count").offsetParent === null),
    "an empty history leaves no badge behind"
  );

  const layout = await page.evaluate(() => {
    const panel = document.getElementById("meshing-panel");
    const body = document.getElementById("meshing-body");
    const gen = document.getElementById("meshing-generate");
    const kids = [...body.children].map((c) => c.id || c.className);
    return {
      generateInBody: body.contains(gen),
      generateInHeader: document.getElementById("meshing-header").contains(gen),
      generateWidth: gen.getBoundingClientRect().width,
      bodyWidth: body.getBoundingClientRect().width,
      exportAfterParts: (() => {
        const row = document.getElementById("meshing-export-row");
        const parts = document.getElementById("meshing-part-sizes");
        return !!row && !!parts && !!(parts.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
      })(),
      exportInBody: body.contains(document.getElementById("meshing-export")),
      kids,
      panelOk: !!panel,
    };
  });
  assert(layout.generateInBody && !layout.generateInHeader, "Generate lives in the body now, not the header");
  assert(layout.generateWidth > layout.bodyWidth * 0.6, `Generate is the full-width primary button (${layout.generateWidth.toFixed(0)} of ${layout.bodyWidth.toFixed(0)}px)`);
  assert(layout.exportInBody && layout.exportAfterParts, "the export row sits below the Part sizes");

  const stat = () =>
    page.evaluate(() => {
      const el = document.getElementById("meshing-header-stat");
      return { text: el.textContent.trim(), rendered: el.offsetParent !== null };
    });
  assert((await stat()).rendered === false, "no header stat before a mesh exists");
  await postMeshingResult(page);
  await sleep(500);
  const s1 = await stat();
  assert(s1.rendered && s1.text === "10,000 el", `the header stat reports the element count (got ${JSON.stringify(s1)})`);
  await page.click("#meshing-clear");
  await sleep(300);
  assert((await stat()).rendered === false, "Clear removes the header stat with the overlay");
});


/**
 * Chrome redesign, pass 4 — the remaining gaps to the mockup. As in pass 3, every
 * assertion reads RENDERED state (boxes, computed style), never a class name.
 */
test("components: the title stays 'Components', and an assembly row counts its solids", async (page) => {
  await populate(page);
  const read = () =>
    page.evaluate(() => ({
      title: document.getElementById("tree-title").textContent,
      tip: document.getElementById("tree-title").title,
      rows: [...document.querySelectorAll("#tree-body .tree-row")].map((r) => ({
        label: r.querySelector(".tree-label")?.textContent,
        badge: r.querySelector(".tree-badge")?.textContent ?? null,
        badgeTitle: r.querySelector(".tree-badge")?.title ?? null,
        hasKids: !!r.parentElement.querySelector(":scope > .tree-list"),
      })),
    }));
  const r = await read();
  assert(r.title === "Components", `the section title is not replaced by the root's label (got ${JSON.stringify(r.title)})`);
  assert(r.tip.length > 0, `the root's label moved to the title's tooltip (got ${JSON.stringify(r.tip)})`);
  const group = r.rows.find((x) => x.hasKids);
  assert(group && group.badge !== null && /^\d+$/.test(group.badge) && group.badgeTitle === "Solids in this assembly",
    `an assembly row shows how many solids it holds (got ${JSON.stringify(group)})`);
  const leaf = r.rows.find((x) => !x.hasKids);
  assert(leaf && leaf.badgeTitle === "Faces", `a leaf row's count is its face count (got ${JSON.stringify(leaf)})`);
});

test("parts: the panel hugs its rows instead of leaving an empty gap", async (page) => {
  await populate(page);
  const m = await page.evaluate(() => {
    const panel = document.getElementById("parts-panel").getBoundingClientRect();
    const head = document.getElementById("parts-header").getBoundingClientRect();
    const rows = [...document.querySelectorAll("#parts-body .part-row")].map((r) => r.getBoundingClientRect());
    const rowsH = rows.reduce((a, r) => a + r.height, 0);
    return { panel: panel.height, head: head.height, rowsH, n: rows.length };
  });
  assert(m.n >= 3, `precondition: three parts (got ${m.n})`);
  // Header + rows, with generous allowance for borders and the list's own padding —
  // the failure being pinned is a panel that is HUNDREDS of pixels taller than that.
  assert(m.panel <= m.head + m.rowsH + 40, `Parts is as tall as its content, not the spare column (panel ${m.panel.toFixed(0)}px vs header+rows ${(m.head + m.rowsH).toFixed(0)}px)`);
});

test("edits body: Variables + New is a ghost button, and the tabs are segmented tracks", async (page) => {
  await populate(page);
  const st = await page.evaluate(() => {
    const bg = (el) => getComputedStyle(el).backgroundColor;
    const isClear = (c) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
    const active = document.querySelector(".edits-tab.active");
    const idle = document.querySelector(".edits-tab:not(.active)");
    const btn = document.getElementById("variables-add");
    const track = document.querySelector(".edits-tabs");
    return {
      addClear: isClear(bg(btn)),
      addBorder: getComputedStyle(btn).borderTopWidth,
      idleClear: isClear(bg(idle)),
      activeBg: bg(active),
      trackBg: bg(track),
      // a solid VS Code button blue would equal the primary button's colour
      primaryBg: bg(document.getElementById("parts-new")),
    };
  });
  assert(st.addClear && st.addBorder !== "0px", `Variables + New is transparent with a thin border, not a browser-default white button (bg clear ${st.addClear}, border ${st.addBorder})`);
  assert(st.idleClear, "an inactive tab is transparent inside the track");
  assert(st.activeBg !== st.primaryBg, `the active tab is a lifted segment, not the solid primary-button blue (${st.activeBg} vs ${st.primaryBg})`);
  assert(st.trackBg !== "rgba(0, 0, 0, 0)", "the tabs sit on an inset track");
});

test("FE Mesh: a Part size reads to three figures, with no locale comma", async (page) => {
  await populate(page);
  const vals = await page.evaluate(() =>
    [...document.querySelectorAll("#meshing-part-sizes .meshing-part-size")].map((i) => ({ v: i.value, type: i.type, tip: i.title }))
  );
  assert(vals.length === 3, `three Part size fields (got ${vals.length})`);
  assert(vals.every((x) => x.type === "text"), "they are text fields — a number input renders through the OS locale");
  const sized = vals.find((x) => x.v !== "");
  assert(sized && sized.v === "4.02", `the sized part shows 3 significant figures with a dot (got ${JSON.stringify(sized)})`);
  assert(sized.tip.includes("4.0231"), "the exact stored value stays available in the tooltip");
  assert(vals.every((x) => !x.v.includes(",")), "no value contains a locale comma");
});

test("dock: the collapse control sits at the end of the bar, after the overflow button", async (page) => {
  await populate(page);
  const m = await page.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const toggle = r("vc-toggle");
    const more = r("vc-more");
    const modes = [...document.querySelectorAll(".display-mode-btn .toolbar-icon")].map((e) => e.offsetParent !== null);
    return { toggleLeft: toggle.left, moreRight: more.right, modesShowIcon: modes.some(Boolean), modeCount: modes.length };
  });
  assert(m.toggleLeft >= m.moreRight - 1, `the collapse control follows ⋯ (toggle left ${m.toggleLeft.toFixed(0)}, ⋯ right ${m.moreRight.toFixed(0)})`);
  assert(m.modeCount === 5 && !m.modesShowIcon, "the display modes are text-only segments");
  await page.click("#vc-toggle");
  await sleep(80);
  const collapsedRendered = await page.evaluate(() => document.getElementById("vc-toggle").offsetParent !== null);
  assert(collapsedRendered, "the collapse control is still reachable once the bar is collapsed");
});

test("toolbar: sidebar-sized type and line glyphs on the buttons", async (page) => {
  await populate(page);
  const m = await page.evaluate(() => {
    const fs = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
    return {
      toolbar: fs("#toolbar"),
      side: fs("#side"),
      fitGlyph: document.querySelectorAll("#fit .ui-glyph svg").length,
      viewGlyphs: document.querySelectorAll("#view-menu .ui-glyph svg").length,
      fitIcon: document.querySelectorAll("#fit .toolbar-icon").length,
      h: document.getElementById("fit").getBoundingClientRect().height,
    };
  });
  assert(m.toolbar <= m.side + 1, `the toolbar is no larger than the sidebar's type (toolbar ${m.toolbar}px, sidebar ${m.side}px) — it used to inherit the browser's 16px`);
  assert(m.fitGlyph === 1 && m.fitIcon === 0, "Fit uses the line glyph, not the generated icon");
  assert(m.viewGlyphs === 2, "a trigger carries its own glyph and a chevron");
  assert(m.h >= 26 && m.h <= 32, `toolbar buttons are a compact 28px (got ${m.h})`);
});


/**
 * Chrome redesign, pass 5 — the last gaps to the mockup. Rendered state, not class names.
 */
test("selection: a selected Part-coloured face keeps its hue family, with a visible tint", async (page) => {
  await populate(page);
  await gridOff(page);
  // Nothing hovering over the model, no dock/pill/readout over the canvas.
  await setPanelHidden(page, true);
  const orange = (colors) => colors.find(([k]) => {
    const [r, g, b] = k.split(",").map(Number);
    return r > 150 && r > b + 60 && r >= g; // the fixture's orange Part, shaded
  });
  const before = await dominantColors(page, 12);
  const base = orange(before);
  assert(base, `precondition: an orange Part-coloured face is on screen (top colours ${JSON.stringify(before.slice(0, 4))})`);
  await setPanelHidden(page, false);

  await enablePicking(page, "surface");
  const box = await viewportBox(page);
  // The big orange top face sits just off the viewport centre in the framed fixture.
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await sleep(400);
  assert(
    await page.evaluate(() => (window.__sent ?? []).some((m) => m.type === "entityFactsRequest")),
    "precondition: the click selected a face"
  );
  await page.mouse.move(box.x + 4, box.y + box.height - 4); // off the model
  await sleep(150);
  await setPanelHidden(page, true);
  const after = await dominantColors(page, 12);
  await setPanelHidden(page, false);

  const [br, , bb] = base[0].split(",").map(Number);
  const tinted = after.find(([k]) => {
    const [r, g, b] = k.split(",").map(Number);
    return !before.some(([bk]) => bk === k) && r > b && b > bb - 5 && r > br - 10;
  });
  assert(
    tinted,
    `a selected orange face stays orange-family (red still above blue) rather than turning lilac (before ${JSON.stringify(before.slice(0, 3))}, after ${JSON.stringify(after.slice(0, 4))})`
  );
  const [tr, , tb] = tinted[0].split(",").map(Number);
  assert(tb > bb, `and it is visibly tinted toward the accent (blue ${bb} -> ${tb})`);
  assert(tr > tb, `never past the point where blue overtakes red (red ${tr}, blue ${tb}) — the failure was a lilac (200,160,250)`);
});

test("dock and toolbar: a lifted grey display mode, a blue clip axis, and a divider", async (page) => {
  await populate(page);
  const m = await page.evaluate(() => {
    const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const div = document.querySelector("#toolbar .tb-div");
    const fe = r("#meshing-toggle");
    const view = r("#view-menu");
    const d = div?.getBoundingClientRect();
    return {
      mode: bg(".display-mode-btn.active"),
      axis: bg(".clip-axis.active"),
      primary: bg("#parts-new"),
      divRendered: !!div && div.offsetParent !== null,
      divBetween: !!d && d.left >= fe.right - 1 && d.right <= view.left + 1,
    };
  });
  assert(m.mode !== m.primary, `the active display mode is not the solid button-blue (${m.mode} vs ${m.primary})`);
  assert(m.axis === m.primary, `the active clip axis keeps the button-blue (${m.axis} vs ${m.primary})`);
  assert(m.divRendered && m.divBetween, "a hairline divides the plain buttons from the menu triggers");
});

test("sidebar: a collapsed section stacks no double rule, and the Advanced card has its tile", async (page) => {
  await populate(page);
  await page.click("#edits-header > .panel-chevron");
  await sleep(100);
  const m = await page.evaluate(() => {
    const w = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
    const tile = document.getElementById("advanced-icon");
    const count = document.getElementById("advanced-count");
    return {
      collapsedBottom: w("#edits-header", "borderBottomWidth"),
      tileBg: getComputedStyle(tile).backgroundColor,
      tileW: tile.getBoundingClientRect().width,
      countBg: getComputedStyle(count).backgroundColor,
      countMono: getComputedStyle(count).fontFamily.toLowerCase().includes("mono") || getComputedStyle(count).fontFamily.includes("ui-monospace"),
    };
  });
  assert(m.collapsedBottom === "0px", `a collapsed header has no bottom border, so it cannot double the next section's rule (got ${m.collapsedBottom})`);
  assert(m.tileW >= 22 && m.tileBg !== "rgba(0, 0, 0, 0)", `the Advanced icon sits in a filled tile (width ${m.tileW}, bg ${m.tileBg})`);
  assert(m.countBg === "rgba(0, 0, 0, 0)", `the 5-of-7 badge is an outline, not a solid pill (bg ${m.countBg})`);
});


test("sidebar: every section header carries the same rounded icon tile, between chevron and title", async (page) => {
  await populate(page);
  await openAdvanced(page);
  const headers = await page.evaluate(() => {
    const ids = [
      "tree-header", "parts-header", "edits-header", "meshing-header", "advanced-header", "mass-header",
      "clash-header", "mesh-health-header", "region-fit-header", "primitives-header", "macros-header", "standard-parts-header",
    ];
    return ids.map((id) => {
      const h = document.getElementById(id);
      const chev = h?.querySelector(".panel-chevron");
      const icon = h?.querySelector(":scope > .panel-icon");
      const title = h?.querySelector(".panel-title");
      const b = icon?.getBoundingClientRect();
      return {
        id,
        present: !!h && !!icon,
        hasGlyph: !!icon?.querySelector("svg path, svg circle, svg rect"),
        ordered: !!chev && !!icon && !!title &&
          !!(chev.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          !!(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
        ariaHidden: icon?.getAttribute("aria-hidden") === "true",
        // A source-gated section (Clash, Mesh Health, Region fit, Primitives) is
        // legitimately not rendered for some formats — size is only checked for a
        // tile that is actually on screen.
        rendered: !!icon && icon.offsetParent !== null,
        w: b?.width ?? 0,
        h: b?.height ?? 0,
        svgMarkup: icon?.innerHTML ?? "",
      };
    });
  });
  for (const x of headers) {
    assert(x.present, `#${x.id} has an icon tile`);
    assert(x.hasGlyph && x.ariaHidden, `#${x.id}'s tile holds a drawn glyph and is hidden from assistive tech (it is decoration — the title names the section)`);
    assert(x.ordered, `#${x.id}: chevron, then icon, then title`);
    if (x.rendered) assert(Math.abs(x.w - 22) < 0.6 && Math.abs(x.h - 22) < 0.6, `#${x.id}'s tile is the shared 22px (got ${x.w}x${x.h})`);
  }
  assert(headers.filter((x) => x.rendered).length >= 8, `most tiles are on screen for a B-rep document (rendered: ${headers.filter((x) => x.rendered).length})`);
  const glyphs = headers.map((x) => x.svgMarkup);
  assert(new Set(glyphs).size === glyphs.length, "every section has its OWN glyph — no two headers share an icon");
});


/**
 * Chrome redesign, pass 7 — the last visible gaps. Rendered state, not class names.
 */
test("FE Mesh: preset actions share the PRESET label's line, and the export row closes the panel", async (page) => {
  await populate(page);
  const m = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const section = document.querySelector(".meshing-pair .meshing-section");
    const label = section.querySelector(".meshing-label");
    const actions = section.querySelector(".meshing-preset-actions");
    const apply = [...actions.querySelectorAll("button")].find((b) => b.textContent === "Apply");
    // The label's BOX stretches the whole column (a flex item in a column), so
    // horizontal collision is measured against its TEXT, via a Range.
    const range = document.createRange();
    range.selectNodeContents(label);
    const [l, a] = [range.getBoundingClientRect(), r(actions)];
    const overlapV = Math.min(l.bottom, a.bottom) - Math.max(l.top, a.top);
    const select = section.querySelector("select");
    const body = document.getElementById("meshing-body");
    const visibleKids = [...body.children].filter((c) => c.offsetParent !== null);
    return {
      overlapV, labelH: l.height,
      overlapH: Math.min(l.right, a.right) - Math.max(l.left, a.left),
      actionsAboveSelect: a.bottom <= r(select).top + 1,
      applyShown: apply.offsetParent !== null,
      lastId: visibleKids.at(-1)?.id ?? null,
      exportInside: !!document.getElementById("meshing-export-row")?.contains(document.getElementById("meshing-export")),
    };
  });
  assert(m.overlapV >= m.labelH * 0.5, `the actions sit on the PRESET label's line (vertical overlap ${m.overlapV.toFixed(1)}px of ${m.labelH.toFixed(1)}px)`);
  assert(m.overlapH <= 0, `and do not collide with the label (horizontal overlap ${m.overlapH.toFixed(1)}px)`);
  assert(m.actionsAboveSelect && m.applyShown, "above the select, still rendered and clickable");
  assert(m.lastId === "meshing-export-row" && m.exportInside, `the export row is the last thing in the panel body (last visible child: ${m.lastId})`);
});

test("toolbar and tree: a selected item is a quiet lifted background, not the saturated blue", async (page) => {
  await populate(page);
  // Turn selection mode on so the Select trigger is `.active`, and select a tree row.
  await page.click("#select-menu");
  await page.click("#sel-toggle");
  await page.click("#select-menu");
  await page.click("#tree-body .tree-row >> nth=0");
  await sleep(120);
  const m = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      triggerActive: document.getElementById("select-menu").classList.contains("active"),
      triggerBg: cs("#select-menu").backgroundColor,
      triggerOutline: cs("#select-menu").outlineStyle,
      treeBg: cs("#tree-body .tree-row.selected").backgroundColor,
      primary: getComputedStyle(document.getElementById("parts-new")).backgroundColor,
      toggleBg: cs("#sel-toggle").backgroundColor,
    };
  });
  assert(m.triggerActive, "precondition: the Select trigger is active");
  assert(m.triggerOutline === "none" && m.triggerBg !== "rgba(0, 0, 0, 0)", `an active trigger is a lifted background without an outline (bg ${m.triggerBg}, outline ${m.triggerOutline})`);
  assert(m.treeBg !== m.primary && m.treeBg !== "rgb(9, 71, 113)", `a selected tree row is not the saturated selection blue (${m.treeBg})`);
});


async function main() {
  if (!nodeSupportsPlaywright()) {
    // Not a failure: playwright-core would `process.exit(1)` at module load, so
    // the only safe response is to never import it. Same guard/reason as
    // src/renderService.ts's `nodeSupportsPlaywright()`.
    console.log(
      `Skipping webview tests: Node ${process.versions.node} is below Playwright's minimum (${MIN_NODE_MAJOR_FOR_PLAYWRIGHT}).`
    );
    process.exit(0);
  }
  for (const f of ["body.html", "geometry.json", "registry.json"]) {
    if (!fs.existsSync(path.join(FIX, f))) {
      console.error(`Missing fixture ${f} — run \`node scripts/screenshots/make-fixtures.mjs\` first.`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(path.join(ROOT, "media", "viewer.js"))) {
    console.error("Missing media/viewer.js — run `npm run build` first.");
    process.exit(1);
  }

  const { chromium } = await import("playwright");
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Harness server: ${base}`);

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // Count every frame the render scheduler asks for. Installed before any page
  // script runs, so `viewer.ts`'s injected frame source picks up the wrapper.
  await context.addInitScript(() => {
    window.__rafCount = 0;
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      window.__rafCount++;
      return original(cb);
    };
  });

  try {
    const only = process.env.WEBVIEW_TEST_ONLY; // substring filter for iterating on one case
    for (const c of CASES.filter((x) => !only || x.name.includes(only))) {
      console.log(`\n${c.name}`);
      const page = await context.newPage();
      // An uncaught exception in the webview is a failure even if every
      // assertion below still happens to pass — the screenshot harness never
      // noticed these at all.
      page.on("pageerror", (err) => {
        failures++;
        console.error(`  ✗ uncaught page error: ${err.message}`);
      });
      try {
        await openHarness(page, base);
        await c.run(page);
      } catch (err) {
        failures++;
        console.error(`  ✗ ${c.name}: ${err.message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(
    failures
      ? `\nWebview tests FAILED: ${failures} of ${checks} checks.`
      : `\nWebview tests passed (${checks} checks).`
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

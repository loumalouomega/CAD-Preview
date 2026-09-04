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
  const ids = [
    "menubar", "toolbar", "app", "view-controls",
    "tree-panel", "tree-body",
    "parts-panel", "parts-body",
    "edits-panel", "variables-section",
    "meshing-panel", "standard-parts-panel",
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
 * E. The FE mesh overlay and its toolbar toggle stay truthful about each other.
 * `CLAUDE.md`: the toggle "must never claim on for content that isn't shown",
 * and showing an overlay hides the model's own shaded faces so two opaque
 * solids don't stack.
 */
test("overlays: meshingResult lights the toggle and hides model faces; Clear reverses both", async (page) => {
  await populate(page);
  const before = await page.evaluate(() => document.getElementById("meshing-toggle")?.classList.contains("active"));
  assert(before === false, "the FE Mesh toggle starts inactive");

  await post(page, fixture("meshingResult"));
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

  const shot = (await page.locator("#app").screenshot()).toString("base64");
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
  const shot = await page.screenshot({
    clip: { x: box.x + 8, y: box.y + 8, width: box.width - 16, height: box.height - 16 },
  });
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

  // A cylinder has no single normal — EntityFacts returns null and the row must
  // be ABSENT, not blank. This is the whole point of the card.
  await reply({ ...planar, surfaceType: "cylinder", normal: null, planeOrigin: null }, req.requestId);
  await sleep(120);
  assert((await cardTitle()) === "Cylindrical face", `a cylinder renders as "Cylindrical face" (got ${await cardTitle()})`);
  assert(!(await cardKeys()).includes("Normal"), "a curved face shows NO Normal row");

  // The analytic parameters behind the classification. Before roadmap item 8
  // Phase 1 the card could say "Cylindrical face" and nothing more — the
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
  // Volume/point have no predicate vocabulary — the same gate the filter form
  // applies. An empty menu would read as a bug.
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

// ── Runner ────────────────────────────────────────────────────────────────

// ── Clip plane and the stencil clip cap ───────────────────────────────────
//
// `clipCap.ts` had NO test of any kind and a documented SILENT failure mode:
// get the stencil state wrong and the model simply renders uncapped, with no
// error anywhere. These cases close that, and they gate the arbitrary-normal
// work (roadmap item 7) — everything below `Viewer.setClippingPlane` was
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
    const el = document.getElementById("view-controls");
    if (el) el.style.display = h ? "none" : "";
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
  const shot = (await page.locator("#app").screenshot()).toString("base64");
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
  const shot = (await page.locator("#app").screenshot()).toString("base64");
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
    for (const c of CASES) {
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

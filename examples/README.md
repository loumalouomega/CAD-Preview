# Example files

Fixtures used for manual verification (see the "Verify a change" section of the root `CLAUDE.md`) and referenced by unit/integration tests. One small `cube.*` fixture covers each mesh format; the `STP/` directory holds a large batch of real-world B-rep models for exercising the OCCT pipeline against varied geometry.

| Directory | Format | Extension | Pipeline |
| --- | --- | --- | --- |
| [`STP/`](STP/) | STEP | `.stp` | OCCT → BRepMesh (B-rep) |
| [`STL/`](STL/) | STL | `.stl` | Three.js `STLLoader` (mesh) |
| [`OBJ/`](OBJ/) | OBJ | `.obj` | Three.js `OBJLoader` (mesh) |
| [`PLY/`](PLY/) | PLY | `.ply` | Three.js `PLYLoader` (mesh) |
| [`GLTF/`](GLTF/) | glTF | `.gltf` | Three.js `GLTFLoader` (mesh) |
| [`3MF/`](3MF/) | 3MF | `.3mf` | Three.js `3MFLoader` (mesh; display-only on the host) |
| [`Collada/`](Collada/) | Collada | `.dae` | Three.js `ColladaLoader` (mesh; import-only, display-only on the host) |
| [`AMF/`](AMF/) | AMF | `.amf` | Three.js `AMFLoader` (mesh; import-only, display-only on the host) |
| [`USD/`](USD/) | USD | `.usd` `.usda` `.usdc` `.usdz` | Three.js `USDLoader` (mesh; import-only, display-only on the host) |
| [`MED/`](MED/) | MED | `.med` | meshio++ bridge (host-side, geometry + region/data-array-name visibility) |
| [`VTKXML/`](VTKXML/) | VTK XML | `.vtu` | meshio++ bridge (host-side, geometry; exercises the zstd/lz4 block codecs) |
| [`libMesh/`](libMesh/) | libMesh | `.xda`/`.xdr` (+`.gz`/`.bz2`) | meshio++ bridge (host-side, geometry) |
| [`CadJson/`](CadJson/) | Kratos CAD JSON | `.cad.json` | meshio++ bridge (host-side, exact NURBS via the `iga_*` tools) |
| [`Nastran/`](Nastran/) | Nastran bulk data | `.bdf` | meshio++ bridge (host-side, geometry only) |
| [`OpenSCAD/`](OpenSCAD/) | OpenSCAD CSG | `.csg` | CSG parse → OCCT build → BRepMesh (B-rep, opaque base) |
| [`OpenSCAD/`](OpenSCAD/) | OpenSCAD Source | `.scad` | openscad binary → `.csg` → same as above |

CAD Preview also supports IGES (`.iges`/`.igs`) and BREP (`.brep`) via the same OCCT pipeline as STEP, and glTF binary (`.glb`) via the same loader as `.gltf`, but no example fixtures are checked in for those extensions. See `doc/file-formats.md` for the full format reference.

## STL / OBJ / PLY / glTF

Each mesh directory contains a single `cube.*` fixture — a minimal triangulated cube used to smoke-test the native Three.js loader path (no OCCT/WASM involved).

`PLY/colored-cube.ply` (a distinct vertex colour per face), `OBJ/colored-cube.obj` + `.mtl` (one mesh, two `usemtl` materials), `OBJ/textured-quad.obj` + `.mtl` + `.png` (a `map_Kd` diffuse texture; the 2×2 PNG is red/green over blue/yellow) and `OBJ/missing-mtl.obj` (an `mtllib` naming a file that does not exist) exercise the colour paths — `npm run test:webview` renders each and asserts the colours on screen.

## MED

`two-material-tets.med` is a synthetic (not real-world) fixture: two tetrahedra sharing a face, written by meshio++'s own MED writer from a hand-built mesh with two named cell regions (`MaterialA`/`MaterialB`) and a `Temperature` point-data field — used to verify (`npm run mcp:smoke`) that `load_model`/the viewer's meshio++ import surfaces those real names via `readMeshioMetadata()`. See CLAUDE.md's "meshio++ integration" section.

## VTKXML

`cube-zstd.vtu` and `cube-lz4.vtu` are meshio++'s own VTK XML writer output over `STL/cube.stl` (12 triangles, binary base64 encoding), written once per **block codec** by `scripts/gen-codec-fixtures.mjs` (sibling of `scripts/gen-libmesh-fixtures.mjs`; both run the WASM at fixture-generation time). Since @meshioplusplus/wasm 17.2.0 the staged **full** artifact links zstd 1.5.7 and lz4 1.10.0 alongside the ever-present zlib, so `.vtu` files whose 32 KiB blocks were compressed with either codec now open (previously a zstd/lz4 file failed with the codec's build-flag name, because the lean artifact has zlib only). The two codecs are not equivalent: **lz4 (`vtkLZ4DataCompressor`) is a real VTK/ParaView codec** — any ParaView reads it — while **zstd (`vtkZSTDDataCompressor`) is a meshio++ extension** VTK does not ship (see upstream `doc/codecs.md`), so the zstd fixture pins the meshio++-only path and the lz4 fixture pins the interop path. Both are asserted through the real `load_model` bridge in `npm run mcp:smoke` and as `compat` corpus rows `load-vtu-zstd`/`load-vtu-lz4`. Regenerate with `node scripts/gen-codec-fixtures.mjs` after a meshio++ upgrade.

## libMesh

`two-tets.{xda,xdr,xda.gz,xda.bz2}` are meshio++'s own libMesh writer output of a hand-built mesh (two tetrahedra sharing the face (1,2,3); 5 points, so the boundary conversion yields 8 triangles), written once per routed flavour by `scripts/gen-libmesh-fixtures.mjs`, which also reads every flavour straight back by extension sniffing to pin the read side at fixture-generation time. libMesh is the equation-system output format of the [libMesh](https://libmesh.github.io/) FEM library: `.xda` is the ASCII checkpoint, `.xdr` the XDR-binary one, and meshio++ (17.2.0+) also reads each compressed with gzip (`zlib` — every artifact) or bzip2 (FULL artifact only, like every bzip2 path — the `.bz2` fixture therefore pins the full-artifact requirement). `.xdr.gz`/`.xdr.bz2` are deliberately NOT routed — no fixture covers the binary+compressed combination. Asserted by `npm run mcp:smoke` (all four flavours load through the real bridge) and `compat` corpus rows `load-libmesh-*`; `load-libmesh-xda` also re-meshes the loaded geometry. libMesh is also an FE-mesh **export** target (plain `.xda`; see `doc/gmsh-integration.md`'s "The meshio++ bridge"). Regenerate with `node scripts/gen-libmesh-fixtures.mjs` after a meshio++ upgrade.

## CadJson

`cube.cad.json` is a Kratos CAD JSON NURBS B-rep of the STL cube, built entirely by meshio++: the FULL artifact's `fitCad` turns `STL/cube.stl`'s six plane patches into an exact analytic solid and the solid's `info` side channel is serialized back as CAD JSON — the input format of the `iga_sample`/`iga_refine`/`iga_evaluate` MCP tools. The file declares 6 trimmed plane faces over 6 patches (12 edges, 1 brep) and stores a 16×16-per-face quad sampling (1536 quads → 3072 boundary triangles through the bridge's in-place linearization). `scripts/gen-cadjson-fixtures.mjs` regenerates it and prints the sampled/refined/evaluated facts that `npm run mcp:smoke` and the `load-cad-json` corpus row pin (refine `elevate 1, subdivisions 1` → degrees 1→2, 4→9 control points per patch, `quad9` sampling, still 3072 triangles when reloaded — geometry unchanged). Run `node scripts/gen-cadjson-fixtures.mjs` after a meshio++ upgrade.

## Nastran

`block-tets.bdf` is this extension's own FE Mesh export of `STP/block.stp` (Gmsh writer, `sizeMin` 2.5 / `sizeMax` 4 — 32 nodes, 60 elements: `CTETRA` + `CTRIA3` + `CBAR`). Gmsh writes a bare bulk-data section with no `BEGIN BULK` line, which meshio++ requires — the fixture deliberately keeps that shape so `npm run compat`/`mcp:smoke` pin the read-side normalization in `src/nastranDeck.ts`.

`box-fixed-field.bdf`, `box-free-field.bdf` and `box-large-field.bdf` are **hand-authored** to the MSC Nastran Quick Reference Guide card layout — they were **not emitted by a Nastran tool** (none is available to this project), so they are evidence that meshio++'s reader copes with the standard card shapes, not that it copes with every real tool's output. All three describe the same 2 × 3 × 4 box (volume 24) as six 10-node `CTETRA` with `+` continuation lines, in the three Nastran field formats: fixed (8-column), free (comma-separated) and large-field `GRID*` (16-column). All three also carry a full executive section, case control, `BEGIN BULK`, and solver cards (`MAT1`, `PSOLID`, `FORCE`, `SPC1`) that this extension ignores. Because every number is derivable from the geometry, `scripts/probe/examples/nastran-deck.ts` and `mcp:smoke` pin the extent and the summed tetrahedron volume against 2 × 3 × 4 / 24 rather than a count.

`box-hex.bdf` (two 8-node `CHEXA`), `box-wedge.bdf` (two 6-node `CPENTA`) and `plate-shell.bdf` (two `CQUAD4` and a `CTRIA3`, area 15, no volume) are hand-authored the same way and cover the other element cards. Both found real defects in the import path, fixed in the same change: the native surface converter keeps only the *triangular* boundary faces, so the wedge box read as volume 8 instead of 24 (the extent check could not see it — the end caps touch every vertex); and a shell-only deck's boundary extraction returned its free edges, so the plate was refused as "lost part of the geometry". `CBAR`/`CROD` remain unexercised, and no deck from a real Nastran tool is committed.

## OpenSCAD

Hand-written `.csg` fixtures (no OpenSCAD binary is needed to produce them — the format is plain text). `bracket.csg` is the clean path: cubes, a `$fn=10` faceted cylinder (real prism), a `multmatrix` translate, and `union`/`difference` — loads with no warnings, 2 solids, analytic volume 5228.88 (pinned in `npm run mcp:smoke`). `mixed.csg` exercises the warning paths: `hull()` skipped whole and a `$fn=8` sphere imported analytic. `minimal.scad` mirrors `bracket.csg`'s shape vocabulary for the binary path — with openscad installed it converts to the equivalent evaluated tree (2 solids, same analytic volume, asserted in smoke when `OPENSCAD_BINARY` is set); without one, smoke asserts the graceful null-inventory + install-hint degradation instead. `two-colour.scad`/`.csg` and `colour-booleans.scad`/`.csg` are real OpenSCAD 2021.01 output that exercise `color()` → Parts (`two-colour.csg`: red solid-0 + solid-4, blue solid-1 + solid-2, solid-3 uncoloured; `colour-booleans.csg`: the innermost-wins, difference-keeps-minuend and mixed-union rules). `include-main.scad` + `include-lib.scad` are a two-file model (20×10×5 plate, 1000 mm³) used to prove an edited include is never served from the conversion cache. See `doc/file-formats.md`'s "OpenSCAD CSG" and "OpenSCAD Source" sections.

## STP

Real-world STEP AP203 models, mostly drawn from the public [NIST/STEP Tools AP203 test file library](https://www.steptools.com/docs/stpfiles/ap203/index.html). `bull.stp` is the primary fixture used throughout `CLAUDE.md`'s manual verification steps (parts, edits, wireframe modeling); the rest exercise the tessellation and edge pipelines against a wide range of solids and assemblies.

| File | Size | Header name / description |
| --- | --: | --- |
| `1797609in.stp` | 164K | 1797609in |
| `2827056.stp` | 384K | 2827056 |
| `4pinplug.stp` | 60K | 4pinplug |
| `53711_74563f01_na.stp` | 56K | 53711_74563f01_na.203 |
| `angle1.stp` | 24K | angle1 |
| `as1_pe.stp` | 80K | AS1_ASM (aircraft wing assembly) |
| `bernetl.stp` | 240K | LAURA TEST STEP |
| `block.stp` | 12K | block |
| `boeing_part.stp` | 184K | boeing_part |
| `boeing_part_simple.stp` | 164K | simple_boeing_part |
| `bracket1-part.stp` | 76K | bracket1-Part |
| `bull.stp` | 112K | trans.stp (primary manual-verification fixture) |
| `calo.stp` | 832K | ME.TH3.1222.A.0200A.A*MARTINEZ CTH CALODUC PANNEAU CM SUD |
| `calosoe.stp` | 536K | CALOSOE |
| `chair.stp` | 84K | chair |
| `clevis21.stp` | 60K | clevis21 |
| `clevis22.stp` | 88K | clevis22 |
| `clevis23.stp` | 68K | clevis23 |
| `clip.stp` | 100K | A140N2063-83 SOLID ONLY |
| `cubcylso.stp` | 16K | CUBCYLSOEDET (cube + cylinder, solid) |
| `cubsomcy.stp` | 12K | CUBSOMCYLSOE (cube + cylinder, shell) |
| `cylcub.stp` | 16K | CYLCUB (cylinder + cube) |
| `daratech.stp` | 328K | daratech |
| `doghouse.stp` | 60K | doghouse |
| `filler.stp` | 84K | filler_cap |
| `gear.stp` | 52K | GEAR_PRT |
| `gehaeuse.stp` | 124K | gehaeuse |
| `hose-fitting.stp` | 132K | 21151-6-6 |
| `interacting_pockets.stp` | 68K | interactingPockets |
| `iso14649-demo.stp` | 192K | PART11 (ISO 14649 machining demo) |
| `jack_in_the_box.stp` | 696K | jack_in_the_box |
| `lower_carriage.stp` | 76K | lower_carriage |
| `mohne.stp` | 260K | mohne |
| `monster4.stp` | 352K | monster4 |
| `moon_buggy.stp` | 476K | ap_file.203 (lunar rover model) |
| `mycami2.stp` | 68K | mycami2 |
| `nasty_cheese.stp` | 652K | nasty_cheese |
| `ph4m3-st.stp` | 468K | ph4m3-st |
| `piston.stp` | 364K | piston_lock |
| `rear.stp` | 5.6M | REAR_LEFT_QUARTER_ASM (large assembly) |
| `snet.stp` | 36K | SNETDDAT0618199910492687 |
| `socket.stp` | 52K | socket |
| `socks.stp` | 456K | NIRS TEST: SHEAR TIE |
| `st203-bapl.stp` | 2.9M | STEP-BAPL |
| `team.stp` | 104K | team |
| `teampart.stp` | 800K | PLATE6 |
| `tork.stp` | 2.7M | torque_amplifier_housing |
| `turbine.stp` | 2.3M | 071_2d_wf |
| `unterlaf.stp` | 716K | unterlaf |
| `upper_carriage.stp` | 92K | upper_carriage |
| `vaccase_asm_solid.stp` | 428K | VACCASE_ASM |
| `valve.stp` | 44K | valve |
| `vs_training.stp` | 120K | vs_training |
| `weldment_asm_solid.stp` | 1.7M | WELDMENT_ASM |

## 3MF

`3MF/cube.3mf` is a 10 mm cube (`unit="millimeter"`, 12 triangles) and `3MF/cube-inch.3mf` a 1 inch cube (`unit="inch"`; it must measure 25.4 mm after loading — three's loader ignores the unit, so the viewer applies it). Both are generated by `node scripts/3mf-fixtures/make-3mf.mjs` using the same writer as the viewer's Export, so the bytes are reproducible. A 3MF is display-only on the host: Compare Models, Mesh Health, drawings and headless meshing refuse it by name.

## Collada

`Collada/cube.dae` is a 10 mm cube (`<unit meter="0.001">`, `Z_UP`, 12 triangles, no material), `Collada/cube-metre.dae` the same cube authored in metres (`<unit meter="1">`, `Y_UP`, 0.01-unit edges), `Collada/cube-inch.dae` a 1 inch cube (it must measure 25.4 mm after loading — three's loader scales by metres, so the viewer replaces that with millimetres) and `Collada/cube-colour.dae` the 10 mm cube with a red Phong material. All are generated by `node scripts/dae-fixtures/make-dae.mjs`. A `.dae` is import-only and display-only on the host: Compare Models, Mesh Health, drawings and headless meshing refuse it by name.

## USD

`USD/cube.usda` is a 10 mm cube (`metersPerUnit = 0.001`, Y-up, 12 triangles), `USD/cube-cm.usda` a 1 cm cube (`metersPerUnit = 0.01`; it must measure 10 mm — the loader scales by `metersPerUnit` itself and the viewer resets that scale, so it must be applied exactly once), `USD/cube-zup.usda` a 10 × 10 × 30 mm Z-up box, `USD/cube-colour.usda` the cube with a red `primvars:displayColor` and `USD/cube.usdz` the 10 mm cube in a USDZ package. All are generated by `node scripts/usd-fixtures/make-usd.mjs`. A USD file is import-only and display-only on the host: Compare Models, Mesh Health, drawings and headless meshing refuse it by name.

## AMF

`AMF/cube.amf` is a 10 mm cube (`unit="millimeter"`, 12 triangles, no material), `AMF/cube-inch.amf` a 1 inch cube (`unit="inch"`; it must measure 25.4 mm — three's loader already scales to millimetres, so the viewer must not scale again), `AMF/cube-colour.amf` the 10 mm cube with a red material and `AMF/cube-zip.amf` the 10 mm cube in the compressed ZIP container. All are generated by `node scripts/amf-fixtures/make-amf.mjs`. An `.amf` is import-only and display-only on the host: Compare Models, Mesh Health, drawings and headless meshing refuse it by name.

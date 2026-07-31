# Example files

Fixtures used for manual verification (see the "Verify a change" section of the root
`CLAUDE.md`) and referenced by unit/integration tests. One small `cube.*` fixture
covers each mesh format; the `STP/` directory holds a large batch of real-world B-rep
models for exercising the OCCT pipeline against varied geometry.

| Directory | Format | Extension | Pipeline |
|-----------|--------|-----------|----------|
| [`STP/`](STP/) | STEP | `.stp` | OCCT → BRepMesh (B-rep) |
| [`STL/`](STL/) | STL | `.stl` | Three.js `STLLoader` (mesh) |
| [`OBJ/`](OBJ/) | OBJ | `.obj` | Three.js `OBJLoader` (mesh) |
| [`PLY/`](PLY/) | PLY | `.ply` | Three.js `PLYLoader` (mesh) |
| [`GLTF/`](GLTF/) | glTF | `.gltf` | Three.js `GLTFLoader` (mesh) |
| [`MED/`](MED/) | MED | `.med` | meshio++ bridge (host-side, geometry + region/data-array-name visibility) |

CAD Preview also supports IGES (`.iges`/`.igs`) and BREP (`.brep`) via the same OCCT
pipeline as STEP, and glTF binary (`.glb`) via the same loader as `.gltf`, but no
example fixtures are checked in for those extensions. See `doc/file-formats.md` for
the full format reference.

## STL / OBJ / PLY / glTF

Each mesh directory contains a single `cube.*` fixture — a minimal triangulated cube
used to smoke-test the native Three.js loader path (no OCCT/WASM involved).

## MED

`two-material-tets.med` is a synthetic (not real-world) fixture: two
tetrahedra sharing a face, written by meshio++'s own MED writer from a
hand-built mesh with two named cell regions (`MaterialA`/`MaterialB`) and a
`Temperature` point-data field — used to verify (`npm run mcp:smoke`) that
`load_model`/the viewer's meshio++ import surfaces those real names via
`readMeshioMetadata()`. See CLAUDE.md's "meshio++ integration" section.

## STP

Real-world STEP AP203 models, mostly drawn from the public
[NIST/STEP Tools AP203 test file library](https://www.steptools.com/docs/stpfiles/ap203/index.html).
`bull.stp` is the primary fixture used throughout `CLAUDE.md`'s manual verification
steps (parts, edits, wireframe modeling); the rest exercise the tessellation and edge
pipelines against a wide range of solids and assemblies.

| File | Size | Header name / description |
|------|-----:|----------|
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

# EnSight Gold fixtures — NOT ROUTED, and why

`simple.case` + `simple.geo` — a hand-authored EnSight Gold deck with **two
parts**, non-sequential node and element ids, and mixed topology (one `tetra4`,
two `tria3`, one `nsided` quadrilateral).

```
simple.case   ← the index: names the geometry file, and any variable files
simple.geo    ← the geometry itself
```

**These files are committed as evidence, not as a supported format.** `.case`
is deliberately absent from `EXTENSION_MAP` (see the comment there). The
plumbing would have worked — `meshioCompanions.ts` already carries
`ensight: ["case", "geo"]` and unit-tests it, and EnSight only became readable
at all in meshio++ 16.17.0 — but the deck **does not survive this codebase's
boundary conversion**.

## The measurement that stopped it

Against meshio++ 16.21.0 directly, staging both files under their real
basenames (the stem convention is load-bearing — reading `/in.ensight` instead
of `/simple.case` misses the `.geo`):

| step | points | cells | extent |
| --- | --- | --- | --- |
| `readMesh("/simple.case", "ensight")` | 9 | 4 | `(0,0,0) → (2,1,1)` ✅ |
| `convertSurface(… → stl)` | — | — | **throws** |
| `extractSurface(readMesh(…))` | **4** | 4 | `(0,0,0) → (1,1,1)` ❌ |

The raw point array contains `2 0.5 0`, so the read really does span 2 in x —
and the boundary extraction collapses that to a unit box, **discarding the
extent entirely**. `convertToStlBoundary`'s documented fallback
(`extractSurface`, then `simplexify` for ragged blocks) is the path taken, and
it returns a unit cube.

End to end through the real server, `generate_mesh` on this deck returns
**120 nodes / 298 elements** — byte-identical to `MDPA/gapped-ids.mdpa`, a
one-cell unit tetrahedron. Two unrelated meshes cannot mesh identically, so the
2×1×1 geometry is being lost. Had `.case` been routed, the file would have
opened and **displayed a unit cube with no warning**.

## Why a counts-only check would have shipped it

`npm run compat`'s `load` rows assert counts, warnings and `remesh: true`, and
`remesh` only fails when `elementCount` is 0. A unit cube passes all of that.
This deck is deliberately anisotropic precisely so the *extent* is
assertable — and asserting it is the only thing that caught this.

That is the general lesson, and it is the reason new formats here should be
checked on geometry, not counts: a reader can return a well-formed, correctly
shaped, non-empty mesh that is the wrong mesh.

## Provenance — a FOREIGN fixture, deliberately

Copied verbatim from **meshio++'s own test suite**,
`tests/python/meshes/ensight/`, which is MIT-licensed; this project is
GPL-3.0-or-later, so the copy is fine in that direction.

That is the point. Every other fixture under `examples/` was written by
meshio++'s own writer and then read back by meshio++ — a **same-library** round
trip, which cannot detect a convention the library is self-consistent about.
That is exactly how CAD-Preview's MDPA quadratic node-order tables stayed
unverified (their comment cites a probe document that does not exist in the
repository). A deck written to EnSight Gold's own conventions, by people with no
stake in meshio++'s tables, is the stronger check — and here it immediately
caught a real defect that a self-written fixture would have papered over.

## Before 16.17.0 this format did not open at all

meshio++'s Fortran-binary detector looked for the literal string
`Fortran Binary` at byte 0 — where an EnSight record marker sits, not the
format name — so it never recognised the binary flavour, and the binary
*variable* files began with a `C Binary` record EnSight does not define (so
VTK and ParaView read none of meshio++'s variables). 16.17.0 fixed both. So the
format's *readability* is not the obstacle here; its boundary conversion is.

## What would unblock it

**Done — `src/meshioBoundary.ts`.** `convertToStlBoundary` used to trust its
surface conversion unconditionally. It now reads the source mesh once and
checks the produced boundary against it, on **both** paths — the native
`convertSurface` and the `extractSurface` fallback. (The guard sits outside the
converter's own `try`, so a refusal is never mistaken for the converter
declining the deck and retried through the fallback that reintroduces the same
wrong geometry.)

The check is a pure, unit-tested invariant: a boundary is built from the mesh's
own points, so its extent must match the source's on every non-degenerate axis.
Measured across the committed fixtures, a correct extraction is exactly 1.000 on
all three axes; EnSight is 0.500.

With the guard in place, routing `.case` yields a refusal rather than a wrong
picture:

```
meshio import error: the ensight boundary surface lost part of the geometry —
x: boundary spans 1 but the source spans 2 (ratio 0.500). The file's nodes were
read but the surface extracted from them does not cover them, so the model would
display incorrectly. This is a defect in the ensight reader or its surface
extraction, not in the file.
```

The guard is deliberately scoped to all meshio formats, and **none of the 15
currently-routed ones trip it** — MED, MDPA, GiD and Nastran all still load and
mesh exactly as before, verified against their committed fixtures. So the
class of silent-wrong-geometry is now closed for the formats already shipped,
and a new format gets checked for it by construction.


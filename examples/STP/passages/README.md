# Passage fixtures

Small STEP parts for the narrow-gap and passage preflight (`analyze_passages`,
the Passages panel). Each was built by CAD-Preview's own edit ops on an empty
base and exported through `exportBRep`, so the geometry is exact and known:

| File | What it contains | Expected diagnosis |
| --- | --- | --- |
| `annulus.stp` | A tube (R 10 / r 8, z 0–10) around a rod (r 7, z 1–9) | One **annular** passage, width **1 mm**, axial overlap 8 mm |
| `thin-slot.stp` | A 20 × 10 × 6 plate with a 0.5 mm through slot at x = 0 | One **slot**, width **0.5 mm**, overlap 6 mm |
| `disjoint-coaxial.stp` | A rod (r 5, z 0–10) and a tube (R 10 / r 6, z 20–30) on the same axis | **No** passage; the coaxial cylinder pair is reported as rejected (no axial overlap) |
| `annulus-inch.stp` | `annulus.stp` re-exported with an inch header | The same **1 mm** annulus (readers convert to mm) |

The tube's own wall (between its r 8 and R 10 faces) is solid material, not a
passage, and must never be reported.

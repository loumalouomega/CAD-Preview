# BREP fixtures

`blank.brep` — the empty compound File ▸ New Blank Model writes (192 bytes,
`buildPrimitivesFile([], "brep")` through the real pipeline: `TopoDS_Compound`
+ `BRep_Builder.MakeCompound`, no shapes). The base every bundled starter
macro (`macros/starter-library.json`) assumes: on an empty base the first
created face/edge/solid ids are deterministic (`face-0`, `edge-0`, …), which
is what lets a starter's sweep/pattern/boolean steps reference ids the macro
itself creates.

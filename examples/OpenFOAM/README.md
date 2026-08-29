# OpenFOAM fixtures

`hex-case/` — a minimal OpenFOAM case containing one unit hexahedron, written
by meshio++'s own OpenFOAM writer (v9.20.0+) so the committed files are exactly
what the library itself produces:

```
hex-case/
├── case.foam                  ← empty marker file (the ParaView convention)
└── constant/polyMesh/         ← the real mesh
    ├── points
    ├── faces
    ├── owner
    ├── neighbour
    └── boundary
```

A `.foam` file is **not** a mesh — it is a marker whose sibling
`constant/polyMesh/` directory holds the mesh (this is how ParaView opens
OpenFOAM cases too). CAD-Preview opens the marker; `meshioService.ts`'
`convertFoamCaseToStlBoundary` locates and stages the polyMesh siblings into
meshio++'s virtual filesystem itself.

The MCP smoke script (`scripts/mcp-smoke/run.mjs`) copies this case to its temp
directory and asserts `load_model` + `generate_mesh` work end-to-end: the hex's
boundary is 6 quad faces, fan-triangulated to 12 STL triangles.

Notes:

- Patch names (`boundary` file entries) are NOT preserved — meshio++ carries
  them through a C++ side-channel struct its JS binding does not expose, so an
  OpenFOAM import is geometry-only (no auto-created Parts).
- Field data (`U`, `p`, `T`, … in the case's time directories) is not read by
  meshio++ at all.

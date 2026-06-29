# File Formats

CAD Preview supports two classes of 3D files: **B-rep** (boundary representation) formats that require tessellation, and **mesh** formats that are already triangulated.

## Format Overview

| Format | Extensions | Pipeline | Grouped by solid |
|--------|-----------|----------|:---:|
| STEP | `.step`, `.stp` | OCCT → BRepMesh | ✅ |
| IGES | `.iges`, `.igs` | OCCT → BRepMesh | ✅ |
| BREP | `.brep` | OCCT → BRepMesh | ✅ |
| STL | `.stl` | Three.js STLLoader | — |
| OBJ | `.obj` | Three.js OBJLoader | per-object |
| PLY | `.ply` | Three.js PLYLoader | — |
| glTF | `.gltf`, `.glb` | Three.js GLTFLoader | per-mesh node |

## B-rep Formats (OCCT Pipeline)

B-rep files describe solid geometry analytically (surfaces, edges, vertices) rather than as triangles. CAD Preview tessellates them on-the-fly using [OpenCascade.js](https://ocjs.org/).

### Processing Steps

1. **Read** — the appropriate OCCT reader parses the file bytes:
   - STEP: `STEPControl_Reader_1`
   - IGES: `IGESControl_Reader_1`
   - BREP: `BRep_Builder` + `BRepTools::Read`
2. **Tessellate** — `BRepMesh_IncrementalMesh_2` with:
   - Linear deflection: `0.1`
   - Angular deflection: `0.5` (radians)
3. **Extract** — `TopExp_Explorer` walks the `TopoDS_Shape`, visiting each `TopoDS_Face`. For each face, the triangulation (`Poly_Triangulation`) is pulled from the location-transformed face and converted to WebGL-ready `Float32Array` positions and `Uint32Array` indices.
4. **Group** — faces are collected into `SolidGroup`s, one per top-level solid (`TopAbs_SOLID`). Each group becomes a separate `THREE.Mesh` in the webview, enabling per-solid highlighting.
5. **Encode** — positions and indices are base64-encoded and posted to the webview as `EncodedMesh` objects.

### Tessellation Quality

The linear deflection of `0.1` is a reasonable default for mechanical parts. Decrease it (e.g. `0.01`) for smoother curved surfaces at the cost of more triangles. This value is hardcoded in `src/meshExtract.ts`; it is not currently user-configurable.

### Solid Grouping

A `SolidGroup` maps to one `THREE.Mesh` child of the root `THREE.Group`. The `userData.groupId` property links it to the component tree panel for highlighting. Each group's `faceCount` is the number of OCCT faces (not triangles) that were extracted.

### STEP

STEP (ISO 10303) is the most common exchange format for CAD. CAD Preview reads AP203 and AP214 (and AP242 in practice). Shell assemblies, free surfaces, and wire edges are not rendered — only faces that yield a triangulation.

### IGES

IGES (Initial Graphics Exchange Specification) is an older format. The OCCT reader handles most IGES entity types but edge cases (trimmed surfaces, complex NURBS) may result in incomplete geometry.

### BREP

BREP is OpenCascade's native binary topology format. It reads fast and has no conversion artifacts. The `BRepTools::Read` function parses directly into a `TopoDS_Shape`.

---

## Mesh Formats (Three.js Pipeline)

Mesh files contain pre-triangulated geometry. The extension host resolves the file to a `vscode-webview://` URI via `webviewPanel.webview.asWebviewUri()` and posts it to the webview, which loads it directly with a Three.js loader.

### STL

Binary and ASCII STL are both supported via `STLLoader`. The result is a single `THREE.Mesh`. Vertex normals are embedded in the STL format; they are used as-is.

**Limitation:** STL has no material, color, or hierarchy. A default grey `MeshStandardMaterial` is applied.

### OBJ

`OBJLoader` produces a `THREE.Group` of meshes corresponding to the `o` / `g` groups in the OBJ file.

**Limitation:** `.mtl` material files are not loaded. If the OBJ file references an MTL, the material block is ignored and a default material is applied by `applyDefaultMaterial()` in `src/webview/meshLoaders.ts`.

### PLY

`PLYLoader` loads the file as a single `THREE.BufferGeometry`. If the PLY file lacks vertex normals, `computeVertexNormals()` is called automatically to generate smooth normals.

**Limitation:** Vertex colors in PLY are not currently applied to the material.

### glTF / GLB

`GLTFLoader` supports the full glTF 2.0 spec, including embedded textures, materials, and scene hierarchies. CAD Preview uses `gltf.scene` (the root `THREE.Group`) from the parsed result.

**Limitations:**
- Animation playback is not supported. Only the bind pose (frame 0) is rendered.
- The component tree is built from the `Object3D` name hierarchy, not from glTF extras.

---

## File Size Guidance

| Format | Practical limit | Notes |
|--------|----------------|-------|
| STEP / IGES | ~50 MB | Tessellation is CPU-bound in the extension host process |
| BREP | ~100 MB | Faster read than STEP/IGES; still tessellated |
| STL | ~200 MB | Binary STL loads fast; ASCII STL is much slower for large files |
| OBJ | ~100 MB | Parsing is text-based; large files may be slow |
| PLY | ~200 MB | Binary PLY is fast |
| glTF | ~100 MB | Depends on embedded texture size |

These are rough guidelines, not hard limits. Performance depends on vertex count after tessellation, not just file size.

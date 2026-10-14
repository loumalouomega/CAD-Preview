# A cantilever beam, from geometry to solver input

The smallest structural model there is: a beam fixed at one end and loaded at the other. This
tutorial takes it from an empty viewer to a Kratos MDPA file with the two regions a solver needs —
where it is clamped and where the load goes — and a handoff manifest that proves what was exported.

It is deliberately tiny so the numbers are checkable by hand. It takes about 10 minutes.

## Starting point

Open `examples/STP/block.stp` (the seed block described in the [overview](/tutorials/)).

## Step 1 — Add the beam

In the **Edits** panel add a **Box** with centre `0, 0, 0` and size `100, 10, 10`. It fully
encloses the seed block, which stays behind as `solid-0`; the beam is `solid-1`.

```parametric
[
  { "op": "addBox", "center": [0, 0, 0], "size": [100, 10, 10] }
]
```

Check it in the **Mass Properties** panel: select `solid-1` and read a volume of exactly
`10000 mm³` (100 × 10 × 10). For a mass as well, give a part containing it a density — see Step 3.

## Step 2 — Name the two regions

1. **Select ▾ → Selection mode → Surf**, then click the beam's end face at `x = −50`.
2. In the **Parts** panel click **＋ New**, rename it `FixedEnd`, and click **＋** on its row.
3. Repeat for the end face at `x = +50`, naming it `LoadFace`.

Headless, the same thing is two `set_part` calls (`surfaces` with the face ids that `inspect`
reports with normals `−X` and `+X`).

## Step 3 — Optional: a material

Make a part containing the beam (`solid-1`, assigned with Volume selection), and type `7.85` into its density field (or call `set_part` with `volumes: ["solid-1"]` and `material: "steel"`).
The BOM now reports the beam's mass: 10 cm³ × 7.85 g/cm³ = `78.5 g`.

## Step 4 — Mesh and export

In the **FE Mesh** panel keep **Dimension** at `3`, set **Size max** to `5`, press **Generate**,
then export **Kratos MDPA — Elements + Conditions**. Turn on the handoff manifest if you want a
checksummed record of the export.

In the `.mdpa`, both parts appear as sub-model-parts:

```
Begin SubModelPart FixedEnd
    Begin SubModelPartNodes
```

Every node listed under `FixedEnd` has `x = −50` exactly, and every `LoadFace` node `x = +50` —
the regions are on the faces you picked, not near them.

## What you practiced

- Building a part whose answer you can check by hand (a 10 000 mm³ beam).
- Naming boundary-condition regions as **parts**, and seeing them arrive as `SubModelPart`s.
- Material density and mass.
- The handoff manifest.

Next: the longer [FEA preparation tutorial](/tutorials/fea-prep) adds per-part mesh sizing and the
quality summary.

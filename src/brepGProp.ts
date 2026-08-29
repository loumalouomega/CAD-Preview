/**
 * The single shared entry point for OCCT's ADAPTIVE (eps-driven) `BRepGProp`
 * integration overloads — roadmap item "Mass properties may be using the
 * under-integrating `BRepGProp` overload", closed.
 *
 * **Why adaptive.** `BRepGProp`'s fixed-order quadrature under-integrates
 * faces trimmed by fitted B-spline pcurves — which is what a large fraction
 * of real imported STEP is made of. FluidCAD (the comparison project this
 * finding came from) measured ~7% volume error on real geometry because of
 * it. This codebase measured the disagreement directly against the live WASM:
 * on `examples/STP/bull.stp`, fixed-order gave 178421.48 vs adaptive 178448.05
 * at eps=1e-3 (**+0.0149%**) and 178454.45 at eps=1e-4 (+0.0185%) — small but
 * real, directionally consistent with under-integration, and exactly the
 * confidently-wrong-number failure mode `get_mass_properties`,
 * `compare_models`'s `volumeDeltaPct`, `check_interference`'s overlap volume,
 * `meshHeal`'s healed-volume delta, and `xcafTree`'s fingerprint volumes all
 * feed on.
 *
 * **Binding provenance, verified against the live build** (not assumed from
 * the manifest): stock opencascade.js ships `BRepGProp.hxx.patch`, which adds
 * `VolumeProperties2`/`SurfaceProperties2`/`VolumePropertiesGK2` — renamed
 * adaptive variants that exist purely because embind cannot disambiguate an
 * overload on `Standard_Real Eps` from one on `Standard_Boolean`. Probed:
 * all three are bound statics on `oc.BRepGProp`, and both used here work —
 * `VolumeProperties2(box, props, 1e-3, false, false)` returns exactly 24 on
 * the 2×3×4 reference box (no regression vs the fixed-order overload's own
 * verified value), and `SurfaceProperties2(shape, props, eps, skipShared)`
 * takes exactly 4 args in this binding.
 *
 * Every volume/surface integration site in the codebase goes through these
 * two wrappers so the eps and argument order can't drift between them
 * (`LinearProperties` is unaffected — edge length is not surface-quadrature).
 * Pure and WASM-free (the resolved `oc` module is passed in), so importing
 * this module introduces no kernel-service dependency cycle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Oc = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GProps = any;

/** Relative-error target handed to the adaptive overloads. `1e-3` balances
 * accuracy against cost: the adaptive integrator subdivides until the reached
 * relative error is below this, and the measured bull.stp delta between
 * eps=1e-3 and eps=1e-4 (~0.004%) is far below anything a consumer of these
 * numbers acts on. */
export const MASS_INTEGRATION_EPS = 1e-3;

/** Adaptive volume integration — the drop-in replacement for every
 * `oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false)` site. */
export function volumePropertiesAdaptive(oc: Oc, shape: unknown, props: GProps): number {
  return oc.BRepGProp.VolumeProperties2(shape, props, MASS_INTEGRATION_EPS, false, false);
}

/** Adaptive boundary-area integration — the drop-in replacement for every
 * `oc.BRepGProp.SurfaceProperties_1(shape, props, false, false)` site. */
export function surfacePropertiesAdaptive(oc: Oc, shape: unknown, props: GProps): number {
  return oc.BRepGProp.SurfaceProperties2(shape, props, MASS_INTEGRATION_EPS, false);
}

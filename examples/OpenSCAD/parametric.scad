// parametric.scad — a Customizer-style plate with a through hole.
//
// The top-level literals below (before the first module) are what OpenSCAD's
// Customizer shows, and what the `list_scad_parameters` MCP tool reads from
// this text without running openscad. `convert_scad` re-evaluates the file at
// other values via `-D name=value`, leaving this source untouched.
//
// Analytic volume at the defaults: width*depth*thickness minus the hole
// (a 24-sided prism, r = 3): 4000 - (24/2) * 3^2 * sin(2*pi/24) * 5 = 4000 - 139.75 = 3860.25.
// Widening the plate by 20 adds exactly 20*20*5 = 2000 (the hole is unaffected).

/* [Plate] */
// Plate width in mm
width = 40; // [10:5:100]
// Plate depth in mm
depth = 20; // [10:5:60]
// Plate thickness in mm
thickness = 5; // [1:1:20]

/* [Hole] */
// Radius of the through hole in mm
hole_radius = 3; // [1:0.5:8]
show_hole = true;
finish = "plain"; // [plain, chamfered:Chamfered edge]

/* [Hidden] */
$fn = 24;

module plate() {
  difference() {
    cube([width, depth, thickness], center = true);
    if (show_hole) cylinder(r = hole_radius, h = thickness + 2, center = true);
  }
}

plate();

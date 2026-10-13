// two-colour.scad — five disjoint cubes under color(): used to prove that
// color() becomes Parts on first open (one Part per distinct colour).
//   red  : 10^3 + 2^3  = 1008 mm3   (solid-0 and solid-4)
//   blue : 5^3  + 4^3  =  189 mm3   (solid-1, a vector colour under a translate,
//                                    and solid-2, a named colour above one)
//   none : 3^3         =   27 mm3   (solid-3 — outside any color(), no Part)
color("red") cube([10, 10, 10]);
translate([20, 0, 0]) color([0, 0, 1]) cube([5, 5, 5]);
color("blue") translate([40, 0, 0]) cube([4, 4, 4]);
translate([60, 0, 0]) cube([3, 3, 3]);
color("red") translate([0, 20, 0]) cube([2, 2, 2]);

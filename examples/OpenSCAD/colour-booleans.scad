// colour-booleans.scad — how colour survives boolean and nesting rules.
// Top-level solids, in order (the colour a Part is made from):
//   solid-0  red difference, 10^3 with a 3^3 pocket     = 973   red   (color() above the difference)
//   solid-1  union of two overlapping blue cubes        = 1875  blue  (every operand shared it)
//   solid-2  } union of a red and a blue cube           = 64 each, NO colour: a union of
//   solid-3  } differently coloured children is not blended (a warning says so)
//   solid-4  red cube inside a green group              = 8     red   (the INNERMOST color() wins)
//   solid-5  difference whose minuend is red            = 19    red   (OpenSCAD keeps the first child's colour)
color("red") difference() { cube(10); translate([2, 2, 2]) cube(3); }
translate([20, 0, 0]) color("blue") union() { cube(10); translate([5, 5, 5]) cube(10); }
translate([50, 0, 0]) union() { color("red") cube(4); translate([10, 0, 0]) color("blue") cube(4); }
translate([70, 0, 0]) color("green") { color("red") cube(2); }
translate([90, 0, 0]) difference() { color("red") cube(3); translate([1, 1, 1]) cube(3); }

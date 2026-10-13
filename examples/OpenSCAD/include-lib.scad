// include-lib.scad — the file include-main.scad pulls in. Editing it must
// reload / re-evaluate include-main.scad (include tracking + conversion cache).
plate_w = 20;
module plate() { cube([plate_w, 10, 5]); }

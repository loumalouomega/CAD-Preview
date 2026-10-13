// include-main.scad — a two-file model: the geometry comes from
// include-lib.scad. With plate_w = 20 the plate is 20 x 10 x 5 = 1000 mm3;
// changing plate_w in the library to 40 makes it 2000 mm3. Used to prove that
// an edited include is never served from a stale conversion cache.
include <include-lib.scad>
plate();

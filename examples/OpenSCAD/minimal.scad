// minimal.scad — the .scad counterpart of bracket.csg's shape vocabulary:
// cubes, a faceted cylinder hole, and a translated foot. With openscad
// installed (`openscad -o minimal.csg minimal.scad`) this converts to the
// equivalent of bracket.csg's evaluated tree (modulo $fn resolution), so a
// binary-present smoke run can cross-check structure and volume against the
// .csg oracle. Requires the openscad binary — never executed by tests.
group() {
  difference() {
    union() {
      cube(size = [20, 20, 10], center = true);
      cube(size = [10, 10, 10], center = false);
    }
    cylinder($fn = 10, r = 3, h = 12, center = true);
  }
  multmatrix([[1, 0, 0, 15], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
    cube(size = [10, 10, 10], center = true);
  }
}

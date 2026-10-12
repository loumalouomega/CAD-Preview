#!/bin/sh
# Test stub posing as `openscad` that emits caller-chosen stderr on a
# SUCCESSFUL conversion (see src/scadService.test.ts): the text of
# $STUB_STDERR is printed to stderr verbatim, then a canned .csg is written.
if [ "$1" = "--version" ]; then
  echo "OpenSCAD version stub-chatty for tests"
  exit 0
fi
if [ "$1" = "-o" ] && [ -n "$2" ] && [ -n "$3" ]; then
  if [ -n "$STUB_STDERR" ]; then
    printf '%s\n' "$STUB_STDERR" >&2
  fi
  printf '// stub-generated .csg\ncube(size = [10, 10, 10], center = true);\n' > "$2"
  exit 0
fi
echo "stub: unexpected argv: $*" >&2
exit 2

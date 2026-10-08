#!/bin/sh
# Test stub posing as `openscad`, recording the FULL argv (one argument per
# line) to $STUB_ARGV and the OPENSCADPATH it was started with to $STUB_ENV.
# Unlike openscad-stub.sh it accepts any flag order, since the conversion now
# passes --backend=... and repeated -D name=value before -o <out> <in>.
if [ "$1" = "--version" ]; then
  echo "OpenSCAD version stub-argv for tests"
  exit 0
fi
if [ -n "$STUB_ARGV" ]; then printf '%s\n' "$@" > "$STUB_ARGV"; fi
if [ -n "$STUB_ENV" ]; then printf '%s' "$OPENSCADPATH" > "$STUB_ENV"; fi
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
if [ -z "$out" ]; then echo "stub: no -o given" >&2; exit 2; fi
if [ -n "$STUB_FAIL_STDERR" ]; then echo "$STUB_FAIL_STDERR" >&2; exit 1; fi
printf '// stub\ncube(size = [10, 10, 10], center = true);\n' > "$out"
exit 0

#!/bin/sh
# Test stub posing as `openscad` for the conversion-cache tests
# (src/scadService.test.ts). Unlike the other stubs it:
#   - appends one line to $STUB_COUNT per conversion, so a test can assert how
#     many times the binary was ACTUALLY spawned (the cache's whole point);
#   - writes a Make-style dependency file (the format captured from real
#     OpenSCAD 2021.01: `<out>: \` then tab-indented, backslash-continued paths
#     with the source last) listing the space-separated paths in $STUB_DEPS,
#     unless $STUB_NO_DEPFILE is set;
#   - emits a cube whose size is the spawn number, so a cached result and a
#     fresh one are distinguishable by content;
#   - prints $STUB_WARN to stderr when set.
if [ "$1" = "--version" ]; then
  echo "OpenSCAD version stub-deps for tests"
  exit 0
fi
out=""; dep=""; src=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -d) dep="$2"; shift ;;
    -D) shift ;;
    -*) ;;
    *) src="$1" ;;
  esac
  shift
done
if [ -z "$out" ]; then echo "stub: no -o given" >&2; exit 2; fi
n=1
if [ -n "$STUB_COUNT" ]; then
  if [ -f "$STUB_COUNT" ]; then n=$(( $(wc -l < "$STUB_COUNT") + 1 )); fi
  echo spawn >> "$STUB_COUNT"
fi
printf '// stub-deps spawn %s\ncube(size = [%s, %s, %s], center = true);\n' "$n" "$n" "$n" "$n" > "$out"
if [ -n "$STUB_WARN" ]; then echo "$STUB_WARN" >&2; fi
if [ -n "$dep" ] && [ -z "$STUB_NO_DEPFILE" ]; then
  {
    printf '%s: \\\n' "$out"
    for d in $STUB_DEPS; do printf '\t%s \\\n' "$d"; done
    printf '\t%s\n' "$src"
  } > "$dep"
fi
exit 0

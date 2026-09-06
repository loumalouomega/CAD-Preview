#!/bin/sh
# Test stub posing as the `openscad` binary (see src/scadService.test.ts).
# Supports the two invocations scadService.ts makes:
#   <stub> --version            -> prints a version, exit 0
#   <stub> -o <out.csg> <in>    -> writes canned .csg to <out.csg>, one
#                                  stderr warning line, exit 0
# Optionally records (argv, cwd) as JSON to $STUB_RECORD for plumbing
# assertions (arg shape, output extension, input path, working directory).
if [ "$1" = "--version" ]; then
  echo "OpenSCAD version stub-1 for tests"
  exit 0
fi
if [ "$1" = "-o" ] && [ -n "$2" ] && [ -n "$3" ]; then
  if [ -n "$STUB_RECORD" ]; then
    printf '{"argv":["%s","%s","%s"],"cwd":"%s"}\n' "$1" "$2" "$3" "$(pwd)" > "$STUB_RECORD"
  fi
  printf '// stub-generated .csg\ncube(size = [10, 10, 10], center = true);\n' > "$2"
  echo "stub: converted $3" >&2
  exit 0
fi
echo "stub: unexpected argv: $*" >&2
exit 2

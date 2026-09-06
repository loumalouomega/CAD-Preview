#!/bin/sh
# Test stub posing as a BROKEN `openscad` binary: always fails with a
# realistic stderr diagnostic, exit 1. Exercises scadService.ts's
# non-zero-exit error mapping (message carries the stderr tail).
echo "ERROR: Can't open input file 'missing.scad': No such file or directory" >&2
echo "ERROR: Failed to parse" >&2
exit 1

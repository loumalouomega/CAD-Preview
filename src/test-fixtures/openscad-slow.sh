#!/bin/sh
# Test stub posing as a HUNG `openscad` binary: never produces output.
# Exercises scadService.ts's timeout-kill path (tests pass timeoutMs ~200ms,
# so this 30s sleep never completes — the child must be killed).
sleep 30
exit 0

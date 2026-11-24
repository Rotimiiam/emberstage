#!/bin/sh
# Drift check: regenerate maps in a private temp dir and diff the committed baselines.
# Exit 0 = MAPS_CURRENT, exit 1 = MAP_DRIFT. Never modifies the working tree.
set -u

tmp=$(mktemp -d "${TMPDIR:-/tmp}/emberstage-map-check.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

sh scripts/gen-maps.sh "$tmp" || { printf 'MAP_CHECK_ERROR: generator failed\n' >&2; exit 2; }

status=0
for name in CODE_MAP.md INFRA_MAP.md; do
  if [ ! -f "docs/$name" ]; then
    printf 'MAP_DRIFT: docs/%s is missing\n' "$name"
    status=1
    continue
  fi
  if ! diff -u "docs/$name" "$tmp/$name"; then
    printf 'MAP_DRIFT: %s does not match current sources\n' "$name"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  printf 'MAPS_CURRENT\n'
else
  printf 'MAP_DRIFT: run sh scripts/gen-maps.sh to update the committed baselines\n' >&2
fi
exit "$status"

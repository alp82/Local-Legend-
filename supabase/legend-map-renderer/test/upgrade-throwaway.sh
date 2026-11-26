#!/usr/bin/env bash
# Runs test/upgrade.test.mjs in a throwaway local Supabase stack of its own: project
# "ll-upgrade" on ports 643xx, in a temporary folder with this repository's config and
# migrations. Never the shared stack (project "local-legend", ports 543xx), which the test
# refuses anyway. The stack and its data are deleted afterwards, also on failure.
#
#   bash supabase/legend-map-renderer/test/upgrade-throwaway.sh
set -euo pipefail

renderer=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$renderer/../.." && pwd)
if command -v supabase >/dev/null; then cli=(supabase); else cli=(npx --no-install supabase); fi

work=$(mktemp -d)
cleanup() {
  "${cli[@]}" stop --no-backup --workdir "$work" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/supabase/migrations"
cp "$repo"/supabase/migrations/*.sql "$work/supabase/migrations/"
sed -E -e 's/^project_id = .*/project_id = "ll-upgrade"/' \
  -e 's/^((shadow_)?port = )543([0-9]{2})$/\1643\3/' \
  "$repo/supabase/config.toml" > "$work/supabase/config.toml"
if grep -vE '^\s*#' "$work/supabase/config.toml" | grep -qE '= 543[0-9]{2}$'; then
  echo "a port of the shared stack is left in the throwaway config" >&2
  exit 1
fi

"${cli[@]}" start --workdir "$work" -x studio,imgproxy,mailpit,logflare,vector,supavisor,edge-runtime >/dev/null
cd "$renderer"
UPGRADE_TEST=on UPGRADE_WORKDIR="$work" node --test test/upgrade.test.mjs

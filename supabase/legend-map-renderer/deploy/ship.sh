#!/usr/bin/env bash
# The manual fallback, for when the registry or Coolify is unavailable. Normally releases go out
# by themselves: a merge to main builds and pushes the image, and Coolify pulls it
# (docs/legend-map-deploy.md, "Releases").
#
# Builds the worker image from the committed renderer folder, copies it to the host over
# ssh (docker save | docker load, no registry), installs compose.yaml, and points .env at
# the new image. It does NOT start or restart anything: the runbook does that.
#
#   deploy/ship.sh user@host
#
# The image is tagged with the commit it was built from. The host keeps earlier tags, so a
# rollback is: set the previous image in .env and run docker compose up -d.
set -euo pipefail

HOST=${1:?usage: deploy/ship.sh user@host}
DIR=/opt/legend-map-renderer
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)

if [ -n "$(git -C "$REPO" status --porcelain -- supabase/legend-map-renderer)" ]; then
  echo "supabase/legend-map-renderer has uncommitted changes; commit them first" >&2
  exit 1
fi
TAG=$(git -C "$REPO" rev-parse --short=12 HEAD)
IMAGE=legend-map-renderer:$TAG

# Build from exactly the committed files (git archive), never from a working tree with
# out/, .source/ or node_modules in it.
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
git -C "$REPO" archive HEAD supabase/legend-map-renderer | tar -x -C "$BUILD"
docker build -t "$IMAGE" "$BUILD/supabase/legend-map-renderer"

echo "copying $IMAGE to $HOST (about 1 GB compressed)"
docker save "$IMAGE" | gzip -1 | ssh "$HOST" 'gunzip | docker load'

ssh "$HOST" "mkdir -p $DIR && test -f $DIR/worker.env || echo 'note: $DIR/worker.env is missing (see worker.env.example)'"
scp "$HERE/deploy/compose.yaml" "$HERE/deploy/worker.env.example" "$HERE/src/egress-proxy.mjs" "$HOST:$DIR/"
# Only the image line changes; the other settings in .env (host, memory) stay.
ssh "$HOST" "cd $DIR && touch .env && cp .env .env.previous && { grep -v '^LEGEND_MAP_RENDERER_IMAGE=\|^LEGEND_MAP_EGRESS_SCRIPT=' .env.previous; echo LEGEND_MAP_RENDERER_IMAGE=$IMAGE; echo LEGEND_MAP_EGRESS_SCRIPT=./egress-proxy.mjs; } > .env && { docker compose config --quiet || echo 'compose check failed: are worker.env and LEGEND_MAP_SUPABASE_HOST in .env there?'; }"
echo "shipped $IMAGE; the previous .env is saved as $DIR/.env.previous. Start or restart with:"
echo "  ssh $HOST 'cd $DIR && docker compose up -d'"

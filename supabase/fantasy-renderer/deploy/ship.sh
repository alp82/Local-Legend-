#!/usr/bin/env bash
# Builds the worker image from the committed renderer folder, copies it to the host over
# ssh (docker save | docker load, no registry), installs compose.yaml, and points .env at
# the new tag. It does NOT start or restart anything: the runbook does that
# (docs/fantasy-map-deploy.md).
#
#   deploy/ship.sh user@host
#
# The image is tagged with the commit it was built from. The host keeps earlier tags, so a
# rollback is: set the previous tag in .env and run docker compose up -d.
set -euo pipefail

HOST=${1:?usage: deploy/ship.sh user@host}
DIR=/opt/fantasy-renderer
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)

if [ -n "$(git -C "$REPO" status --porcelain -- supabase/fantasy-renderer)" ]; then
  echo "supabase/fantasy-renderer has uncommitted changes; commit them first" >&2
  exit 1
fi
TAG=$(git -C "$REPO" rev-parse --short=12 HEAD)
IMAGE=fantasy-renderer:$TAG

# Build from exactly the committed files (git archive), never from a working tree with
# out/, .source/ or node_modules in it.
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
git -C "$REPO" archive HEAD supabase/fantasy-renderer | tar -x -C "$BUILD"
docker build -t "$IMAGE" "$BUILD/supabase/fantasy-renderer"

echo "copying $IMAGE to $HOST (about 1 GB compressed)"
docker save "$IMAGE" | gzip -1 | ssh "$HOST" 'gunzip | docker load'

ssh "$HOST" "mkdir -p $DIR && test -f $DIR/worker.env || echo 'note: $DIR/worker.env is missing (see worker.env.example)'"
scp "$HERE/deploy/compose.yaml" "$HERE/deploy/worker.env.example" "$HOST:$DIR/"
ssh "$HOST" "cd $DIR && { grep -s '^FANTASY_RENDERER_TAG=' .env || true; } > .env.previous && echo FANTASY_RENDERER_TAG=$TAG > .env && { docker compose config --quiet || echo 'compose check failed: is worker.env there?'; }"
echo "shipped $IMAGE; previous tag saved in $DIR/.env.previous. Start or restart with:"
echo "  ssh $HOST 'cd $DIR && docker compose up -d'"

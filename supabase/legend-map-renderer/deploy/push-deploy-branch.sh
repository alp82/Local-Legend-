#!/usr/bin/env bash
# Renders the deploy tree (deploy/render-deploy.mjs) and pushes it to the legend-map-deploy branch with
# the protected environment's deploy key, the only key a ruleset lets update that branch. Called by the release
# workflow (--record: a new release) and the rollback workflow (an earlier, recorded one). Coolify deploys the
# branch.
#
# Environment: DEPLOY_KEY (private key), REPO (owner/name), IMAGE (ghcr.io/… without tag), DIGEST, FINGERPRINT,
# SHA (the commit the image was built from), RUN (run URL), and optionally RENDER (the render-deploy.mjs to use:
# the rollback passes the one of the image's own commit).
set -euo pipefail

BRANCH=legend-map-deploy
RENDER=${RENDER:-$(cd "$(dirname "$0")" && pwd)/render-deploy.mjs}
for v in DEPLOY_KEY REPO IMAGE DIGEST FINGERPRINT SHA RUN; do
  [ -n "${!v:-}" ] || { echo "push-deploy-branch: $v is not set" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077
printf '%s\n' "$DEPLOY_KEY" > "$work/key"
# GitHub's published host key (https://api.github.com/meta), not whatever answers
echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$work/known_hosts"
export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$work/known_hosts -o StrictHostKeyChecking=yes"
umask 022

remote=${DEPLOY_REMOTE:-git@github.com:$REPO.git} # (DEPLOY_REMOTE: a local bare repository, for testing)
if git ls-remote --exit-code --heads "$remote" "$BRANCH" > /dev/null; then
  git clone --quiet --depth 50 --branch "$BRANCH" "$remote" "$work/tree"
else
  git init --quiet "$work/tree"
  git -C "$work/tree" checkout --quiet --orphan "$BRANCH"
  git -C "$work/tree" remote add origin "$remote"
fi

node "$RENDER" --out "$work/tree" --image "$IMAGE" --digest "$DIGEST" --commit "$SHA" --fingerprint "$FINGERPRINT" --run "$RUN" "$@"

cd "$work/tree"
git add -A
git -c user.name='legend-map-renderer release' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit --quiet -m "Deploy $IMAGE@$DIGEST (painter $FINGERPRINT, from ${SHA:0:12})" -m "$RUN"
git push --quiet origin "HEAD:$BRANCH"
echo "legend-map-deploy now deploys $IMAGE@$DIGEST"

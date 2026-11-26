#!/usr/bin/env bash
# Builds and (re)starts Licence Reporting in local Docker Desktop, for trying changes before deploying.
#
#   deploy/sandbox/run.sh           build from the working tree and restart, keeping the sandbox's data
#   deploy/sandbox/run.sh --reset   also wipe the sandbox's data (fresh made-up history)
#   deploy/sandbox/run.sh --public  public sources instead of Artifactory (sandbox only; needs approval): the official
#                                   Node image from Docker Hub pinned by digest, and packages from registry.npmjs.org
#                                   checked against the lockfile's integrity hashes. Combine with --reset as needed.
#   deploy/sandbox/run.sh --reset --demo-cato
#                                   fresh data whose made-up history includes a Cato group, to preview the Cato page
#                                   (only affects a fresh data volume, so use it with --reset)
#
# Needs: Docker signed in to Artifactory (docker login artifactory.hermes.uk.net), and an npm config with your
# Artifactory credentials at ~/.npmrc or $NPM_CONFIG_USERCONFIG (passed to the build as a secret, never stored).
# Cato: enter the account ID and API key in the app (Admin › Settings › Cato API). Alternatively, an app.env-style
# file at ~/.config/licence-reporting/sandbox.env (see sandbox.env.example), or $CATO_ENV_FILE.
#
# Opens on http://localhost:3003 (this Mac only), with development sign-in: choose Admin or Viewer.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
RESET=0; PUBLIC=0; DEMO_CATO=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --public) PUBLIC=1 ;;
    --demo-cato) DEMO_CATO=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
BASE_IMAGE="artifactory.hermes.uk.net/docker-all/node:24-trixie-slim"
# The official image on Docker Hub, pinned (node:24-trixie-slim, Node 24.22.3, created 2026-11-11)
PUBLIC_BASE_IMAGE="docker.io/library/node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0"
NAME="licence-reporting-sandbox"
VOLUME="licence-reporting-sandbox-data"
PORT="${SANDBOX_PORT:-3003}"
NPMRC="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
CATO_ENV="${CATO_ENV_FILE:-$HOME/.config/licence-reporting/sandbox.env}"

BUILD_ARGS=()
if [[ "$PUBLIC" == 1 ]]; then
  echo "Using public sources (sandbox only): Docker Hub and registry.npmjs.org"
  PINNED="$PUBLIC_BASE_IMAGE"
  BUILD_ARGS+=(--build-arg NPM_SOURCE=public)
else
  if [[ ! -f "$NPMRC" ]]; then
    echo "Error: no npm config with Artifactory credentials at $NPMRC." >&2
    echo "Create it from Artifactory's Set Me Up (npm, npm-all), or set NPM_CONFIG_USERCONFIG to its path." >&2
    exit 1
  fi
  echo "Resolving the Node.js base image through Artifactory..."
  if ! docker pull --quiet "$BASE_IMAGE" >/dev/null; then
    echo "Error: could not pull $BASE_IMAGE. Sign in first: docker login artifactory.hermes.uk.net" >&2
    exit 1
  fi
  PINNED="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$BASE_IMAGE" | grep '^artifactory.hermes.uk.net/docker-all/node@' | head -1)"
  if [[ -z "$PINNED" ]]; then echo "Error: no digest for $BASE_IMAGE" >&2; exit 1; fi
  BUILD_ARGS+=(--secret "id=npmrc,src=$NPMRC")
fi
echo "Base image: $PINNED"

TAG="sandbox-$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . 2>/dev/null || echo '-dirty')"
IMAGE="licence-reporting:$TAG"
echo "Building $IMAGE..."
docker build -f deploy/sandbox/Dockerfile --build-arg "NODE_IMAGE=$PINNED" "${BUILD_ARGS[@]}" -t "$IMAGE" .

docker rm -f "$NAME" >/dev/null 2>&1 || true
if [[ "$RESET" == 1 ]]; then
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  echo "Wiped the sandbox data."
fi

ARGS=(-d --name "$NAME" -p "127.0.0.1:$PORT:3080" -v "$VOLUME:/data" --restart unless-stopped)
if [[ "$DEMO_CATO" == 1 ]]; then ARGS+=(-e SANDBOX_DEMO_CATO=1); fi
if [[ -f "$CATO_ENV" ]]; then
  ARGS+=(-v "$CATO_ENV:/run/secrets/app.env:ro" -e APP_CONFIG=/run/secrets/app.env)
  echo "Cato settings: $CATO_ENV (mounted read-only)"
else
  echo "No $CATO_ENV: enter the Cato account ID and API key in the app (Admin › Settings › Cato API)."
fi
docker run "${ARGS[@]}" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker logs "$NAME" 2>&1 | grep -q 'listening'; then
    echo "Licence Reporting sandbox is running: http://localhost:$PORT  (image $IMAGE)"
    exit 0
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]]; then break; fi
  sleep 1
done
echo "Error: the app didn't start. Last log lines:" >&2
docker logs --tail 40 "$NAME" >&2
exit 1

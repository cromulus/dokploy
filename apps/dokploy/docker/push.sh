#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "$REPO_ROOT"

# Determine the type of build based on the first script argument
BUILD_TYPE=${1:-production}
IMAGE_NAME=${IMAGE_NAME:-dokploy/dokploy}
DOCKER_PLATFORMS=${DOCKER_PLATFORMS:-linux/amd64,linux/arm64}

BUILDER=$(docker buildx create --use)
cleanup() {
    docker buildx rm "$BUILDER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

BUILD_TAG_ARGS=()

if [ -n "${IMAGE:-}" ]; then
    echo "PUSHING CUSTOM IMAGE ${IMAGE}"
    BUILD_TAG_ARGS+=(-t "${IMAGE}")
elif [ -n "${IMAGE_TAG:-}" ]; then
    echo "PUSHING ${IMAGE_NAME}:${IMAGE_TAG}"
    BUILD_TAG_ARGS+=(-t "${IMAGE_NAME}:${IMAGE_TAG}")
elif [ "$BUILD_TYPE" == "canary" ]; then
    TAG="canary"
    echo "PUSHING CANARY ${IMAGE_NAME}:${TAG}"
    BUILD_TAG_ARGS+=(-t "${IMAGE_NAME}:${TAG}")
else
    echo "PUSHING PRODUCTION ${IMAGE_NAME}"
    VERSION=$(node -p "require('./apps/dokploy/package.json').version")
    BUILD_TAG_ARGS+=(-t "${IMAGE_NAME}:latest" -t "${IMAGE_NAME}:${VERSION}")
fi

docker buildx build --platform "$DOCKER_PLATFORMS" --pull --rm "${BUILD_TAG_ARGS[@]}" -f 'Dockerfile' --push .

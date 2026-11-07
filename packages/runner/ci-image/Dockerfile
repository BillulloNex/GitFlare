# Reference CI job image for GitFlare: node:22-bookworm plus git-lfs, so
# `checkout.lfs` can fetch large files (packages/runner/src/docker.ts).
# Built and pushed by .github/workflows/deploy.yml when this file changes:
#   ghcr.io/<owner>/gitflare-ci:node22
# Point the runner at it with CI_IMAGE (packages/runner/docker-compose.yml).
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git-lfs \
 && rm -rf /var/lib/apt/lists/* \
 && git lfs version

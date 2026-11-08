# Default CI job image for GitFlare: node:22-bookworm plus git-lfs, so
# `checkout.lfs` can fetch large files (packages/runner/src/docker.ts).
# The runner builds it on its host's Docker daemon at startup as
# gitflare-ci:node22 when CI_IMAGE is unset; set CI_IMAGE to use another image.
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git-lfs \
 && rm -rf /var/lib/apt/lists/* \
 && git lfs version

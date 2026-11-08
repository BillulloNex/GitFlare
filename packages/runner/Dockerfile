# GitFlare runner. Build context: packages/runner/
#
# The runner does NOT execute CI commands itself: it drives throwaway job
# containers through the host Docker socket (see docker-compose.yml). It needs
# the docker CLI and git (for diagnostics); job images bring their own git.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npx tsc

FROM node:22-alpine
RUN apk add --no-cache git docker-cli tini
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist/
# Default CI job image recipe (node + git-lfs); built on the host daemon at
# startup unless CI_IMAGE is set (src/docker.ts ensureDefaultCiImage).
COPY ci-image/ ./ci-image/

ENV NODE_ENV=production \
    PORT=7654 \
    DOCKER_CONFIG=/tmp/.docker

# Non-root. Socket access comes from the socket's group, mapped at runtime
# (`group_add` in docker-compose.yml).
USER node

EXPOSE 7654
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

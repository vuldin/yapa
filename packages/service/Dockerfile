# YAPA sync service image. Build from the REPO ROOT (workspace lockfile):
#   docker build -f packages/service/Dockerfile -t yapa-service .
# The base comes from Google's Docker Hub mirror (reliable from Cloud Build);
# override NODE_IMAGE to pin a digest.
ARG NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim

# ---- build: compile TypeScript ----------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/dsh/package.json packages/dsh/
COPY packages/service/package.json packages/service/
RUN npm ci --workspace packages/service --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/service/tsconfig.json packages/service/
COPY packages/service/src packages/service/src
RUN npm run build --workspace packages/service

# ---- deps: production dependencies only -------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/dsh/package.json packages/dsh/
COPY packages/service/package.json packages/service/
RUN npm ci --workspace packages/service --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf node_modules/@yapa node_modules/.package-lock.json \
 && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/packages/service/dist ./dist
COPY --chown=root:root packages/service/package.json ./package.json
# Files stay root-owned and read-only for the runtime user.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

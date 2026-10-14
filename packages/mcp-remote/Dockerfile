# YAPA remote MCP image (yapa-mcp). Build from the REPO ROOT (workspace lockfile):
#   docker build -f packages/mcp-remote/Dockerfile -t yapa-mcp .
# Same base and layout as packages/service/Dockerfile, plus the embedding
# model baked in at build time (read-only, no download at start).
ARG NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim

# ---- build: compile core, service (library) and mcp-remote ------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/dsh/package.json packages/dsh/
COPY packages/service/package.json packages/service/
COPY packages/mcp-remote/package.json packages/mcp-remote/
RUN npm ci --workspace packages/mcp-remote --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/service/tsconfig.json packages/service/
COPY packages/service/src packages/service/src
COPY packages/mcp-remote/tsconfig.json packages/mcp-remote/
COPY packages/mcp-remote/src packages/mcp-remote/src
COPY packages/mcp-remote/scripts packages/mcp-remote/scripts
RUN npm run build --workspace packages/core \
 && npm run build --workspace packages/service \
 && npm run build --workspace packages/mcp-remote

# ---- model: download Xenova/all-MiniLM-L6-v2 (q8) into /app/models ----------
FROM build AS model
RUN node packages/mcp-remote/scripts/fetch-model.mjs /app/models

# ---- deps: production dependencies only -------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/dsh/package.json packages/dsh/
COPY packages/service/package.json packages/service/
COPY packages/mcp-remote/package.json packages/mcp-remote/
# Workspace links (node_modules/@yapa/* -> packages/*) are kept: core and
# service are imported as libraries and their dist is copied below.
# Cloud Run is linux/x64 (glibc): drop onnxruntime and sharp binaries for
# other platforms (~250 MB).
RUN npm ci --workspace packages/mcp-remote --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf node_modules/.package-lock.json \
    node_modules/onnxruntime-node/bin/napi-v*/darwin \
    node_modules/onnxruntime-node/bin/napi-v*/win32 \
    node_modules/onnxruntime-node/bin/napi-v*/linux/arm64 \
    node_modules/@img/sharp-wasm32 \
    node_modules/@img/*linuxmusl* \
 && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    YAPA_MCP_MODEL_DIR=/app/models \
    YAPA_MCP_ALLOW_REMOTE_MODELS=false
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=root:root /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=root:root /app/packages/service/package.json ./packages/service/package.json
COPY --from=build --chown=root:root /app/packages/service/dist ./packages/service/dist
COPY --from=build --chown=root:root /app/packages/mcp-remote/package.json ./packages/mcp-remote/package.json
COPY --from=build --chown=root:root /app/packages/mcp-remote/dist ./packages/mcp-remote/dist
COPY --from=model --chown=root:root /app/models ./models
# Files (and the model cache) stay root-owned and read-only for the runtime user.
RUN chmod -R a-w /app/models
USER node
EXPOSE 8080
CMD ["node", "packages/mcp-remote/dist/server.js"]

# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.

FROM node:24.16.0-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
ENV npm_config_registry=${NPM_REGISTRY} \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /build
RUN corepack disable && npm install --global pnpm@10.34.3
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
# Install just the pinned media binary; do not run desktop dependency scripts.
RUN pnpm --filter @huabu/server exec node -e "require('ffmpeg-static/install.js')"
RUN pnpm run build:web
RUN mkdir -p /runtime/apps/server /runtime/apps/web /runtime/scripts \
        /runtime/packages/client-runtime/dist /runtime/node_modules \
    && cp -R apps/server/dist-bundle /runtime/apps/server/ \
    && cp -R apps/web/dist /runtime/apps/web/ \
    && cp scripts/start-web.mjs /runtime/scripts/ \
    && cp packages/client-runtime/dist/bootstrap.js /runtime/packages/client-runtime/dist/ \
    && cp -RL node_modules/dotenv /runtime/node_modules/dotenv \
    && printf '{"private":true,"type":"module"}\n' > /runtime/package.json

FROM base AS runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/microsoft/Huabu" \
    org.opencontainers.image.revision=${SOURCE_REVISION} \
    org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    SERVER_PORT=8080 \
    HUABU_BIND_HOST=0.0.0.0 \
    HUABU_DATA_DIR=/home/huabu-data \
    HUABU_CONFIG_DIR=/home/huabu-config \
    HUABU_DEPLOYED_SHA=${SOURCE_REVISION}
WORKDIR /app
COPY --from=build /runtime/ ./
RUN mkdir -p /home/huabu-data /home/huabu-config \
    && chown node:node /home/huabu-data /home/huabu-config \
    && chmod 0700 /home/huabu-config
USER node
EXPOSE 8080
CMD ["node", "scripts/start-web.mjs"]

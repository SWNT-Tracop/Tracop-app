# syntax=docker/dockerfile:1
# TRACOP API and worker image: one image for the API (`dist/main.js`), the worker
# (`dist/worker.js`) and the migrations (`dist/drizzle/migrate.js`).
# Node 22 LTS on Debian slim: sharp ships prebuilt libvips for glibc.
FROM node:22.23.1-bookworm-slim AS build
ENV PNPM_HOME=/pnpm CI=true HUSKY=0
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild sharp
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @tracop/contracts build && pnpm --filter @tracop/api build

# Only production dependencies reach the runtime image: no jest, tsx, drizzle-kit or eslint.
FROM node:22.23.1-bookworm-slim AS production-dependencies
ENV PNPM_HOME=/pnpm CI=true HUSKY=0
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm rebuild sharp

FROM node:22.23.1-bookworm-slim AS runtime
# The release workflow passes the git tag; `docker inspect` and the deploy script read it.
ARG APP_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="tracop-api" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/SWNT-Tracop/Tracop-app"
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
# Never run as root; the image has no secrets: everything comes from the environment.
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]

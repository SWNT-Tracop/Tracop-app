# syntax=docker/dockerfile:1
# TRACOP API and worker image (one image, two commands). Used by docker-compose.demo.yml.
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

FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# Never run as root; the image has no secrets: everything comes from the environment.
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]

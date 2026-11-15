# One image for every service. Node runs the TypeScript sources directly, so
# there is no build step: the image is the repository plus its dependencies.
#
# The base is pinned to a digest: the tag names a version, and the digest
# names the exact bytes that were tested.
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

RUN corepack enable && corepack prepare pnpm@11.28.11 --activate \
  && mkdir /state /app && chown node:node /state /app

WORKDIR /app
COPY --chown=node:node . .
USER node
# No install scripts run: the only one in this repository sets up git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts

ENV NODE_ENV=production HOST=0.0.0.0

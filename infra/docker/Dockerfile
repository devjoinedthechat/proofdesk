# One image for every service. Node runs the TypeScript sources directly, so
# there is no build step: the image is the repository plus its dependencies.
#
# The base is pinned to a digest: the tag names a version, and the digest
# names the exact bytes that were tested.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN corepack enable && corepack prepare pnpm@11.28.11 --activate \
  && mkdir /state /app && chown node:node /state /app

WORKDIR /app
COPY --chown=node:node . .
USER node
# No install scripts run: the only one in this repository sets up git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts

ENV NODE_ENV=production HOST=0.0.0.0

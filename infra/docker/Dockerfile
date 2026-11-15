# One image for every service. Node runs the TypeScript sources directly, so
# there is no build step: the image is the repository plus its dependencies.
#
# The base is pinned to a digest: the tag names a version, and the digest
# names the exact bytes that were tested.
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

RUN corepack enable && corepack prepare pnpm@11.28.11 --activate \
  && mkdir /state /app && chown node:node /state /app

WORKDIR /app
COPY --chown=node:node . .
USER node
# No install scripts run: the only one in this repository sets up git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts

ENV NODE_ENV=production HOST=0.0.0.0

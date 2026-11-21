# The TypeScript toolchain. Build context: the repository root (see /.dockerignore).
#
#   base      the pinned Node image, /repo owned by node, user node
#   deps      base + root manifests + npm ci (lockfile must match package.json)
#   check     deps + the repository's source; default command runs the check
#   lock      base + package.json (+ existing lockfile); resolves package-lock.json
#   lockfile  only package-lock.json, for `docker build --output type=local` (toolchain/lock.sh)

# node:22-bookworm-slim (Node 22.23.5), pinned by digest; the same digest as model/gate/compose.yaml
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base
RUN mkdir /repo && chown node:node /repo
WORKDIR /repo
USER node

FROM base AS deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS check
COPY . .
CMD ["npm", "run", "check"]

# What a piece runs with: the dependencies it needs at run time, without the check's tools.
FROM base AS run-deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# One piece, ready to run. PIECE is the piece's folder, relative to the repository root.
# The image gets that piece's src/ and the source files at the top of shared/ (shared/*.ts, not its tests), and
# nothing else of the repository.
# Node runs the TypeScript directly, so there is no compile step. The command is set by the piece's compose file.
FROM run-deps AS run
ARG PIECE
USER root
RUN test -n "$PIECE" && mkdir /data && chown node:node /data
USER node
COPY --chown=node:node shared/*.ts ./shared/
COPY --chown=node:node ${PIECE}/src ./${PIECE}/src

# The React app of a piece that has one, in its web/ folder, built to static files.
FROM deps AS web-build
ARG PIECE
RUN test -n "$PIECE"
COPY --chown=node:node shared/*.ts ./shared/
COPY --chown=node:node ${PIECE}/shared ./${PIECE}/shared
COPY --chown=node:node ${PIECE}/web ./${PIECE}/web
RUN npx vite build --config ${PIECE}/web/vite.config.ts --configLoader native

# A piece with a server and a React app: the run stage, plus the built static files for the server to hand out.
FROM run AS run-web
ARG PIECE
COPY --chown=node:node ${PIECE}/shared ./${PIECE}/shared
COPY --from=web-build --chown=node:node /repo/${PIECE}/web/dist ./${PIECE}/web/dist

FROM base AS lock
# The glob copies package-lock.json too when it exists, so versions already locked do not move.
COPY --chown=node:node package*.json ./
# Some unresolvable inputs (for example a version that also breaks a peer range) make npm print an
# ERESOLVE warning and never exit. The time limit turns that into a failed build, so lock.sh exits
# non-zero and leaves the existing package-lock.json as it was.
ARG LOCK_TIMEOUT_SECONDS=300
RUN timeout "$LOCK_TIMEOUT_SECONDS" npm install --package-lock-only --ignore-scripts --no-audit --no-fund

FROM scratch AS lockfile
COPY --from=lock /repo/package-lock.json /package-lock.json

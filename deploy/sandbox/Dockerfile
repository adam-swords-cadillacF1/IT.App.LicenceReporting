# syntax=docker/dockerfile:1
# Local sandbox only (Docker Desktop): the app with development sign-in, sample AD data and, optionally, a real Cato
# account. Production runs as a Windows service (see deploy/windows). Build and run with deploy/sandbox/run.sh.

# Node.js 24 through Artifactory's docker-all (Docker Hub remote). run.sh passes the digest it resolved, so the build
# is pinned to an exact image. With run.sh --public it is the same official image straight from Docker Hub, by digest.
ARG NODE_IMAGE=artifactory.hermes.uk.net/docker-all/node:24-trixie-slim
FROM ${NODE_IMAGE}
# artifactory (default): packages from Artifactory with the npm credentials secret. public: from registry.npmjs.org
# (sandbox only, when Artifactory isn't available), checked against the lockfile's integrity hashes.
ARG NPM_SOURCE=artifactory

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Europe/London \
    APP_TZ=Europe/London \
    NODE_EXTRA_CA_CERTS=/app/certs/hermes-ca.pem \
    DATA_DIR=/data \
    AUTH_MODE=dev \
    PORT=3003

# Packages come from Artifactory (the project .npmrc). The npm credentials are a build secret, never stored in a layer.
COPY package.json package-lock.json .npmrc deploy/sandbox/npmrc.public ./
COPY certs ./certs
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    set -eu; \
    if [ "$NPM_SOURCE" = public ]; then \
      sed -i 's#https://artifactory.hermes.uk.net/artifactory/api/npm/npm-all/#https://registry.npmjs.org/#g' package-lock.json; \
      if grep -q 'artifactory.hermes.uk.net' package-lock.json; then echo 'lockfile still points at Artifactory' >&2; exit 1; fi; \
      cp npmrc.public .npmrc; \
    elif [ ! -s /root/.npmrc ]; then echo 'Artifactory npm credentials secret is missing' >&2; exit 1; fi; \
    npm ci --omit=dev --ignore-scripts --no-fund; \
    rm -f npmrc.public

COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY scripts ./scripts
COPY snapshot ./snapshot
COPY deploy/sandbox/start.js ./deploy/sandbox/start.js

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3080
CMD ["node", "deploy/sandbox/start.js"]

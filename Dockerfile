# Patchcast Sync: one process, one SQLite file. Works with BuildKit/buildx (multi-arch) and the classic builder.
FROM node:24.22.3-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY tsconfig.json build.mjs ./
COPY src src
COPY web web
RUN node build.mjs

# Final image: Alpine + the node binary + one bundled file. No npm, no node_modules, no compilers.
FROM alpine:3.22
RUN apk add --no-cache libstdc++ libgcc && addgroup -g 1000 patchcast && adduser -u 1000 -G patchcast -D -H -s /sbin/nologin patchcast \
  && mkdir /data && chown 1000:1000 /data
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /src/dist /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
USER 1000:1000
VOLUME /data
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
LABEL org.opencontainers.image.title="Patchcast Sync" org.opencontainers.image.source="https://github.com/sp3lllz/patchcast-server" org.opencontainers.image.licenses="MIT"
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/server.mjs"]

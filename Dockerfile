FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/e2ee/package.json packages/e2ee/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN npm run build -w @cursor-gateway/shared \
  && npm run build -w @cursor-gateway/e2ee \
  && npm run build -w @cursor-gateway/web \
  && npm run build -w @cursor-gateway/server \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV WEB_STATIC_ENABLED=0
# Cap heap after slim refactor; raise only if soak tests require it.
ENV NODE_OPTIONS=--max-old-space-size=256
RUN printf '* soft core 0\n* hard core 0\n' >> /etc/security/limits.conf \
  && ulimit -c 0 || true \
  && mkdir -p /app/artifacts/secure-desktop
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/e2ee ./packages/e2ee
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Installers are mounted at runtime from host ./artifacts (zip + release.json only).
EXPOSE 8080
CMD ["sh", "-c", "node apps/server/dist/migrate.js && SKIP_INLINE_MIGRATE=1 exec node apps/server/dist/index.js"]

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/e2ee/package.json packages/e2ee/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/browser-extension/package.json apps/browser-extension/package.json
COPY apps/windows-runner/package.json apps/windows-runner/package.json
COPY apps/secure-web/package.json apps/secure-web/package.json
RUN npm install

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build -w @cursor-gateway/shared \
  && npm run build -w @cursor-gateway/e2ee \
  && npm run build -w @cursor-gateway/web \
  && npm run build -w @cursor-gateway/server \
  && npm run build -w @cursor-gateway/browser-extension \
  && node apps/browser-extension/scripts/pack-extension-zip.mjs

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Disable core dumps so plaintext never lands on disk if a decryptor crashes.
ENV NODE_OPTIONS=--max-old-space-size=512
RUN printf '* soft core 0\n* hard core 0\n' >> /etc/security/limits.conf \
  && ulimit -c 0 || true
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/e2ee ./packages/e2ee
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Copy the whole artifacts dir so any pre-placed downloadable (extension zip, and
# the Windows desktop installer cursor-gateway-desktop-setup.exe if an operator
# dropped it into ./artifacts before building) is served. The Windows .exe is
# built on Windows/CI (see docs/windows-client.md) — the Linux image cannot
# cross-compile it, and /api/desktop/download returns 404 until it is present.
COPY --from=build /app/artifacts/ ./artifacts/
EXPOSE 8080
# --disallow-code-generation-from-strings is optional; keep start simple.
CMD ["node", "apps/server/dist/index.js"]

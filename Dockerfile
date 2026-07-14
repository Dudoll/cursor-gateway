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
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/artifacts/cursor-gateway-secure.zip ./artifacts/cursor-gateway-secure.zip
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]

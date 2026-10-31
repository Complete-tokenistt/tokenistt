# Build context: repository root
FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY packages ./packages
RUN npm ci --workspace=apps/gateway --include-workspace-root
COPY apps/gateway apps/gateway
RUN npm run build --workspace=apps/gateway

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /repo/apps/gateway/package.json ./apps/gateway/
WORKDIR /repo/apps/gateway
RUN mkdir -p /app/gateway_data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]

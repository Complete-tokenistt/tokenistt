# Build context: repository root
FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY packages ./packages
RUN npm ci --workspace=apps/dashboard --include-workspace-root
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace=apps/dashboard

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo .
WORKDIR /repo/apps/dashboard
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]

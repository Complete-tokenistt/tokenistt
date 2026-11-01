# Build context: repository root
FROM node:26-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
# Full workspace install so a single React copy is hoisted (a partial install mixed 18 and 19)
RUN npm ci --no-audit --no-fund
RUN npm run build --workspace=packages/sdk-ts && npm run build --workspace=apps/dashboard

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo .
WORKDIR /repo/apps/dashboard
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]

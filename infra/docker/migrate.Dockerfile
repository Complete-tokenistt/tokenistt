# One-shot migration runner. Build context: repository root.
FROM node:26-alpine
WORKDIR /app
COPY packages/db/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY packages/db/migrate.mjs ./migrate.mjs
COPY packages/db/drizzle ./drizzle
CMD ["node", "migrate.mjs"]

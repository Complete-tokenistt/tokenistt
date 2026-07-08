FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json ./
RUN npm install

# Then source
COPY . .

CMD ["npm", "run", "start"]

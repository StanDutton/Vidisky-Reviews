# backend/Dockerfile
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

# Install prod deps (no lockfile → use npm install)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]

# backend/Dockerfile
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

# Create app dir
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Expose the port your Express server uses
EXPOSE 3001

# Run the server
CMD ["node", "server.js"]

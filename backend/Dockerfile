# Use Playwright's image (Chromium + OS deps included)
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

# App directory
WORKDIR /app

# Install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Expose Express port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]

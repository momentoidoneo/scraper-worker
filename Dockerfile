# Playwright base image with Chromium + system deps preinstalled
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install Node deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source + build
COPY tsconfig.json ./
COPY src ./src
RUN npm install -D typescript @types/node && npx tsc

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]

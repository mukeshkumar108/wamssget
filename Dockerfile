# Multi-stage build for optimal image size
FROM node:20-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dumb-init

# Create app user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S whatsapp -u 1001

FROM base AS dependencies

# Install Python for node-gyp (required for some packages)
RUN apk add --no-cache python3 python3-dev py3-setuptools make g++ sqlite-dev

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Force clean rebuild of better-sqlite3 for container architecture
RUN rm -rf node_modules/better-sqlite3/build node_modules/.bin/better-sqlite3* ~/tmp/*
RUN npm install better-sqlite3 --build-from-source --sqlite3-use-local=
RUN npm rebuild better-sqlite3 --build-from-source

FROM base AS runtime

# Set working directory
WORKDIR /app

# Copy installed dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application code
COPY . .

# Create output directory
RUN mkdir -p out && chown -R whatsapp:nodejs out

# Create non-root user and set permissions
USER whatsapp

# Set environment variables
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Expose HTTP port
EXPOSE 3000

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the application
CMD ["npx", "ts-node", "index.ts"]

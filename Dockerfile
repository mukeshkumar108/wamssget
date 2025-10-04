# Multi-stage production build for TypeScript compilation
FROM node:20-slim AS build

# Make sure Puppeteer doesn’t try to download Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install build dependencies for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y \
    python3 python3-dev make g++ libsqlite3-dev dumb-init \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy all source files (including TypeScript and tsconfig.json)
COPY . .

# Build TypeScript to JavaScript in dist/
RUN npm run build

# Remove dev dependencies to minimize image size but keep runtime dependencies
RUN npm prune --production

FROM node:20-slim AS runtime

# Install runtime dependencies, including ALL Chromium dependencies for stability
RUN apt-get update && apt-get install -y \
    ca-certificates \
    dumb-init \
    # Full list of puppeteer dependencies from docs
    chromium \
    chromium-common \
    chromium-sandbox \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libcups2 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Create app user for security
RUN groupadd -r whatsapp -g 1001 && \
    useradd -r whatsapp -u 1001 -g whatsapp -m -d /app

# Set working directory
WORKDIR /app

# Copy built dependencies from build stage
COPY --from=build /app/node_modules ./node_modules

# Copy compiled JavaScript from build stage
COPY --from=build /app/dist ./dist 

# Copy package.json for metadata
COPY package*.json ./

# Copy types.d.ts and any other runtime-needed files (excluding source)
COPY types.d.ts ./

# Copy Drizzle config and migrations folder
COPY drizzle.config.ts ./
COPY drizzle ./drizzle

# Create output directory with proper permissions
RUN mkdir -p out && chown -R whatsapp:whatsapp out

# Create auth directory with correct permissions
RUN mkdir -p /app/.wwebjs_auth && chown -R whatsapp:whatsapp /app/.wwebjs_auth

# Create non-root user and set permissions
USER whatsapp

# Set environment variables
ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Expose HTTP port
EXPOSE 3000

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
# RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Use it as entrypoint
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Start the application with compiled JavaScript (no ts-node)
CMD ["node", "dist/index.js"]

# Use Playwright's official image with all browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Set working directory
WORKDIR /app

# Copy package files (including package-lock.json)
COPY package.json package-lock.json ./

# Install ALL dependencies (need devDeps for TypeScript build)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --omit=dev

# Expose port
EXPOSE 3000

# Run the server
CMD ["node", "dist/index.js"]

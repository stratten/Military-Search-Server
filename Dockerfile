FROM mcr.microsoft.com/playwright:v1.51.1-focal

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Debug: print the installed Playwright version
RUN npm list playwright

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Bundle app source
COPY . .

# Create directories for logs and outputs with world-writable permissions
RUN mkdir -p /app/logs /app/outputs \
    && chmod -R 777 /app/logs /app/outputs

# Set environment variables
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Add always restart policy
LABEL com.centurylinklabs.watchtower.enable="true"
LABEL autoheal=true

# Simple health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Create entrypoint script
RUN echo '#!/bin/bash\nset -e\n\n# Forward SIGTERM to the Node.js process\ntrap '\''kill -TERM $NODE_PID'\'' TERM INT\n\n# Start Node.js in the background\nnpm start &\nNODE_PID=$!\n\n# Wait for Node.js to terminate\nwait $NODE_PID\n\n# Exit with the same code as Node.js\nexit $?' > /entrypoint.sh \
    && chmod +x /entrypoint.sh

# Ensure we get proper signal handling
STOPSIGNAL SIGTERM

# Expose port
EXPOSE 8080

# Make node_modules read-only and remove npm/npx to prevent runtime mutation
RUN chmod -R 555 node_modules && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Use the entrypoint script
ENTRYPOINT ["/entrypoint.sh"] 
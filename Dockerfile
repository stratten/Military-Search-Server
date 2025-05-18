FROM mcr.microsoft.com/playwright:v1.52.0-focal

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Create directories for logs and outputs with world-writable permissions
RUN mkdir -p /app/logs /app/outputs \
    && chmod -R 777 /app/logs /app/outputs

# Set environment variables
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Enable garbage collection
ENV NODE_OPTIONS="--expose-gc"

# Expose port
EXPOSE 8080

# Add always restart policy
LABEL com.centurylinklabs.watchtower.enable="true"
LABEL autoheal=true

# Simple health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Create a simple entrypoint script
RUN echo '#!/bin/bash\nset -e\n\n# Forward SIGTERM to the Node.js process\ntrap '\''kill -TERM $NODE_PID'\'' TERM INT\n\n# Start Node.js in the background\nnpm start &\nNODE_PID=$!\n\n# Wait for Node.js to terminate\nwait $NODE_PID\n\n# Exit with the same code as Node.js\nexit $?' > /entrypoint.sh \
    && chmod +x /entrypoint.sh

# Use the entrypoint script
ENTRYPOINT ["/entrypoint.sh"] 
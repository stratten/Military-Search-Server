FROM node:18-slim

# Install system utilities for debugging
RUN apt-get update && apt-get install -y \
    procps \
    lsof \
    net-tools \
    curl \
    dnsutils \
    iputils-ping \
    htop \
    vim \
    ca-certificates

# Install Firefox dependencies
RUN apt-get update && apt-get install -y \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libgtk-3-0 \
    libdbus-glib-1-2 \
    libxt6 \
    libpci3 \
    libasound2 \
    libcups2 \
    libxcb-shm0 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libfreetype6 \
    libfontconfig1 \
    libdbus-1-3 \
    xvfb \
    fonts-liberation \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set up Xvfb for headless execution
ENV DISPLAY=:99
RUN echo '#!/bin/bash\n# Remove lock file if it exists to prevent startup issues\nrm -f /tmp/.X99-lock\nXvfb :99 -screen 0 1280x1024x24 &\nexec "$@"' > /entrypoint.sh \
    && chmod +x /entrypoint.sh

# Create and set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Create directories for logs and outputs
RUN mkdir -p /app/logs /app/outputs \
    && chmod -R 777 /app/logs /app/outputs

# Install Playwright with Firefox and its dependencies
RUN npx playwright install firefox --with-deps

# Expose port
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=4096

# Use our entrypoint script
ENTRYPOINT ["/entrypoint.sh"]

# Start the application
CMD ["npm", "start"] 
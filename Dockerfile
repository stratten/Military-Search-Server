FROM node:18-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    procps \
    libxcb-shm0 \
    libx11-xcb1 \
    libx11-6 \
    libxcb1 \
    libxext6 \
    libxrandr2 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libgtk-3-0 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libxrender1 \
    libasound2 \
    libfreetype6 \
    libfontconfig1 \
    libdbus-1-3 \
    wget \
    xvfb \
    ca-certificates \
    fonts-liberation \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create and set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY . .

# Install Playwright and Firefox
RUN npx playwright install firefox --with-deps

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=2048

# Start the application
CMD ["npm", "start"] 
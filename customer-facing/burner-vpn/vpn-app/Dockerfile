FROM node:20-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package.json tsconfig.json ./
RUN npm install

# Copy application files
COPY server.ts ./
COPY public ./public

CMD ["npm", "run", "dev"]

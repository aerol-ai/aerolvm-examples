FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install || npm install

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]

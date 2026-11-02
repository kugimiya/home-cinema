FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json tsconfig.json vitest.config.ts ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-bookworm
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.js"]

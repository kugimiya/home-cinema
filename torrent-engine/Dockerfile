FROM node:22-bookworm AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libtorrent-rasterbar-dev \
        pkg-config \
        build-essential \
        python3 \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p native/third_party/nlohmann \
    && curl -fsSL https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp \
        -o native/third_party/nlohmann/json.hpp
COPY package.json binding.gyp tsconfig.json ./
COPY native ./native
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-bookworm
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libtorrent-rasterbar2.0 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/build ./build
EXPOSE 8090
CMD ["node", "dist/index.js"]

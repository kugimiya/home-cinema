# Fallback if Docker Hub pull for lifailon/torapi fails
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git \
  && git clone --depth 1 https://github.com/Lifailon/TorAPI.git . \
  && npm install --omit=dev
EXPOSE 8443
CMD ["node", "main.js"]

FROM bluenviron/mediamtx:1.21.1 AS relay
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core tzdata \
  && rm -rf /var/lib/apt/lists/*
COPY --from=relay /mediamtx /usr/local/bin/mediamtx
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY .env.example ./
COPY web ./web
ENV NODE_ENV=production
EXPOSE 3000 8080 8081 8082 8083 8554 8555 8556 8557
CMD ["node", "src/proxy-fleet.js"]
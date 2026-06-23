FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV STORAGE_DRIVER=sqlite

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server.js sandbox-provider.js app.js index.html docs.html demo-target.html styles.css ./
COPY sdk ./sdk
COPY scripts ./scripts
COPY migrations ./migrations

RUN mkdir -p data && node scripts/db-migrate.js

EXPOSE 8787
CMD ["node", "server.js"]

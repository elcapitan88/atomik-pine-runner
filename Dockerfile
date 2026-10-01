FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# isolated-vm ships a prebuilt linux-x64 binary for Node 24, so no build tools.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Patched PineTS bundle the sandbox loads (vendor/pinets/README.md).
COPY vendor ./vendor

RUN useradd --create-home appuser
USER appuser

ENV PORT=8000
EXPOSE 8000
CMD ["node", "--no-node-snapshot", "src/server.mjs"]

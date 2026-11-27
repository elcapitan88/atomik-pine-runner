FROM node:24-slim

ENV NODE_ENV=production
# Each isolate runs on its own thread; glibc gives busy threads their own
# malloc arenas and rarely hands freed memory back, so worker RSS ratchets up
# to the heaviest job it ever ran. Two arenas keep it close to what's in use.
ENV MALLOC_ARENA_MAX=2
WORKDIR /app

COPY package.json package-lock.json ./
# isolated-vm ships a prebuilt linux-x64 binary for Node 24, so no build tools.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Patched PineTS bundle the sandbox loads (vendor/pinets/README.md).
COPY vendor ./vendor
# Pine libraries scripts can `import` (pine-libs/README.md).
COPY pine-libs ./pine-libs

RUN useradd --create-home appuser
USER appuser

ENV PORT=8000
EXPOSE 8000
CMD ["node", "--no-node-snapshot", "src/server.mjs"]

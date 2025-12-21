# Small, current LTS base. Alpine keeps the image around 150 MB.
FROM node:22-alpine

# Tini-style signal handling is not needed: server.js handles SIGTERM itself.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# Dependencies first so edits to app code reuse this layer.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Application code.
COPY server.js apps.json ./
COPY public ./public

# The volume mount point has to be writable by the unprivileged runtime user.
RUN mkdir -p "$DATA_DIR" && chown -R node:node "$DATA_DIR" /app

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

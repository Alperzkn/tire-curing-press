# HMI for the tire curing press on Siemens Industrial Edge.
# The simulation itself runs in Flow Creator (flow/tire-press-flow.json); this image only reads the
# IE Databus, serves the page built by `node build.mjs` (public/index.html) and forwards operator writes.
FROM node:22.20.0-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/server.mjs"]

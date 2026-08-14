FROM node:22-alpine

WORKDIR /app

# Dependencies first so source edits don't reinstall.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# Non-root. The app writes nothing to disk.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
# Bind loopback only — a tunnel reaches this, never the public interface.
ENV HOST=127.0.0.1

CMD ["node", "src/server.js"]

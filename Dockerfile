# K54 Game race server (Node 22, no dependencies). Build context = this folder.
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json ./package.json
COPY shared ./shared
COPY race-server ./race-server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1
CMD ["node", "race-server/server.mjs"]

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/offsettech.sqlite
WORKDIR /app
COPY --chown=node:node package.json server.mjs security.mjs app.html app.js ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]

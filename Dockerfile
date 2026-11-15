FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/offsettech.sqlite
WORKDIR /app
COPY --chown=node:node package.json *.mjs *.html *.js *.css hero.jpg ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]


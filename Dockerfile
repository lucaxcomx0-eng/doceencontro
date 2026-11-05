FROM node:24-slim
WORKDIR /app
COPY server.js index.html order.html ./
COPY assets ./assets
ENV NODE_ENV=production PORT=10000 DATA_DIR=/var/data
EXPOSE 10000
CMD ["node", "server.js"]

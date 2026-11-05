FROM node:24-slim
WORKDIR /app
COPY server.js index.html ./
COPY assets ./assets
COPY assets/order.html ./order.html
ENV NODE_ENV=production PORT=10000 DATA_DIR=/tmp/doce-encontro
EXPOSE 10000
CMD ["node", "server.js"]

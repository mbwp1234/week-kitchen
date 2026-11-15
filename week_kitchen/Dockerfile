ARG BUILD_FROM
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs
WORKDIR /app
COPY server.mjs /app/server.mjs
COPY www /app/www
CMD ["node", "/app/server.mjs"]

FROM node:18.12.1 AS Builder

WORKDIR /app

COPY package.json ./
COPY yarn.lock ./

RUN yarn

FROM node:18.12.1-alpine AS Runner

WORKDIR /app

COPY --from=Builder /app/node_modules/ ./node_modules/
COPY app.mjs ./
COPY import.mjs ./
COPY cron.mjs ./
COPY util.mjs ./

CMD [ "node", "app.mjs" ]

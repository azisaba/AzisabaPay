FROM node:18.12.1 AS Builder

WORKDIR /app

COPY package.json ./
COPY yarn.lock ./

RUN yarn

FROM node:18.12.1-alpine AS Runner

WORKDIR /app

COPY --from=Builder /app/node_modules/ ./node_modules/
COPY --from=Builder /app/app.mjs ./app.mjs
COPY --from=Builder /app/import.mjs ./import.mjs
COPY --from=Builder /app/cron.mjs ./cron.mjs

CMD [ "node", "app.mjs" ]

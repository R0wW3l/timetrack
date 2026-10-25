FROM node:24-alpine AS deps

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data
VOLUME ["/data"]

ENV DATA_FOLDER=/data
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]

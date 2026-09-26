FROM node:18-alpine

# better-sqlite3 需要编译原生模块
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3000

ENV PORT=3000
CMD ["node", "server.js"]

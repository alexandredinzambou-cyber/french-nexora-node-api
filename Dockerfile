FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3100

EXPOSE 3100

CMD ["node", "server.js"]

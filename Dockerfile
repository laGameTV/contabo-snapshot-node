FROM node:21-bullseye-slim

WORKDIR /

COPY package*.json ./
COPY . .

RUN npm ci

CMD ["npm", "start"]

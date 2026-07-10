FROM node:24-slim AS base

WORKDIR /app
ENV PORT=8787
ENV DATA_DIR=/data

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787

CMD ["npm", "run", "start"]

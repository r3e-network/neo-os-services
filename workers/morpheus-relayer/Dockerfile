FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY workers/nitro-worker/package.json workers/nitro-worker/package.json
COPY workers/morpheus-relayer/package.json workers/morpheus-relayer/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev

COPY . .

CMD ["npm", "--prefix", "workers/morpheus-relayer", "run", "start"]

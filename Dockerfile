# Node 24 strips the TypeScript types at runtime, so there is no build step here
# either - the image runs the same files the repo does.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3000
CMD ["node", "src/server.ts"]

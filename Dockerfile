FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY index.ts ./

RUN npm install
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]

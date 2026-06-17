FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

RUN npm run build
RUN cp -r public dist/

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "dist/server.js"]

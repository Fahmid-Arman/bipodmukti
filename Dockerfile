FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/server.ts"]

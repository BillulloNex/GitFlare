FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src/ ./src/
RUN npm install && npx tsc

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev 2>/dev/null; true
EXPOSE 7654
CMD ["node", "dist/index.js"]

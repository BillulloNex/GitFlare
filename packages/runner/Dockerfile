FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY dist/ ./dist/
EXPOSE 7654
CMD ["node", "dist/index.js"]

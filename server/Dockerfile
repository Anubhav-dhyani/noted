FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /app/data
ENV PORT=4000 DATA_FILE=/app/data/noted.json
EXPOSE 4000
CMD ["node", "src/index.js"]

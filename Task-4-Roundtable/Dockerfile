FROM node:22-alpine

# Also what makes the session cookie Secure: auth.js reads it through
# server/config.js as config.isProduction.
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4003

CMD ["node", "server/index.js"]

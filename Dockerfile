# Build from apps/agent-gateway/ (self-contained, no sibling packages):
#   docker build -t agentpodium-agent-gateway apps/agent-gateway

# ---- build -----------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime -----------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3200 \
    ACCOUNT_API=https://agentspodium.com/api

COPY --from=build /build/package.json /build/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /build/dist ./dist

EXPOSE 3200
USER node
CMD ["node", "dist/server.js"]

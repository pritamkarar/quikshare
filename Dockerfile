FROM node:22-alpine AS build
WORKDIR /app
# The one client variable that must be chosen before the bundle exists: Vite
# inlines it at build time, so it cannot be set when the container runs.
# Unset falls back to a public STUN default (client/transport/webrtc.ts).
#   docker build --build-arg VITE_STUN_URLS=stun:stun.example.com:3478 .
ARG VITE_STUN_URLS=""
ENV VITE_STUN_URLS=$VITE_STUN_URLS
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8787
USER node
CMD ["node", "dist/server/index.js"]

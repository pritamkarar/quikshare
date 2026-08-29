FROM node:22-alpine AS build
WORKDIR /app
# The one client variable that must be chosen before the bundle exists: Vite
# inlines it at build time, so it cannot be set when the container runs.
# Unset falls back to a public STUN default (client/transport/webrtc.ts).
#   docker build --build-arg VITE_STUN_URLS=stun:stun.example.com:3478 .
ARG VITE_STUN_URLS=""
ENV VITE_STUN_URLS=$VITE_STUN_URLS
COPY package*.json ./
# --include=dev, not a bare `npm ci`: npm reads NODE_ENV=production from the
# environment as an implicit --omit=dev, and a platform that injects the
# service env vars into the build stage (Zeabur does; Render does not) strands
# this stage without vite or tsc — `npm run build` then dies with
# `sh: vite: not found`, exit 127. --include=dev beats --omit whichever order
# they arrive in, so this holds even if the platform also passes --omit=dev.
RUN npm ci --include=dev
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

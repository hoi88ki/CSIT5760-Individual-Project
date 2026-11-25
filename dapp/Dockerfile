# TradeChain role dashboard — build the Vite bundle, serve it with nginx.
# VITE_RPC_URL (build arg) is the JSON-RPC endpoint used when MetaMask is absent;
# it defaults to a public Sepolia node so the packaged dashboard shows the live
# deployment read-only. Transactions always need MetaMask in the browser.
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ENV VITE_RPC_URL=$VITE_RPC_URL

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

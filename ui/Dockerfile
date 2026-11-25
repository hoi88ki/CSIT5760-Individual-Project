# TradeChain flow console — static single-file dashboard, no build step.
# Served under /ui/ so the documented URL (http://host:8080/ui/index.html) works,
# with / redirecting there for convenience.
FROM nginx:1.27-alpine

COPY index.html ethers.umd.min.js /usr/share/nginx/html/ui/
COPY nginx-default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

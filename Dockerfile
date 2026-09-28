FROM ghcr.io/lavalink-devs/lavalink:4-alpine

USER root

# Node.js dibutuhkan untuk menjalankan dashboard + reverse proxy
RUN apk add --no-cache nodejs npm curl bash

WORKDIR /opt/Lavalink
COPY application.yml /opt/Lavalink/application.yml

WORKDIR /opt/proxy
COPY proxy/package.json ./package.json
RUN npm install --omit=dev
COPY proxy/ ./

WORKDIR /opt/Lavalink
COPY start.sh /opt/Lavalink/start.sh
RUN chmod +x /opt/Lavalink/start.sh

# Lavalink jalan secara internal di port ini, TIDAK diekspos langsung ke publik.
# Yang diekspos ke publik/Render adalah port dashboard (PORT), lihat proxy/server.js
ENV SERVER_PORT=2333
ENV PORT=10000

# Matikan HEALTHCHECK bawaan image Lavalink (nembak /version tanpa Authorization
# tiap 10 detik -> spam "Authorization missing"). Ganti dengan cek ke proxy.
HEALTHCHECK NONE

ENTRYPOINT ["/opt/Lavalink/start.sh"]

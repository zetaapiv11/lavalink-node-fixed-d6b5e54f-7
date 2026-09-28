#!/bin/bash
set -e

LAVALINK_PORT="${SERVER_PORT:-2333}"

if [ -z "${LAVALINK_SERVER_PASSWORD}" ]; then
  echo "[start.sh] LAVALINK_SERVER_PASSWORD is empty. Refusing to start."
  echo "[start.sh] An empty password does NOT mean 'no auth' the way you'd expect -"
  echo "[start.sh] Lavalink treats a request with a blank Authorization header as"
  echo "[start.sh] authenticated, so this node would be silently open to anyone."
  echo "[start.sh] Set LAVALINK_SERVER_PASSWORD in the environment and redeploy."
  exit 1
fi

# Proxy/dashboard dijalankan DULU supaya Render langsung mendeteksi port publik
# (Lavalink butuh ~30-60 detik untuk boot). Selama Lavalink belum siap, proxy
# membalas 502 untuk request ke Lavalink dan /healthz membalas 503.
echo "[start.sh] Starting dashboard + proxy on public port ${PORT:-3000}..."
cd /opt/proxy
node server.js &
PROXY_PID=$!
cd /opt/Lavalink

echo "[start.sh] Starting Lavalink on internal port ${LAVALINK_PORT}..."
# _JAVA_OPTIONS otomatis dibaca JVM dari environment, jadi tidak perlu dipasang lagi di sini
java -jar /opt/Lavalink/Lavalink.jar &
LAVALINK_PID=$!

echo "[start.sh] Waiting for Lavalink to become healthy..."
# PENTING: /version di Lavalink butuh header Authorization. Tanpa header ini
# responsnya 401, dan `curl -f` menganggapnya gagal selamanya (loop tak berujung).
until curl -sf -o /dev/null -H "Authorization: ${LAVALINK_SERVER_PASSWORD}" \
      "http://127.0.0.1:${LAVALINK_PORT}/version"; do
  if ! kill -0 "$LAVALINK_PID" 2>/dev/null; then
    echo "[start.sh] Lavalink process died before becoming healthy. Exiting."
    exit 1
  fi
  sleep 1
done
echo "[start.sh] Lavalink is up."

# Kalau salah satu proses mati, matikan container supaya Render restart otomatis
wait -n "$LAVALINK_PID" "$PROXY_PID"
exit $?

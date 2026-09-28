#!/usr/bin/env bash
set -Eeuo pipefail

# One-time installer for an Ubuntu/Debian VPS.
# This profile intentionally serves plain HTTP on port 80. Render remains the
# SSL node and the central control panel; the VPS is the non-SSL node.

APP_NAME="lavalink-node"
IMAGE_NAME="lavalink-node:local"
CONTAINER_NAME="lavalink-node"
PUBLIC_PORT="10000"
LAVALINK_PORT="2333"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"

cleanup_on_error() {
  echo
  echo "[ERROR] Installer berhenti. Cek log dengan: docker logs ${CONTAINER_NAME}"
}
trap cleanup_on_error ERR

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

if [[ ! -f "${SCRIPT_DIR}/Dockerfile" || ! -f "${SCRIPT_DIR}/application.yml" ]]; then
  echo "[ERROR] Jalankan script ini dari folder lavalink-node yang lengkap."
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "[ERROR] OS tidak dikenali. Script ini hanya untuk Ubuntu/Debian."
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *debian* ]]; then
  echo "[ERROR] OS terdeteksi sebagai ${ID:-unknown}; gunakan Ubuntu/Debian."
  exit 1
fi

read -r -p "Domain VPS (contoh: vps.domainkamu.com): " DOMAIN
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
if [[ ! "${DOMAIN}" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "[ERROR] Domain tidak valid."
  exit 1
fi

while true; do
  read -r -s -p "Password Lavalink baru: " LAVALINK_PASSWORD
  echo
  read -r -s -p "Ulangi password Lavalink: " LAVALINK_PASSWORD_CONFIRM
  echo
  if [[ -z "${LAVALINK_PASSWORD}" || "${LAVALINK_PASSWORD}" != "${LAVALINK_PASSWORD_CONFIRM}" ]]; then
    echo "[WARN] Password kosong atau tidak sama. Coba lagi."
  elif [[ "${#LAVALINK_PASSWORD}" -lt 20 ]]; then
    echo "[WARN] Gunakan password minimal 20 karakter."
  else
    break
  fi
done

read -r -p "Spotify Client ID (opsional, Enter untuk melewati): " SPOTIFY_CLIENT_ID
if [[ -n "${SPOTIFY_CLIENT_ID}" ]]; then
  read -r -s -p "Spotify Client Secret: " SPOTIFY_CLIENT_SECRET
  echo
else
  SPOTIFY_CLIENT_SECRET=""
fi

if getent hosts "${DOMAIN}" >/dev/null 2>&1; then
  echo "[OK] DNS untuk ${DOMAIN} terdeteksi."
else
  echo "[ERROR] ${DOMAIN} belum mengarah ke VPS ini."
  echo "Buat record A untuk ${DOMAIN} ke IP VPS, tunggu DNS aktif, lalu jalankan ulang."
  exit 1
fi

if [[ -f "${ENV_FILE}" ]]; then
  read -r -p "${ENV_FILE} sudah ada. Timpa? [y/N]: " OVERWRITE_ENV
  if [[ ! "${OVERWRITE_ENV}" =~ ^[Yy]$ ]]; then
    echo "[ERROR] Batalkan agar secret lama tidak tertimpa."
    exit 1
  fi
  cp "${ENV_FILE}" "${ENV_FILE}.backup.$(date +%s)"
fi

echo "[1/7] Memasang dependency sistem..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nginx ufw

echo "[2/7] Mengaktifkan Docker..."
if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y docker.io
fi
systemctl enable --now docker

echo "[3/7] Menulis konfigurasi private..."
umask 077
cat > "${ENV_FILE}" <<EOF
SERVER_PORT=${LAVALINK_PORT}
PORT=${PUBLIC_PORT}
LAVALINK_SERVER_PASSWORD=${LAVALINK_PASSWORD}
NODE_NAME=vps
PUBLIC_URL=http://${DOMAIN}
DISK_PATH=/
SPOTIFY_CLIENT_ID=${SPOTIFY_CLIENT_ID}
SPOTIFY_CLIENT_SECRET=${SPOTIFY_CLIENT_SECRET}
SPOTIFY_COUNTRY_CODE=ID
EOF
chmod 600 "${ENV_FILE}"
unset LAVALINK_PASSWORD LAVALINK_PASSWORD_CONFIRM SPOTIFY_CLIENT_SECRET

echo "[4/7] Build image Lavalink..."
docker build --pull -t "${IMAGE_NAME}" "${SCRIPT_DIR}"

if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  echo "[INFO] Container lama ditemukan, container akan diganti."
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

echo "[5/7] Menjalankan Lavalink di localhost..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --env-file "${ENV_FILE}" \
  -p "127.0.0.1:${PUBLIC_PORT}:${PUBLIC_PORT}" \
  "${IMAGE_NAME}" >/dev/null

echo "[6/7] Mengatur Nginx HTTP untuk ${DOMAIN}..."
if [[ -f "${NGINX_SITE}" ]]; then
  cp "${NGINX_SITE}" "${NGINX_SITE}.backup.$(date +%s)"
fi
mkdir -p /etc/nginx/sites-enabled
cat > "${NGINX_SITE}" <<EOF
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PUBLIC_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sfn "${NGINX_SITE}" "${NGINX_LINK}"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "[7/7] Mengamankan firewall..."
SSH_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }')"
SSH_PORT="${SSH_PORT:-22}"
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow "Nginx HTTP" >/dev/null
ufw --force enable >/dev/null

echo "[INFO] Menunggu Lavalink siap..."
for _ in $(seq 1 120); do
  if curl -fsS "http://${DOMAIN}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS "http://${DOMAIN}/healthz"; then
  echo
  echo "[WARN] Domain sudah dipasang, tetapi Lavalink belum sehat."
  echo "Cek: docker logs --tail 100 ${CONTAINER_NAME}"
  exit 1
fi
echo

trap - ERR
echo
echo "=============================================="
echo "Lavalink VPS selesai dipasang"
echo "=============================================="
echo "Endpoint bot : ${DOMAIN}"
echo "Port         : 80"
echo "Secure       : false"
echo "Health       : http://${DOMAIN}/healthz"
echo "Status       : http://${DOMAIN}/status"
echo
echo "Password tersimpan hanya di:"
echo "${ENV_FILE}"
echo
echo "Jangan masukkan IP VPS ke bot. Gunakan domain di atas."
echo "Log: docker logs -f ${CONTAINER_NAME}"
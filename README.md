# Lavalink multi-node: Render SSL + VPS non-SSL

Paket ini menjalankan Lavalink v4 di balik reverse proxy Node.js. Satu service
Render menjadi node SSL sekaligus dashboard pusat. Node VPS berjalan pada domain
lain melalui HTTP port 80. Dashboard Render memantau dan menguji kedua node dari
satu domain.

## Arsitektur

- **Render**: `https://render.example.com`, port 443, `secure: true`.
- **VPS**: `http://vps.example.com`, port 80, `secure: false`.
- **Dashboard pusat**: halaman `/status` pada domain Render. Dashboard menampilkan
  online/offline, player, uptime, CPU host, RAM host, disk host, Lavalink load,
  dan frame deficit untuk kedua node.
- Endpoint node tetap berbeda karena satu host dan satu port tidak bisa
  menjalankan dua listener Lavalink. Yang dibuat satu domain adalah pusat
  kontrolnya, bukan dua koneksi Lavalink yang dipaksa memakai port yang sama.

`STATS_TOKEN` bersifat opsional. Jika diisi pada node, masukkan token yang sama
sebagai `statsToken` di konfigurasi node Render. Token dikirim server-to-server
dan tidak pernah masuk browser. Untuk VPS non-SSL, semua trafik termasuk token
dan password Lavalink berjalan tanpa enkripsi; gunakan hanya jika memang
dibutuhkan dan batasi akses dengan firewall atau jaringan privat.

## Deploy ke Render dengan Blueprint

1. Push folder ini ke repository GitHub.
2. Di Render pilih **New > Blueprint** dan pilih repository tersebut.
3. Isi environment variable yang ditandai `sync: false` pada `render.yaml`:
   - `LAVALINK_SERVER_PASSWORD`: password acak panjang khusus Render.
   - `LAVALINK_NODES`: JSON daftar node tambahan, contoh di bawah.
   - `STATS_TOKEN`: opsional, jika dashboard perlu mengakses node Render yang
     endpoint `/api/stats`-nya ingin dilindungi.
   - `SPOTIFY_CLIENT_ID` dan `SPOTIFY_CLIENT_SECRET`: opsional.
4. Setelah build selesai, tes `https://render.example.com/healthz`. Respons sehat
   harus HTTP 200 dengan body `ok`.
5. Tambahkan custom domain Render dari **Settings > Custom Domains** dan ikuti
   target DNS yang diberikan Render. Jangan menebak record DNS.

Koneksi bot ke node Render:

```text
host: render.example.com
port: 443
secure: true
password: nilai LAVALINK_SERVER_PASSWORD Render
```

## Setup VPS non-SSL (Ubuntu/Debian)

Buat DNS lebih dulu:

```text
vps.example.com  A  IP_VPS
```

Lalu jalankan dari folder `lavalink-node`:

```bash
chmod +x install-vps.sh
sudo ./install-vps.sh
```

Installer akan memasang Docker, Nginx, dan firewall, lalu:

- menjalankan Lavalink hanya di localhost;
- meneruskan REST dan WebSocket lewat Nginx port 80;
- tidak memasang Certbot dan tidak membuat redirect HTTPS;
- mengetes `http://vps.example.com/healthz`.

Koneksi bot ke node VPS:

```text
host: vps.example.com
port: 80
secure: false
password: nilai LAVALINK_SERVER_PASSWORD VPS
```

Jangan membuka port 2333 atau 10000 langsung ke internet. Karena VPS non-SSL,
password Lavalink dan trafik kontrol tidak terenkripsi; gunakan password node
yang berbeda dari Render dan pertimbangkan firewall yang hanya mengizinkan IP
Render atau bot kamu.

## Menghubungkan VPS ke dashboard Render

Isi `LAVALINK_NODES` pada environment service Render, bukan pada browser:

```dotenv
LAVALINK_NODES=[{"id":"vps","name":"VPS / HTTP 80","url":"http://vps.example.com","statsToken":""}]
```

Dashboard otomatis menambahkan node Render sebagai `self`. Jika ingin
melindungi endpoint statistik VPS, isi `STATS_TOKEN` pada VPS dan gunakan nilai
yang sama pada `statsToken`:

```dotenv
LAVALINK_NODES=[{"id":"vps","name":"VPS / HTTP 80","url":"http://vps.example.com","statsToken":"isi-token-yang-sama"}]
```

Pada halaman Player Test, pilih Render atau VPS sebelum melakukan resolve lagu.
Request untuk VPS dikirim oleh server Render sehingga credential tidak dikirim
ke browser.

## Environment penting

```dotenv
SERVER_PORT=2333
PORT=10000
LAVALINK_SERVER_PASSWORD=ganti-dengan-password-panjang
STATS_TOKEN=
NODE_NAME=vps
PUBLIC_URL=http://vps.example.com
DISK_PATH=/
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_COUNTRY_CODE=ID
```

## Provider musik

- YouTube dan YouTube Music memakai `youtube-plugin` `1.18.2`.
- SoundCloud memakai source Lavalink.
- Spotify memakai LavaSrc `4.8.3` dan membutuhkan credential Spotify.
- Resolve Spotify adalah proses metadata/mirror; audio tetap dikirim ke Discord
  melalui player Lavalink dari bot.

## Kapasitas dan troubleshooting

`standard` Render dengan heap `-Xmx1400M` adalah baseline, bukan jaminan
kapasitas. Pantau CPU, RAM, disk, transcoding, koneksi serentak, dan bandwidth.
Jika CPU sering di atas 80%, naikkan plan/CPU dan sesuaikan heap.

Untuk pemeriksaan cepat:

```bash
curl http://vps.example.com/healthz
curl https://render.example.com/healthz
curl https://render.example.com/api/nodes
docker logs --tail 100 lavalink-node
```
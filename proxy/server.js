const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const httpProxy = require("http-proxy");

const PORT = process.env.PORT || 10000;
const LAVALINK_PORT = process.env.SERVER_PORT || 2333;
const LAVALINK_PASSWORD = process.env.LAVALINK_SERVER_PASSWORD || "";
const NODE_NAME = process.env.NODE_NAME || "zetachei";
const STATS_TOKEN = process.env.STATS_TOKEN || "";
const DISK_PATH = process.env.DISK_PATH || "/";

// Node tambahan untuk halaman kontrol multi-node. LAVALINK_NODES adalah nama
// utama; NODES tetap diterima supaya deployment lama tidak langsung rusak.
// statsToken hanya dipakai antar-server dan tidak pernah dikirim ke browser.
let EXTRA_NODES = [];
try {
  const configuredNodes = JSON.parse(process.env.LAVALINK_NODES || process.env.NODES || "[]");
  EXTRA_NODES = Array.isArray(configuredNodes) ? configuredNodes : [];
} catch (e) {
  console.error("[nodes] LAVALINK_NODES bukan JSON valid:", e.message);
}
const SELF_HOST = process.env.PUBLIC_HOST || "";
const SELF_URL = process.env.PUBLIC_URL || "";

const LAVALINK_TARGET = `http://127.0.0.1:${LAVALINK_PORT}`;
const publicDir = path.join(__dirname, "public");
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const proxy = httpProxy.createProxyServer({ target: LAVALINK_TARGET, ws: true });
proxy.on("error", (err, req, res) => {
  console.error("[proxy] error:", err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Lavalink belum siap, coba lagi sebentar.");
  }
});

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const rate = new Map();

let previousCpu = null;
function readHostMetrics() {
  const cpus = os.cpus();
  const total = cpus.reduce((sum, cpu) => {
    const times = cpu.times;
    return sum + times.user + times.nice + times.sys + times.idle + times.irq;
  }, 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const cpuSample = previousCpu
    ? Math.max(0, Math.min(100, ((total - previousCpu.total - (idle - previousCpu.idle)) / (total - previousCpu.total || 1)) * 100))
    : null;
  previousCpu = { total, idle };

  let disk = null;
  try {
    const stat = fs.statfsSync(DISK_PATH);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    disk = {
      path: DISK_PATH,
      total: totalBytes,
      free: freeBytes,
      used: Math.max(0, totalBytes - freeBytes),
      usedPercent: totalBytes ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : null,
    };
  } catch (error) {
    console.error("[metrics] tidak bisa membaca disk:", error.message);
  }

  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    cpuPercent: cpuSample == null ? null : Math.round(cpuSample),
    memory: { total: totalMemory, free: freeMemory, used: totalMemory - freeMemory },
    disk,
    loadAverage: os.loadavg(),
  };
}

function hasNodeToken(req) {
  if (!STATS_TOKEN) return true;
  const supplied = req.headers["x-node-token"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return supplied === STATS_TOKEN;
}

// ---- Monitor multi-node: sampling tiap 15 dtk, disimpan di memori (hilang saat restart) ----
const nodeState = new Map(); // key -> { stats, ok, history: [bool] }
function fetchRemoteStats(target) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(target.url || `https://${target.host}`); } catch (e) { return reject(e); }
    const transport = parsed.protocol === "http:" ? http : https;
    const headers = { Accept: "application/json" };
    if (target.statsToken) headers["X-Node-Token"] = target.statsToken;
    const r = transport.get({ hostname: parsed.hostname, port: parsed.port || undefined, path: "/api/stats", timeout: 5000, headers }, (resp) => {
      let b = "";
      resp.on("data", (c) => (b += c));
      resp.on("end", () => { try { resp.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error("HTTP " + resp.statusCode)); } catch (e) { reject(e); } });
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
  });
}
function findRemoteNode(id) {
  return EXTRA_NODES.find((node) => (node.id || node.url || node.host) === id);
}
function fetchRemoteJson(target, pathname) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(target.url || `https://${target.host}`); } catch (e) { return reject(e); }
    const transport = parsed.protocol === "http:" ? http : https;
    const headers = { Accept: "application/json" };
    if (target.statsToken) headers["X-Node-Token"] = target.statsToken;
    const request = transport.get({ hostname: parsed.hostname, port: parsed.port || undefined, path: pathname, timeout: 15000, headers }, (resp) => {
      let body = "";
      resp.on("data", (chunk) => (body += chunk));
      resp.on("end", () => {
        try {
          const data = JSON.parse(body);
          resp.statusCode === 200 ? resolve(data) : reject(new Error("HTTP " + resp.statusCode + ": " + (data.error || "remote error")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}
async function sampleNodes() {
  const targets = [{ key: "self", get: fetchLavalinkStats }, ...EXTRA_NODES.map((n) => ({ key: n.id || n.url || n.host, get: () => fetchRemoteStats(n) }))];
  await Promise.all(targets.map(async (t) => {
    const st = nodeState.get(t.key) || { stats: null, ok: false, history: [] };
    try { st.stats = await t.get(); st.ok = true; } catch (e) { st.ok = false; }
    st.history.push(st.ok);
    if (st.history.length > 5760) st.history.shift(); // 24 jam @ 15 dtk
    nodeState.set(t.key, st);
  }));
}
setInterval(sampleNodes, 15000).unref();
setTimeout(sampleNodes, 3000).unref();
function nodeView(key, name, target) {
  const st = nodeState.get(key);
  const h = st ? st.history : [];
  let parsed;
  try { parsed = new URL(target); } catch (_) { parsed = null; }
  return {
    id: key,
    name,
    url: target,
    host: parsed?.hostname || target,
    port: Number(parsed?.port) || (parsed?.protocol === "http:" ? 80 : 443),
    secure: parsed?.protocol !== "http:",
    online: !!(st && st.ok), stats: st && st.ok ? st.stats : null,
    uptimePct: h.length ? +(h.filter(Boolean).length / h.length * 100).toFixed(2) : null,
    samples: h.length,
  };
}
setInterval(() => { const n = Date.now(); for (const [k, v] of rate) if (!v.some((t) => n - t < 60000)) rate.delete(k); }, 60000).unref();

function lavalinkGet(pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: LAVALINK_PORT, path: pathname, headers: { Authorization: LAVALINK_PASSWORD }, timeout: 20000 },
      (resp) => {
        let body = "";
        resp.on("data", (c) => (body += c));
        resp.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("respons bukan JSON (HTTP " + resp.statusCode + ")")); } });
      }
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}

function fetchLavalinkStats() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: LAVALINK_PORT,
        path: "/v4/stats",
        headers: { Authorization: LAVALINK_PASSWORD },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ ...JSON.parse(body), host: readHostMetrics() });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function checkLavalinkHealthy() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: LAVALINK_PORT,
        path: "/version",
        headers: { Authorization: LAVALINK_PASSWORD },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // Health check untuk Render. /version bawaan Lavalink butuh Authorization (401 tanpa itu),
  // jadi Render tidak bisa memakainya langsung. Endpoint ini yang mengecek Lavalink pakai password.
  if (url === "/healthz") {
    const ok = await checkLavalinkHealthy();
    res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(ok ? "ok" : "lavalink belum siap");
    return;
  }

  // Halaman status publik (info koneksi + statistik live) - tidak butuh login,
  // ini memang dimaksudkan untuk dilihat orang lain yang mau pakai node ini.
  if (url === "/" || url === "/status" || url === "/status/") {
    return serveStatic(res, path.join(publicDir, "index.html"));
  }
  if (url.startsWith("/status/")) {
    const relative = url.replace("/status/", "");
    return serveStatic(res, path.join(publicDir, relative));
  }

  // API stats untuk halaman status. Cuma expose angka agregat (CPU/RAM/players),
  // ditambah metrik host. Jika STATS_TOKEN diisi, endpoint ini hanya bisa
  // dipanggil oleh dashboard pusat atau client yang memegang token tersebut.
  if (url === "/api/stats") {
    if (!hasNodeToken(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stats token required" }));
      return;
    }
    try {
      const stats = await fetchLavalinkStats();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ name: NODE_NAME, ...stats }));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Lavalink belum siap" }));
    }
    return;
  }

  // Data semua node untuk halaman utama (di-cache, aman dipublikasikan: cuma angka agregat + info koneksi).
  if (url === "/api/nodes") {
    const host = SELF_HOST || req.headers.host;
    const selfUrl = SELF_URL || `${req.headers["x-forwarded-proto"] || "http"}://${host}`;
    const list = [nodeView("self", NODE_NAME, selfUrl), ...EXTRA_NODES.map((n) => nodeView(n.id || n.url || n.host, n.name || n.host || n.url, n.url || `https://${n.host}`))];
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(list));
    return;
  }

  // Tes pencarian/resolve track lewat node (buat halaman Player Test).
  // Password dipakai di server, tidak pernah dikirim ke browser. Ada rate limit per IP.
  if (url === "/api/search") {
    const ip = ((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "?").trim();
    const now = Date.now();
    const hits = (rate.get(ip) || []).filter((t) => now - t < 60000);
    hits.push(now);
    rate.set(ip, hits);
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    if (hits.length > 15) return send(429, { error: "Terlalu banyak request, tunggu 1 menit." });

    const q = (new URL(req.url, "http://x").searchParams.get("q") || "").trim().slice(0, 300);
    const src = new URL(req.url, "http://x").searchParams.get("src") || "ytsearch";
    const nodeId = new URL(req.url, "http://x").searchParams.get("node") || "self";
    if (!q) return send(400, { error: "Query kosong." });
    if (!["ytsearch", "ytmsearch", "spsearch", "scsearch"].includes(src)) return send(400, { error: "Sumber tidak valid." });
    const identifier = /^https?:\/\//i.test(q) ? q : `${src}:${q}`;
    try {
      if (nodeId !== "self") {
        const target = findRemoteNode(nodeId);
        if (!target) return send(404, { error: "Node tidak ditemukan." });
        const remotePath = "/api/search?src=" + encodeURIComponent(src) + "&q=" + encodeURIComponent(q);
        return send(200, await fetchRemoteJson(target, remotePath));
      }
      const data = await lavalinkGet("/v4/loadtracks?identifier=" + encodeURIComponent(identifier));
      const d = data.data;
      let list = [];
      if (data.loadType === "search" || data.loadType === "playlist") list = data.loadType === "search" ? d : d.tracks;
      else if (data.loadType === "track") list = [d];
      const tracks = list.slice(0, 10).map((t) => ({
        title: t.info.title, author: t.info.author, length: t.info.length, uri: t.info.uri,
        artwork: t.info.artworkUrl || null, source: t.info.sourceName, live: t.info.isStream,
      }));
      return send(200, {
        loadType: data.loadType,
        playlist: data.loadType === "playlist" ? d.info.name : null,
        error: data.loadType === "error" ? `${d.message}${d.cause ? " — " + d.cause : ""}` : null,
        tracks,
      });
    } catch (e) {
      return send(502, { error: "Lavalink belum siap atau error: " + e.message });
    }
  }

  // Semua request lain (/, /version, /v4/*) diteruskan apa adanya ke Lavalink,
  // supaya bot Discord siapa pun tetap bisa connect lewat 1 port publik ini.
  proxy.web(req, res, {}, () => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad gateway");
    }
  });
});

// WebSocket (dipakai bot untuk /v4/websocket) diteruskan langsung ke Lavalink
server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`[dashboard] listening on port ${PORT}, forwarding to Lavalink at ${LAVALINK_TARGET}`);
});

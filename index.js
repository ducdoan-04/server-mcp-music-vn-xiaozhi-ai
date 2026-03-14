/**
 * MCP VN Music Server v1.2
 * Server kết nối WebSocket CLIENT tới Xiaozhi.me
 */

const express = require("express");
const fetch   = require("node-fetch");
const cors    = require("cors");
const path    = require("path");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BASE = "https://mp3.mrhung.io.vn";

// ─── Lưu thiết bị đang kết nối ────────────────────────────────────────────────
const connectedDevices = new Map();

// ─── MCP Tool definitions ──────────────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: "search_music",
    description: "Tìm kiếm bài hát, ca sĩ nhạc Việt. Trả về danh sách bài hát có encodeId để phát nhạc.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Tên bài hát hoặc ca sĩ cần tìm. Ví dụ: 'sơn tùng', 'lạc trôi'"
        },
        limit: {
          type: "number",
          description: "Số kết quả (mặc định 5, tối đa 10)",
          default: 5
        }
      },
      required: ["query"]
    }
  },
  {
    name: "play_music",
    description: "Lấy link stream nhạc để phát. Trả về streamUrl là direct MP3 link.",
    inputSchema: {
      type: "object",
      properties: {
        encodeId: {
          type: "string",
          description: "Mã bài hát encodeId từ kết quả search_music"
        },
        title:  { type: "string", description: "Tên bài hát" },
        artist: { type: "string", description: "Tên ca sĩ" }
      },
      required: ["encodeId"]
    }
  },
  {
    name: "get_top_charts",
    description: "Lấy danh sách bài hát đang hot/trending trên Zing MP3 Việt Nam.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Số bài (mặc định 10)", default: 10 }
      }
    }
  }
];

// ─── Tool handlers ─────────────────────────────────────────────────────────────
async function handleSearchMusic({ query, limit = 5 }) {
  const n = Math.min(limit, 10);
  const r = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`);
  const data = await r.json();
  const songs = (data?.data?.songs || []).slice(0, n).map(s => ({
    title:     s.title,
    artist:    s.artistsNames,
    album:     s.album?.title || "",
    duration:  formatDur(s.duration),
    encodeId:  s.encodeId,
    thumbnail: s.thumbnailM || "",
    streamUrl: `${BASE}/api/song/stream?id=${s.encodeId}`
  }));
  return songs.length
    ? { message: `Tìm thấy ${songs.length} bài cho "${query}"`, songs }
    : { message: `Không tìm thấy "${query}"`, songs: [] };
}

async function getDirectStreamUrl(encodeId) {
  const proxyUrl = `${BASE}/api/song/stream?id=${encodeId}`;
  try {
    const resp = await fetch(proxyUrl, { redirect: "manual" });
    const loc  = resp.headers.get("location");
    if (loc) return loc;
  } catch (e) {
    console.error(`[getDirectStreamUrl] Lỗi: ${e.message}`);
  }
  return proxyUrl;
}

async function handlePlayMusic({ encodeId, title, artist }) {
  const streamUrl = await getDirectStreamUrl(encodeId);
  const songName  = title ? `${title}${artist ? ` - ${artist}` : ""}` : encodeId;

  console.log(`[play_music] 🎵 ${songName}`);
  console.log(`[play_music] 🔗 ${streamUrl}`);

  return {
    encodeId,
    streamUrl,
    title:   title  || "",
    artist:  artist || "",
    message: `🎵 Bài: ${songName}\nStream: ${streamUrl}`
  };
}

async function handleGetTopCharts({ limit = 10 }) {
  const r = await fetch(`${BASE}/api/search?q=nhạc+hot+2024`);
  const data = await r.json();
  const charts = (data?.data?.songs || []).slice(0, Math.min(limit, 10)).map((s, i) => ({
    rank:     i + 1,
    title:    s.title,
    artist:   s.artistsNames,
    duration: formatDur(s.duration),
    encodeId: s.encodeId,
    streamUrl: `${BASE}/api/song/stream?id=${s.encodeId}`
  }));
  return { message: `🔥 Top ${charts.length} bài hot`, charts };
}

function formatDur(s) {
  if (!s) return "?";
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

// ─── Xử lý message từ Xiaozhi ─────────────────────────────────────────────────
async function handleXiaozhiMessage(ws, raw, deviceName) {
  // Bỏ qua binary frames (audio từ device)
  if (Buffer.isBuffer(raw) && !isJsonBuffer(raw)) return;

  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const { id, method, params } = msg;
  if (!method) return;
  if (method.startsWith("notifications/")) return;

  console.log(`[${deviceName}] ← ${method}`);

  let result = null;
  let error  = null;

  try {
    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities:    { tools: { listChanged: false } },
        serverInfo:      { name: "vn-music-mcp", version: "1.2.0" }
      };

    } else if (method === "tools/list") {
      result = { tools: MCP_TOOLS };

    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      let toolResult;

      if      (name === "search_music")  toolResult = await handleSearchMusic(args);
      else if (name === "play_music")    toolResult = await handlePlayMusic(args);
      else if (name === "get_top_charts") toolResult = await handleGetTopCharts(args);
      else toolResult = { error: `Tool không tồn tại: ${name}` };

      result = { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }] };

    } else if (method === "ping") {
      result = {};
    } else {
      error = { code: -32601, message: `Method not found: ${method}` };
    }
  } catch (e) {
    console.error(`[${deviceName}] ❌ Lỗi:`, e.message);
    error = { code: -32603, message: e.message };
  }

  if (id !== undefined && id !== null) {
    const response = { jsonrpc: "2.0", id };
    if (error) response.error = error;
    else       response.result = result;
    ws.send(JSON.stringify(response));
    console.log(`[${deviceName}] → ${method} OK`);
  }
}

function isJsonBuffer(buf) {
  // Kiểm tra buffer có phải JSON không (bắt đầu bằng { hoặc [)
  const first = buf[0];
  return first === 0x7B || first === 0x5B; // '{' or '['
}

// ─── WebSocket Client tới Xiaozhi ─────────────────────────────────────────────
function connectToXiaozhi(deviceName, wssUrl) {
  const device = connectedDevices.get(deviceName);
  if (device?.ws && device.ws.readyState === WebSocket.OPEN) device.ws.close();
  if (device?.reconnectTimer) clearTimeout(device.reconnectTimer);

  console.log(`[WSS] Đang kết nối tới Xiaozhi: ${deviceName}`);

  const ws = new WebSocket(wssUrl, {
    headers: {
      "User-Agent": "VN-Music-MCP/1.2",
      "Accept":     "application/json"
    }
  });

  connectedDevices.set(deviceName, { ws, url: wssUrl, connectedAt: null, status: "connecting", reconnectTimer: null });

  ws.on("open", () => {
    const dev = connectedDevices.get(deviceName);
    if (dev) { dev.status = "connected"; dev.connectedAt = new Date().toISOString(); }
    console.log(`[WSS] ✅ Đã kết nối: ${deviceName}`);
  });

  ws.on("message", (data) => handleXiaozhiMessage(ws, data, deviceName));

  ws.on("close", (code) => {
    const dev = connectedDevices.get(deviceName);
    if (dev) dev.status = "disconnected";
    console.log(`[WSS] ❌ Ngắt kết nối: ${deviceName} (code ${code})`);

    if (code === 4004) {
      console.error(`[WSS] ⛔ Code 4004 = Token không hợp lệ hoặc session hết hạn. Hãy cập nhật wssUrl.`);
      // Không reconnect khi token lỗi
      return;
    }

    const timer = setTimeout(() => {
      if (connectedDevices.has(deviceName)) {
        console.log(`[WSS] 🔄 Reconnect: ${deviceName}`);
        connectToXiaozhi(deviceName, wssUrl);
      }
    }, 10000);

    if (connectedDevices.has(deviceName)) connectedDevices.get(deviceName).reconnectTimer = timer;
  });

  ws.on("error", (err) => {
    const dev = connectedDevices.get(deviceName);
    if (dev) dev.status = "error";
    console.error(`[WSS] ⚠️ Lỗi: ${deviceName}: ${err.message}`);
  });

  return ws;
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.post("/api/connect", (req, res) => {
  const { deviceName, wssUrl } = req.body;
  if (!deviceName || !wssUrl)
    return res.status(400).json({ error: "Thiếu deviceName hoặc wssUrl" });
  if (!wssUrl.startsWith("wss://"))
    return res.status(400).json({ error: "wssUrl phải bắt đầu bằng wss://" });

  try {
    const ws = connectToXiaozhi(deviceName.trim(), wssUrl.trim());
    const timeout = setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ error: "Timeout kết nối Xiaozhi sau 8s" });
    }, 8000);
    ws.once("open",  () => { clearTimeout(timeout); if (!res.headersSent) res.json({ success: true, message: `✅ Đã kết nối "${deviceName}"!` }); });
    ws.once("error", (err) => { clearTimeout(timeout); if (!res.headersSent) res.status(500).json({ error: err.message }); });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/disconnect", (req, res) => {
  const { deviceName } = req.body;
  const dev = connectedDevices.get(deviceName);
  if (!dev) return res.json({ message: "Thiết bị không tồn tại" });
  if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
  if (dev.ws)             dev.ws.close();
  connectedDevices.delete(deviceName);
  res.json({ success: true, message: `Đã ngắt kết nối "${deviceName}"` });
});

app.get("/api/devices", (req, res) => {
  const list = [];
  connectedDevices.forEach((dev, name) => {
    list.push({ name, status: dev.status, connectedAt: dev.connectedAt,
                url: dev.url.replace(/token=.{10,}/, "token=***") });
  });
  res.json({ devices: list });
});

app.get("/api", (req, res) => {
  res.json({ name: "VN Music MCP", version: "1.2.0",
             connectedDevices: connectedDevices.size,
             tools: MCP_TOOLS.map(t => ({ name: t.name })) });
});

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ error: "Thiếu ?q=" });
  res.json(await handleSearchMusic({ query: q, limit: 5 }));
});

app.get("/play", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ error: "Thiếu ?id=" });
  res.redirect(await getDirectStreamUrl(id));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", devices: connectedDevices.size, uptime: Math.floor(process.uptime()) + "s" });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("===================================");
  console.log(" 🎵 VN Music MCP Server v1.2");
  console.log(`    http://localhost:${PORT}`);
  console.log("===================================");
  console.log(` Connect: POST /api/connect`);
  console.log(` Devices: GET  /api/devices`);
  console.log(` Search:  GET  /search?q=xxx`);
  console.log(` Play:    GET  /play?id=xxx`);
  console.log("===================================");
});

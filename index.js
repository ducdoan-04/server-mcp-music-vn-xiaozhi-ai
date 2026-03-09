/**
 * MCP VN Music Server
 * Server kết nối WebSocket CLIENT tới Xiaozhi.me và inject MCP tools âm nhạc
 */

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BASE = "https://mp3.mrhung.io.vn";

// ─── Lưu các thiết bị đang kết nối ─────────────────────────────────────────
const connectedDevices = new Map();
// deviceName -> { ws, url, connectedAt, status, reconnectTimer }

// ─── MCP Tool definitions ────────────────────────────────────────────────────
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
    description: "Lấy link stream MP3 từ encodeId để Xiaozhi phát qua loa.",
    inputSchema: {
      type: "object",
      properties: {
        encodeId: {
          type: "string",
          description: "Mã bài hát encodeId từ kết quả search_music"
        }
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

// ─── Tool handlers ────────────────────────────────────────────────────────────
async function handleSearchMusic({ query, limit = 5 }) {
  const n = Math.min(limit, 10);
  const r = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`);
  const data = await r.json();
  const songs = (data?.data?.songs || []).slice(0, n).map(s => ({
    title: s.title,
    artist: s.artistsNames,
    album: s.album?.title || "",
    duration: formatDur(s.duration),
    encodeId: s.encodeId,
    thumbnail: s.thumbnailM || "",
    streamUrl: `${BASE}/api/song/stream?id=${s.encodeId}`
  }));
  return songs.length
    ? { message: `Tìm thấy ${songs.length} bài cho "${query}"`, songs }
    : { message: `Không tìm thấy "${query}"`, songs: [] };
}

async function handlePlayMusic({ encodeId }) {
  const streamUrl = `${BASE}/api/song/stream?id=${encodeId}`;
  return {
    encodeId,
    streamUrl,
    message: `🎵 Stream URL: ${streamUrl}`
  };
}

async function handleGetTopCharts({ limit = 10 }) {
  const r = await fetch(`${BASE}/api/search?q=nhạc+hot+2024`);
  const data = await r.json();
  const charts = (data?.data?.songs || []).slice(0, Math.min(limit, 10)).map((s, i) => ({
    rank: i + 1,
    title: s.title,
    artist: s.artistsNames,
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

// ─── Xử lý message từ Xiaozhi (MCP JSON-RPC qua WebSocket) ──────────────────
async function handleXiaozhiMessage(ws, raw, deviceName) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const { id, method, params } = msg;
  console.log(`[${deviceName}] ← ${method || msg.type || "?"}`);

  // Ping / pong / notification — không cần trả lời
  if (!method || method.startsWith("notifications/")) return;

  let result = null;
  let error = null;

  try {
    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vn-music-mcp", version: "1.0.0" }
      };
    } else if (method === "tools/list") {
      result = { tools: MCP_TOOLS };
    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      let toolResult;
      if (name === "search_music") toolResult = await handleSearchMusic(args);
      else if (name === "play_music") toolResult = await handlePlayMusic(args);
      else if (name === "get_top_charts") toolResult = await handleGetTopCharts(args);
      else toolResult = { error: `Tool không tồn tại: ${name}` };
      result = { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }] };
    } else if (method === "ping") {
      result = {};
    } else {
      error = { code: -32601, message: `Method not found: ${method}` };
    }
  } catch (e) {
    error = { code: -32603, message: e.message };
  }

  if (id !== undefined && id !== null) {
    const response = { jsonrpc: "2.0", id };
    if (error) response.error = error;
    else response.result = result;
    ws.send(JSON.stringify(response));
    console.log(`[${deviceName}] → ${method} OK`);
  }
}

// ─── Kết nối WebSocket Client tới Xiaozhi ────────────────────────────────────
function connectToXiaozhi(deviceName, wssUrl) {
  const device = connectedDevices.get(deviceName);

  // Nếu đang kết nối rồi thì đóng trước
  if (device?.ws && device.ws.readyState === WebSocket.OPEN) {
    device.ws.close();
  }
  if (device?.reconnectTimer) clearTimeout(device.reconnectTimer);

  console.log(`[WSS] Đang kết nối tới Xiaozhi: ${deviceName}`);

  const ws = new WebSocket(wssUrl, {
    headers: {
      "User-Agent": "VN-Music-MCP/1.0",
      "Accept": "application/json"
    }
  });

  connectedDevices.set(deviceName, {
    ws,
    url: wssUrl,
    connectedAt: null,
    status: "connecting",
    reconnectTimer: null
  });

  ws.on("open", () => {
    const dev = connectedDevices.get(deviceName);
    if (dev) {
      dev.status = "connected";
      dev.connectedAt = new Date().toISOString();
    }
    console.log(`[WSS] ✅ Đã kết nối: ${deviceName}`);
  });

  ws.on("message", (data) => handleXiaozhiMessage(ws, data, deviceName));

  ws.on("close", (code, reason) => {
    const dev = connectedDevices.get(deviceName);
    if (dev) dev.status = "disconnected";
    console.log(`[WSS] ❌ Ngắt kết nối: ${deviceName} (code ${code})`);

    // Tự reconnect sau 10s
    const timer = setTimeout(() => {
      if (connectedDevices.has(deviceName)) {
        console.log(`[WSS] 🔄 Reconnect: ${deviceName}`);
        connectToXiaozhi(deviceName, wssUrl);
      }
    }, 10000);

    if (connectedDevices.has(deviceName)) {
      connectedDevices.get(deviceName).reconnectTimer = timer;
    }
  });

  ws.on("error", (err) => {
    const dev = connectedDevices.get(deviceName);
    if (dev) dev.status = "error";
    console.error(`[WSS] ⚠️ Lỗi: ${deviceName}: ${err.message}`);
  });

  return ws;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Kết nối thiết bị mới
app.post("/api/connect", (req, res) => {
  const { deviceName, wssUrl } = req.body;
  if (!deviceName || !wssUrl) {
    return res.status(400).json({ error: "Thiếu deviceName hoặc wssUrl" });
  }
  if (!wssUrl.startsWith("wss://")) {
    return res.status(400).json({ error: "wssUrl phải bắt đầu bằng wss://" });
  }

  try {
    const ws = connectToXiaozhi(deviceName.trim(), wssUrl.trim());

    // Chờ open hoặc error
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({ error: "Timeout: Không kết nối được Xiaozhi sau 8s" });
      }
    }, 8000);

    ws.once("open", () => {
      clearTimeout(timeout);
      if (!res.headersSent) {
        res.json({ success: true, message: `✅ Đã kết nối "${deviceName}" thành công!` });
      }
    });

    ws.once("error", (err) => {
      clearTimeout(timeout);
      if (!res.headersSent) {
        res.status(500).json({ error: `Không kết nối được: ${err.message}` });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ngắt kết nối thiết bị
app.post("/api/disconnect", (req, res) => {
  const { deviceName } = req.body;
  const dev = connectedDevices.get(deviceName);
  if (!dev) return res.json({ message: "Thiết bị không tồn tại" });

  if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
  if (dev.ws) dev.ws.close();
  connectedDevices.delete(deviceName);

  res.json({ success: true, message: `Đã ngắt kết nối "${deviceName}"` });
});

// Danh sách thiết bị
app.get("/api/devices", (req, res) => {
  const list = [];
  connectedDevices.forEach((dev, name) => {
    list.push({
      name,
      status: dev.status,
      url: dev.url.replace(/token=.{10,}/, "token=***"),
      connectedAt: dev.connectedAt
    });
  });
  res.json({ devices: list });
});

// Info
app.get("/api", (req, res) => {
  res.json({
    name: "VN Music MCP Server",
    version: "1.0.0",
    source: BASE,
    connectedDevices: connectedDevices.size,
    tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description }))
  });
});

// REST search
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ error: "Thiếu ?q=" });
  res.json(await handleSearchMusic({ query: q, limit: 5 }));
});

// REST play
app.get("/play", (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ error: "Thiếu ?id=" });
  res.redirect(`${BASE}/api/song/stream?id=${id}`);
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    devices: connectedDevices.size,
    uptime: Math.floor(process.uptime()) + "s",
    time: new Date().toISOString()
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("===================================");
  console.log(" 🎵 VN Music MCP Server");
  console.log(`    http://localhost:${PORT}`);
  console.log("===================================");
  console.log(` Connect API: POST /api/connect`);
  console.log(` Devices:     GET  /api/devices`);
  console.log(` Search:      GET  /search?q=xxx`);
  console.log("===================================");
});

/**
 * MCP VN Music Server v3.0
 * Server kết nối WebSocket CLIENT tới Xiaozhi.me
 * Features: 80+ AI Tools + Music (Search, Play, Stream, Info, Lyrics)
 */

const express = require("express");
const fetch   = require("node-fetch");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { getAllBonionMCPTools, handleBonionToolCall, fetchBonionServers } = require("./tools");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BASE = "https://mp3.mrhung.io.vn";

// ─── Lưu thiết bị đang kết nối ────────────────────────────────────────────────
const connectedDevices = new Map();

// ─── Persistent device storage ─────────────────────────────────────────────────
const DEVICES_FILE = path.join(__dirname, "devices.json");

/**
 * Đọc danh sách thiết bị đã lưu từ file
 */
function loadSavedDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = fs.readFileSync(DEVICES_FILE, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error(`[storage] ❌ Lỗi đọc devices.json: ${e.message}`);
  }
  return [];
}

/**
 * Lưu danh sách thiết bị ra file
 */
function saveDevicesToFile(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), "utf-8");
    console.log(`[storage] 💾 Đã lưu ${devices.length} thiết bị vào devices.json`);
  } catch (e) {
    console.error(`[storage] ❌ Lỗi ghi devices.json: ${e.message}`);
  }
}

/**
 * Thêm/cập nhật thiết bị vào danh sách lưu
 */
function addSavedDevice(deviceName, wssUrl) {
  const devices = loadSavedDevices();
  const idx = devices.findIndex(d => d.deviceName === deviceName);
  const entry = {
    deviceName,
    wssUrl,
    savedAt: new Date().toISOString(),
    autoConnect: true
  };
  if (idx >= 0) {
    devices[idx] = { ...devices[idx], ...entry };
  } else {
    devices.push(entry);
  }
  saveDevicesToFile(devices);
}

/**
 * Xóa thiết bị khỏi danh sách lưu
 */
function removeSavedDevice(deviceName) {
  const devices = loadSavedDevices();
  const filtered = devices.filter(d => d.deviceName !== deviceName);
  saveDevicesToFile(filtered);
  return filtered.length < devices.length;
}

/**
 * Cập nhật trạng thái autoConnect
 */
function updateAutoConnect(deviceName, autoConnect) {
  const devices = loadSavedDevices();
  const dev = devices.find(d => d.deviceName === deviceName);
  if (dev) {
    dev.autoConnect = autoConnect;
    saveDevicesToFile(devices);
    return true;
  }
  return false;
}

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
    name: "get_stream_url",
    description: "Lấy link stream trực tiếp (direct MP3 URL) để phát nhạc. Trả về URL có thể dùng trực tiếp trong trình phát nhạc.",
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
    name: "get_song_info",
    description: "Lấy thông tin chi tiết bài hát: tên, ca sĩ, album, thể loại, nhạc sĩ sáng tác, thời lượng, ảnh bìa, lượt thích, v.v.",
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
    name: "get_lyrics",
    description: "Lấy lời bài hát (lyrics) bao gồm cả lời có đồng bộ thời gian (synced lyrics) và lời plain text.",
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

async function handleGetStreamUrl({ encodeId }) {
  const streamUrl = await getDirectStreamUrl(encodeId);
  const proxyUrl  = `${BASE}/api/song/stream?id=${encodeId}`;

  console.log(`[get_stream_url] 🔗 ${encodeId} → ${streamUrl}`);

  return {
    encodeId,
    streamUrl,
    proxyUrl,
    message: `🔗 Link stream cho ${encodeId}:\n- Direct: ${streamUrl}\n- Proxy: ${proxyUrl}`
  };
}

async function handleGetSongInfo({ encodeId }) {
  const r = await fetch(`${BASE}/api/info-song?id=${encodeId}`);
  const data = await r.json();

  if (data.err !== 0 || !data.data) {
    return { error: `Không tìm thấy thông tin bài hát: ${encodeId}`, encodeId };
  }

  const s = data.data;
  const info = {
    encodeId:    s.encodeId,
    title:       s.title,
    artist:      s.artistsNames,
    artists:     (s.artists || []).map(a => ({ name: a.name, id: a.id, thumbnail: a.thumbnail, followers: a.totalFollow })),
    album:       s.album ? { title: s.album.title, releaseDate: s.album.releaseDate } : null,
    genres:      (s.genres || []).map(g => g.name),
    composers:   (s.composers || []).map(c => c.name),
    duration:    formatDur(s.duration),
    durationSec: s.duration,
    thumbnail:   s.thumbnailM || s.thumbnail || "",
    releaseDate: s.releaseDate ? new Date(s.releaseDate * 1000).toLocaleDateString("vi-VN") : "",
    hasLyric:    s.hasLyric || false,
    like:        s.like || 0,
    comment:     s.comment || 0,
    streamUrl:   `${BASE}/api/song/stream?id=${s.encodeId}`
  };

  console.log(`[get_song_info] ℹ️ ${info.title} - ${info.artist}`);

  return {
    ...info,
    message: `ℹ️ ${info.title} - ${info.artist}\n🎵 Album: ${info.album?.title || 'N/A'}\n🎹 Thể loại: ${info.genres.join(', ')}\n✍️ Sáng tác: ${info.composers.join(', ')}\n⏱️ Thời lượng: ${info.duration}\n❤️ ${info.like.toLocaleString()} lượt thích`
  };
}

async function handleGetLyrics({ encodeId }) {
  const r = await fetch(`${BASE}/api/lyric?id=${encodeId}`);
  const data = await r.json();

  if (data.err !== 0 || !data.data) {
    return { error: `Không tìm thấy lời bài hát: ${encodeId}`, encodeId, hasLyric: false };
  }

  const lrcUrl = data.data.file || "";
  let plainText = "";
  let syncedLyrics = [];

  // Tải và parse file .lrc nếu có
  if (lrcUrl) {
    try {
      const lrcResp = await fetch(lrcUrl);
      const lrcContent = await lrcResp.text();

      // Parse LRC format
      const lines = lrcContent.split(/\r?\n/);
      const textLines = [];

      for (const line of lines) {
        const match = line.match(/^\[(\d{2}):(\d{2}\.\d{2})\](.*)$/);
        if (match) {
          const minutes = parseInt(match[1]);
          const seconds = parseFloat(match[2]);
          const text = match[3].trim();
          if (text) {
            syncedLyrics.push({
              time: `${match[1]}:${match[2]}`,
              timeSec: minutes * 60 + seconds,
              text
            });
            textLines.push(text);
          }
        } else if (line.startsWith("[") && line.includes("]")) {
          // Metadata lines like [ar:], [ti:], etc.
          const metaMatch = line.match(/^\[([a-z]+):\s*(.+)\]$/i);
          if (metaMatch) {
            // Skip metadata in plain text
          }
        }
      }

      plainText = textLines.join("\n");
    } catch (e) {
      console.error(`[get_lyrics] Lỗi tải LRC: ${e.message}`);
    }
  }

  console.log(`[get_lyrics] 📝 ${encodeId} - ${syncedLyrics.length} dòng`);

  return {
    encodeId,
    hasLyric: true,
    lrcUrl,
    plainText,
    syncedLyrics,
    totalLines: syncedLyrics.length,
    message: plainText
      ? `📝 Lời bài hát (${syncedLyrics.length} dòng):\n\n${plainText}`
      : `Không có lời bài hát cho ${encodeId}`
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
        serverInfo:      { name: "vn-music-mcp", version: "3.0.0" }
      };

    } else if (method === "tools/list") {
      // Merge music tools + 80+ bonion tools
      // OPTIMIZED: Loại bỏ inputSchema để giảm kích thước response (fix code 1009)
      const bonionTools = await getAllBonionMCPTools();
      const toolsList = [...MCP_TOOLS, ...bonionTools].map(t => ({
        name: t.name,
        description: t.description
      }));
      result = { tools: toolsList };

    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      let toolResult;

      // Music tools (local handlers)
      if      (name === "search_music")   toolResult = await handleSearchMusic(args);
      else if (name === "play_music")     toolResult = await handlePlayMusic(args);
      else if (name === "get_stream_url") toolResult = await handleGetStreamUrl(args);
      else if (name === "get_song_info")  toolResult = await handleGetSongInfo(args);
      else if (name === "get_lyrics")     toolResult = await handleGetLyrics(args);
      else if (name === "get_top_charts") toolResult = await handleGetTopCharts(args);
      // Bonion tools (fallback to bonion handler)
      else toolResult = await handleBonionToolCall(name, args);

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
  const { deviceName, wssUrl, saveDevice, reconnect } = req.body;

  // Reconnect mode: lấy wssUrl từ saved devices
  if (reconnect && deviceName) {
    const saved = loadSavedDevices();
    const dev = saved.find(d => d.deviceName === deviceName);
    if (!dev) return res.status(404).json({ error: `Không tìm thấy thiết bị "${deviceName}" trong danh sách lưu` });

    try {
      const ws = connectToXiaozhi(deviceName, dev.wssUrl);
      const timeout = setTimeout(() => {
        if (!res.headersSent) res.status(504).json({ error: "Timeout kết nối sau 8s" });
      }, 8000);
      ws.once("open", () => { clearTimeout(timeout); if (!res.headersSent) res.json({ success: true, message: `✅ Đã kết nối lại "${deviceName}"!` }); });
      ws.once("error", (err) => { clearTimeout(timeout); if (!res.headersSent) res.status(500).json({ error: err.message }); });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (!deviceName || !wssUrl)
    return res.status(400).json({ error: "Thiếu deviceName hoặc wssUrl" });
  if (!wssUrl.startsWith("wss://"))
    return res.status(400).json({ error: "wssUrl phải bắt đầu bằng wss://" });

  try {
    const trimName = deviceName.trim();
    const trimUrl  = wssUrl.trim();
    const ws = connectToXiaozhi(trimName, trimUrl);
    const timeout = setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ error: "Timeout kết nối Xiaozhi sau 8s" });
    }, 8000);
    ws.once("open",  () => {
      clearTimeout(timeout);
      // Tự động lưu thiết bị khi kết nối thành công (mặc định saveDevice = true)
      if (saveDevice !== false) {
        addSavedDevice(trimName, trimUrl);
      }
      if (!res.headersSent) res.json({ success: true, message: `✅ Đã kết nối "${trimName}"!`, saved: saveDevice !== false });
    });
    ws.once("error", (err) => { clearTimeout(timeout); if (!res.headersSent) res.status(500).json({ error: err.message }); });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/disconnect", (req, res) => {
  const { deviceName, removeFromSaved } = req.body;
  const dev = connectedDevices.get(deviceName);
  if (!dev) return res.json({ message: "Thiết bị không tồn tại" });
  if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
  if (dev.ws)             dev.ws.close();
  connectedDevices.delete(deviceName);
  // Nếu yêu cầu xóa khỏi danh sách lưu
  if (removeFromSaved) {
    removeSavedDevice(deviceName);
  }
  res.json({ success: true, message: `Đã ngắt kết nối "${deviceName}"`, removedFromSaved: !!removeFromSaved });
});

app.get("/api/devices", (req, res) => {
  const list = [];
  connectedDevices.forEach((dev, name) => {
    list.push({ name, status: dev.status, connectedAt: dev.connectedAt,
                url: dev.url.replace(/token=.{10,}/, "token=***") });
  });
  res.json({ devices: list });
});

// ─── Saved Devices API ────────────────────────────────────────────────────────
app.get("/api/saved-devices", (req, res) => {
  const saved = loadSavedDevices().map(d => ({
    ...d,
    wssUrl: d.wssUrl.replace(/token=.{10,}/, "token=***"),
    isConnected: connectedDevices.has(d.deviceName) && connectedDevices.get(d.deviceName).status === "connected"
  }));
  res.json({ savedDevices: saved, total: saved.length });
});

app.post("/api/save-device", (req, res) => {
  const { deviceName, wssUrl } = req.body;
  if (!deviceName || !wssUrl)
    return res.status(400).json({ error: "Thiếu deviceName hoặc wssUrl" });
  addSavedDevice(deviceName.trim(), wssUrl.trim());
  res.json({ success: true, message: `💾 Đã lưu thiết bị "${deviceName}"` });
});

app.post("/api/remove-saved-device", (req, res) => {
  const { deviceName } = req.body;
  if (!deviceName)
    return res.status(400).json({ error: "Thiếu deviceName" });
  const removed = removeSavedDevice(deviceName);
  if (removed) {
    res.json({ success: true, message: `🗑️ Đã xóa "${deviceName}" khỏi danh sách lưu` });
  } else {
    res.json({ success: false, message: `Không tìm thấy "${deviceName}" trong danh sách lưu` });
  }
});

app.post("/api/toggle-auto-connect", (req, res) => {
  const { deviceName, autoConnect } = req.body;
  if (!deviceName)
    return res.status(400).json({ error: "Thiếu deviceName" });
  const updated = updateAutoConnect(deviceName, autoConnect);
  if (updated) {
    res.json({ success: true, message: `${autoConnect ? '✅' : '⏸️'} AutoConnect ${autoConnect ? 'bật' : 'tắt'} cho "${deviceName}"` });
  } else {
    res.json({ success: false, message: `Không tìm thấy "${deviceName}" trong danh sách lưu` });
  }
});

app.post("/api/reconnect-all", async (req, res) => {
  const saved = loadSavedDevices();
  const toConnect = saved.filter(d => d.autoConnect !== false);

  if (toConnect.length === 0) {
    return res.json({ success: false, message: "Không có thiết bị nào để kết nối lại" });
  }

  let connected = 0;
  let failed = 0;

  for (const dev of toConnect) {
    try {
      // Bỏ qua nếu đã kết nối
      const existing = connectedDevices.get(dev.deviceName);
      if (existing && existing.status === "connected") {
        connected++;
        continue;
      }
      connectToXiaozhi(dev.deviceName, dev.wssUrl);
      connected++;
      // Delay giữa các kết nối
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`[reconnect-all] ❌ ${dev.deviceName}: ${e.message}`);
      failed++;
    }
  }

  res.json({
    success: true,
    message: `🔄 Đã gửi kết nối lại ${connected}/${toConnect.length} thiết bị${failed ? ` (${failed} lỗi)` : ''}`,
    connected,
    failed,
    total: toConnect.length
  });
});

app.get("/api", async (req, res) => {
  const bonionTools = await getAllBonionMCPTools();
  const allTools = [...MCP_TOOLS, ...bonionTools];
  res.json({ name: "VN Music MCP", version: "3.0.0",
             connectedDevices: connectedDevices.size,
             totalTools: allTools.length,
             musicTools: MCP_TOOLS.length,
             bonionTools: bonionTools.length,
             tools: allTools.map(t => ({ name: t.name, description: t.description })) });
});

// REST API: Danh sách tools
app.get("/api/tools", async (req, res) => {
  const bonionTools = await getAllBonionMCPTools();
  res.json({ total: MCP_TOOLS.length + bonionTools.length,
             music: MCP_TOOLS,
             bonion: bonionTools });
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

// REST API: Lấy link stream trực tiếp
app.get("/stream", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ error: "Thiếu ?id=" });
  res.json(await handleGetStreamUrl({ encodeId: id }));
});

// REST API: Lấy thông tin bài hát
app.get("/info", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ error: "Thiếu ?id=" });
  res.json(await handleGetSongInfo({ encodeId: id }));
});

// REST API: Lấy lời bài hát
app.get("/lyrics", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ error: "Thiếu ?id=" });
  res.json(await handleGetLyrics({ encodeId: id }));
});

// Debug endpoint
app.get("/debug/bonion", async (req, res) => {
  console.log("[DEBUG] Checking Bonion API connectivity...");
  try {
    const servers = await fetchBonionServers();
    let totalTools = 0;
    for (const server of servers) {
      if (server.enabled && Array.isArray(server.tools)) {
        totalTools += server.tools.filter(t => t.enabled).length;
      }
    }
    res.json({
      status: "OK",
      servers: servers.length,
      bonionTools: totalTools,
      serverDetails: servers.map(s => ({
        name: s.name,
        enabled: s.enabled,
        tools: Array.isArray(s.tools) ? s.tools.filter(t => t.enabled).length : 0
      })),
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({
      status: "ERROR",
      error: e.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", devices: connectedDevices.size, uptime: Math.floor(process.uptime()) + "s" });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("========================================");
  console.log(" 🎵 VN Music MCP Server v3.0");
  console.log(`    http://localhost:${PORT}`);
  console.log("========================================");
  console.log(" 🎶 Music Tools (6):");
  console.log(`   search_music / play_music / get_stream_url`);
  console.log(`   get_song_info / get_lyrics / get_top_charts`);
  console.log("----------------------------------------");

  // Pre-load bonion tools
  const bonionTools = await getAllBonionMCPTools();
  console.log(` 🧠 Bonion AI Tools: ${bonionTools.length}`);
  console.log(` 📊 Tổng cộng: ${6 + bonionTools.length} tools`);
  console.log("----------------------------------------");
  console.log(" REST API:");
  console.log(`   POST /api/connect        GET /api/devices`);
  console.log(`   GET  /api/saved-devices  POST /api/save-device`);
  console.log(`   POST /api/remove-saved-device`);
  console.log(`   GET  /api/tools          GET /search?q=xxx`);
  console.log(`   GET  /play?id=xxx        GET /stream?id=xxx`);
  console.log(`   GET  /info?id=xxx        GET /lyrics?id=xxx`);
  console.log("========================================");

  // ─── Auto-reconnect saved devices ────────────────────────────────────────────
  const savedDevices = loadSavedDevices();
  if (savedDevices.length > 0) {
    console.log(`\n[storage] 📂 Tìm thấy ${savedDevices.length} thiết bị đã lưu`);
    for (const dev of savedDevices) {
      if (dev.autoConnect !== false) {
        console.log(`[storage] 🔄 Tự động kết nối: ${dev.deviceName}`);
        try {
          connectToXiaozhi(dev.deviceName, dev.wssUrl);
        } catch (e) {
          console.error(`[storage] ❌ Lỗi kết nối ${dev.deviceName}: ${e.message}`);
        }
        // Delay giữa các kết nối để tránh overload
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`[storage] ⏸️ Bỏ qua (autoConnect tắt): ${dev.deviceName}`);
      }
    }
    console.log(`[storage] ✅ Hoàn tất auto-reconnect\n`);
  } else {
    console.log(`\n[storage] 📂 Chưa có thiết bị nào được lưu`);
  }
});

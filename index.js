/**
 * MCP VN Music Server - chuẩn SSE cho Xiaozhi.me
 * Kết nối với mp3.mrhung.io.vn
 *
 * Xiaozhi sẽ gọi:
 *   GET /sse         => kết nối SSE + nhận sessionId
 *   POST /messages   => gửi JSON-RPC (initialize, tools/list, tools/call)
 */

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

// Phục vụ web UI từ thư mục public
app.use(express.static(path.join(__dirname, "public")));

const BASE = "https://mp3.mrhung.io.vn";

// ─── Lưu trữ SSE clients ─────────────────────────────────────────────────────
const sseClients = new Map(); // sessionId -> res

// ─── Định nghĩa MCP Tools ────────────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: "search_music",
    description: "Tìm kiếm bài hát, ca sĩ nhạc Việt. Trả về danh sách bài hát có encodeId để phát nhạc.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Tên bài hát hoặc ca sĩ cần tìm. Ví dụ: 'sơn tùng', 'lạc trôi', 'bích phương'"
        },
        limit: {
          type: "number",
          description: "Số lượng kết quả trả về (mặc định: 5, tối đa: 10)",
          default: 5
        }
      },
      required: ["query"]
    }
  },
  {
    name: "play_music",
    description: "Lấy link stream nhạc từ encodeId để phát. Trả về URL stream trực tiếp.",
    inputSchema: {
      type: "object",
      properties: {
        encodeId: {
          type: "string",
          description: "Mã bài hát encodeId lấy từ kết quả search_music"
        }
      },
      required: ["encodeId"]
    }
  },
  {
    name: "get_top_charts",
    description: "Lấy danh sách bài hát đang hot/trending hiện tại trên Zing MP3 Việt Nam.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Số bài hát muốn lấy (mặc định: 10)",
          default: 10
        }
      }
    }
  }
];

// ─── SSE Helper ──────────────────────────────────────────────────────────────
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Tool Handlers ───────────────────────────────────────────────────────────
async function handleSearchMusic(args) {
  const { query, limit = 5 } = args;
  const maxLimit = Math.min(limit, 10);

  try {
    const response = await fetch(
      `${BASE}/api/search?q=${encodeURIComponent(query)}`
    );
    const data = await response.json();

    if (data.err !== 0) {
      return { error: "Không tìm được bài hát. Thử lại với từ khóa khác." };
    }

    const songs = (data?.data?.songs || []).slice(0, maxLimit).map((s) => ({
      title: s.title,
      artist: s.artistsNames,
      album: s.album?.title || "",
      duration: formatDuration(s.duration),
      encodeId: s.encodeId,
      thumbnail: s.thumbnailM || s.thumbnail || "",
      streamUrl: `${BASE}/api/song/stream?id=${s.encodeId}`
    }));

    if (songs.length === 0) {
      return {
        message: `Không tìm thấy bài hát nào với từ khóa "${query}"`,
        songs: []
      };
    }

    return {
      message: `Tìm thấy ${songs.length} bài hát cho "${query}"`,
      songs,
      note: "Dùng encodeId và tool play_music để phát bài hát"
    };
  } catch (err) {
    return { error: `Lỗi kết nối: ${err.message}` };
  }
}

async function handlePlayMusic(args) {
  const { encodeId } = args;

  try {
    // Kiểm tra stream có tồn tại không
    const streamUrl = `${BASE}/api/song/stream?id=${encodeId}`;
    const check = await fetch(streamUrl, { method: "HEAD" });

    if (check.ok || check.status === 302) {
      return {
        encodeId,
        streamUrl,
        message: `🎵 Đang phát nhạc! Stream URL: ${streamUrl}`,
        note: "Xiaozhi sẽ phát URL này qua loa"
      };
    } else {
      return {
        error: "Không tìm thấy stream cho bài hát này",
        encodeId
      };
    }
  } catch (err) {
    // Vẫn trả về URL dù không check được
    const streamUrl = `${BASE}/api/song/stream?id=${encodeId}`;
    return {
      encodeId,
      streamUrl,
      message: `🎵 Stream URL: ${streamUrl}`
    };
  }
}

async function handleGetTopCharts(args) {
  const { limit = 10 } = args;

  try {
    // Tìm top chart bằng cách search trending
    const response = await fetch(`${BASE}/api/search?q=nhạc+hot+2024`);
    const data = await response.json();

    const songs = (data?.data?.songs || []).slice(0, Math.min(limit, 10)).map((s, i) => ({
      rank: i + 1,
      title: s.title,
      artist: s.artistsNames,
      duration: formatDuration(s.duration),
      encodeId: s.encodeId,
      streamUrl: `${BASE}/api/song/stream?id=${s.encodeId}`
    }));

    return {
      message: `🔥 Top ${songs.length} bài hát hot`,
      charts: songs
    };
  } catch (err) {
    return { error: `Lỗi: ${err.message}` };
  }
}

function formatDuration(seconds) {
  if (!seconds) return "unknown";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── MCP JSON-RPC Handler ────────────────────────────────────────────────────
async function handleJsonRpc(body, sessionId) {
  const { id, method, params } = body;

  // initialize
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: "vn-music-mcp",
          version: "1.0.0"
        }
      }
    };
  }

  // notifications/initialized
  if (method === "notifications/initialized") {
    return null; // no response needed
  }

  // tools/list
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS }
    };
  }

  // tools/call
  if (method === "tools/call") {
    const { name, arguments: args } = params;
    let toolResult;

    try {
      if (name === "search_music") {
        toolResult = await handleSearchMusic(args);
      } else if (name === "play_music") {
        toolResult = await handlePlayMusic(args);
      } else if (name === "get_top_charts") {
        toolResult = await handleGetTopCharts(args);
      } else {
        toolResult = { error: `Tool không tồn tại: ${name}` };
      }
    } catch (err) {
      toolResult = { error: err.message };
    }

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(toolResult, null, 2)
          }
        ]
      }
    };
  }

  // ping
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`
    }
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// API info endpoint
app.get("/api", (req, res) => {
  res.json({
    name: "VN Music MCP Server",
    description: "MCP server âm nhạc Việt Nam cho Xiaozhi.me",
    version: "1.0.0",
    source: BASE,
    endpoints: {
      sse: "/sse (GET) - Kết nối SSE cho Xiaozhi",
      messages: "/messages?sessionId=xxx (POST) - Gửi lệnh MCP",
      search: "/search?q=tên+bài+hát (GET) - Tìm kiếm nhanh",
      play: "/play?id=encodeId (GET) - Stream nhạc"
    },
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description }))
  });
});

// SSE endpoint - Xiaozhi kết nối vào đây
app.get("/sse", (req, res) => {
  const sessionId = uuidv4();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Lưu client
  sseClients.set(sessionId, res);
  console.log(`[SSE] Client kết nối: ${sessionId}`);

  // Gửi endpoint để Xiaozhi biết POST vào đâu
  sendSSE(res, "endpoint", {
    uri: `/messages?sessionId=${sessionId}`
  });

  // Keepalive mỗi 15 giây
  const keepAlive = setInterval(() => {
    if (sseClients.has(sessionId)) {
      res.write(": keepalive\n\n");
    } else {
      clearInterval(keepAlive);
    }
  }, 15000);

  // Xử lý disconnect
  req.on("close", () => {
    sseClients.delete(sessionId);
    clearInterval(keepAlive);
    console.log(`[SSE] Client ngắt kết nối: ${sessionId}`);
  });
});

// Messages endpoint - Xiaozhi gửi JSON-RPC vào đây
app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;

  if (!sessionId || !sseClients.has(sessionId)) {
    return res.status(400).json({
      error: "sessionId không hợp lệ hoặc phiên đã hết hạn. Vui lòng kết nối lại qua /sse"
    });
  }

  const sseRes = sseClients.get(sessionId);
  const body = req.body;

  console.log(`[MCP] ${sessionId.slice(0, 8)} -> ${body.method}`);

  try {
    const response = await handleJsonRpc(body, sessionId);

    if (response !== null) {
      sendSSE(sseRes, "message", response);
    }

    res.status(202).json({ status: "accepted" });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// REST endpoints tiện lợi (dùng test hoặc truy cập trực tiếp)
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ error: "Thiếu tham số q. Ví dụ: /search?q=sơn+tùng" });

  const result = await handleSearchMusic({ query: q, limit: 5 });
  res.json(result);
});

app.get("/play", (req, res) => {
  const id = req.query.id;
  if (!id) return res.json({ error: "Thiếu tham số id. Ví dụ: /play?id=ZW79ZBE8" });
  res.redirect(`${BASE}/api/song/stream?id=${id}`);
});

app.get("/charts", async (req, res) => {
  const result = await handleGetTopCharts({ limit: 10 });
  res.json(result);
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    clients: sseClients.size,
    uptime: Math.floor(process.uptime()) + "s",
    time: new Date().toISOString()
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("===================================");
  console.log(" 🎵 VN Music MCP Server");
  console.log(`    http://localhost:${PORT}`);
  console.log("===================================");
  console.log(` SSE:      http://localhost:${PORT}/sse`);
  console.log(` Search:   http://localhost:${PORT}/search?q=sontung`);
  console.log(` Play:     http://localhost:${PORT}/play?id=ZW79ZBE8`);
  console.log(` Charts:   http://localhost:${PORT}/charts`);
  console.log(` Health:   http://localhost:${PORT}/health`);
  console.log("===================================");
});

/**
 * MCP Tools Collection v2.0
 * 80+ công cụ mở rộng trí tuệ AI cho Xiaozhi
 * Nguồn: mcp.bonion.io.vn
 */

const fetch = require("node-fetch");

const BONION_API = "https://mcp.bonion.io.vn/api/get-mcp-servers";

// Cache tools từ bonion
let cachedBonionTools = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 phút

/**
 * Lấy danh sách tools từ bonion API (có cache)
 */
async function fetchBonionTools() {
  const now = Date.now();
  if (cachedBonionTools && (now - cacheTime) < CACHE_TTL) {
    return cachedBonionTools;
  }

  try {
    const r = await fetch(BONION_API, { timeout: 10000 });
    const json = await r.json();
    if (json.success && json.data) {
      cachedBonionTools = json.data;
      cacheTime = now;
      console.log(`[tools] ✅ Đã tải ${json.data.length} MCP servers từ bonion`);
      return json.data;
    }
  } catch (e) {
    console.error(`[tools] ❌ Lỗi tải tools từ bonion: ${e.message}`);
  }
  return cachedBonionTools || [];
}

/**
 * Chuyển đổi bonion tools sang MCP tool format
 */
async function getAllBonionMCPTools() {
  const servers = await fetchBonionTools();
  const tools = [];

  for (const server of servers) {
    if (!server.enabled || !server.tools) continue;
    for (const tool of server.tools) {
      if (!tool.enabled) continue;
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || { type: "object", properties: {} }
      });
    }
  }

  return tools;
}

/**
 * Xử lý tool call - trả về prompt-based response
 * Các tools này là prompt-based, AI sẽ xử lý dựa trên description + input
 */
async function handleBonionToolCall(toolName, args) {
  // Tìm tool info
  const servers = await fetchBonionTools();
  let toolInfo = null;
  let serverName = null;

  for (const server of servers) {
    if (!server.tools) continue;
    for (const tool of server.tools) {
      if (tool.name === toolName) {
        toolInfo = tool;
        serverName = server.name;
        break;
      }
    }
    if (toolInfo) break;
  }

  if (!toolInfo) {
    return { error: `Tool không tồn tại: ${toolName}` };
  }

  // Tạo response dựa trên tool type
  const response = {
    tool: toolName,
    server: serverName,
    description: toolInfo.description,
    input: args,
    instruction: `Hãy thực hiện vai trò "${serverName}" với yêu cầu sau. ${toolInfo.description}. Dữ liệu đầu vào: ${JSON.stringify(args, null, 2)}`
  };

  console.log(`[tools] 🔧 ${serverName} → ${toolName}`);

  return response;
}

module.exports = {
  fetchBonionTools,
  getAllBonionMCPTools,
  handleBonionToolCall
};

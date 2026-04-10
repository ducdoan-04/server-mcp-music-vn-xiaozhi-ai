/**
 * MCP Tools Collection v3.0
 * 80+ công cụ mở rộng trí tuệ AI cho Xiaozhi
 * Nguồn: https://mcp.bonion.io.vn/api/get-mcp-servers
 */

const fetch = require("node-fetch");

const BONION_API = "https://mcp.bonion.io.vn/api/get-mcp-servers";

// Cache tools từ bonion
let cachedBonionServers = null;
let cachedBonionToolsFlat = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 phút cache

/**
 * Lấy danh sách MCP servers từ Bonion API
 * API trả về: { success: true, data: [...servers] }
 * Mỗi server có: { name, status, tools: [...], enabled }
 */
async function fetchBonionServers() {
  const now = Date.now();
  
  // Kiểm tra cache
  if (cachedBonionServers && (now - cacheTime) < CACHE_TTL) {
    console.log(`[tools] 💾 Sử dụng cache Bonion (${Math.round((now - cacheTime) / 1000)}s old)`);
    return cachedBonionServers;
  }

  try {
    console.log(`[tools] 🔷 Fetching từ Bonion API...`);
    const r = await fetch(BONION_API, { 
      timeout: 15000,
      headers: { 'User-Agent': 'MCP-Music-Server/3.0' }
    });
    
    console.log(`[tools] 📡 Response status: ${r.status}`);
    
    if (!r.ok) {
      console.error(`[tools] ❌ HTTP ${r.status}: ${r.statusText}`);
      return cachedBonionServers || [];
    }
    
    const json = await r.json();
    console.log(`[tools] 📦 Response: success=${json.success}, servers=${json.data?.length || 0}`);
    
    if (json.success && Array.isArray(json.data)) {
      cachedBonionServers = json.data;
      cacheTime = now;
      cachedBonionToolsFlat = null; // Reset flat cache
      
      // Log tóm tắt
      let totalTools = 0;
      for (const server of json.data) {
        if (server.enabled && Array.isArray(server.tools)) {
          totalTools += server.tools.filter(t => t.enabled).length;
        }
      }
      console.log(`[tools] ✅ Đã load: ${json.data.length} servers, ${totalTools} tools enabled`);
      
      return json.data;
    } else {
      console.error(`[tools] ❌ Response format lỗi:`, json);
      return cachedBonionServers || [];
    }
  } catch (e) {
    console.error(`[tools] ❌ Error: ${e.message}`);
    if (e.code === 'ENOTFOUND') {
      console.error(`[tools] ❌ DNS Error: Không resolve được mcp.bonion.io.vn`);
    } else if (e.code === 'ECONNREFUSED') {
      console.error(`[tools] ❌ Connection refused: Server không hoạt động`);
    } else if (e.code === 'ETIMEDOUT') {
      console.error(`[tools] ❌ Timeout: API không phản hồi trong 15s`);
    }
    return cachedBonionServers || [];
  }
}

/**
 * Chuyển đổi bonion servers → flat tools array (MCP format)
 */
async function getAllBonionMCPTools() {
  // Nếu đã có cache flat, trả về
  if (cachedBonionToolsFlat) {
    return cachedBonionToolsFlat;
  }

  const servers = await fetchBonionServers();
  const tools = [];
  const toolNameMap = {}; // Theo dõi duplicate tool names

  for (const server of servers) {
    // Skip disabled servers
    if (server.enabled === false) continue;
    if (!Array.isArray(server.tools)) continue;

    for (const tool of server.tools) {
      // Skip disabled tools
      if (tool.enabled === false) continue;
      
      // Skip tools without name
      if (!tool.name || !tool.description) continue;

      // Tạo tool object, ghép server name vào
      const toolName = tool.name;
      const mncTool = {
        name: toolName,
        description: `[${server.name}] ${tool.description}`,
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        _serverName: server.name, // Metadata để handle tool call
        _serverId: server.name
      };

      // Kiểm tra duplicate
      if (toolNameMap[toolName]) {
        console.warn(`[tools] ⚠️  Duplicate tool: ${toolName} (${server.name} & ${toolNameMap[toolName]})`);
      } else {
        toolNameMap[toolName] = server.name;
        tools.push(mncTool);
      }
    }
  }

  cachedBonionToolsFlat = tools;
  return tools;
}

/**
 * Xử lý tool call - trả về prompt-based response
 */
async function handleBonionToolCall(toolName, args) {
  const servers = await fetchBonionServers();
  let toolInfo = null;
  let serverName = null;

  // Tìm tool
  for (const server of servers) {
    if (!Array.isArray(server.tools)) continue;
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
    console.warn(`[tools] ⚠️  Tool not found: ${toolName}`);
    return { error: `Tool không tồn tại: ${toolName}` };
  }

  const response = {
    tool: toolName,
    server: serverName,
    description: toolInfo.description,
    input: args,
    instruction: `Hãy thực hiện vai trò "${serverName}" với yêu cầu sau.\n\nMô tả: ${toolInfo.description}\n\nDữ liệu đầu vào:\n${JSON.stringify(args, null, 2)}`
  };

  console.log(`[tools] 🔧 Call: ${serverName} → ${toolName}`);

  return response;
}

module.exports = {
  fetchBonionServers,
  fetchBonionTools: () => fetchBonionServers(), // Alias để backward compatibility
  getAllBonionMCPTools,
  handleBonionToolCall
};

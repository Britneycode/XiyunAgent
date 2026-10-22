// MCP echo 测试服务器:提供 echo / add 两个工具,供 stdio 端到端测试使用。
// 直接用 SDK 的底层 Server + JSON Schema,不依赖 zod(它是可选 peer)。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "echo",
    description: "回显传入的文本",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "add",
    description: "两数相加",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "echo") return { content: [{ type: "text", text: `echo: ${String(args?.text ?? "")}` }] };
  if (name === "add") return { content: [{ type: "text", text: String(Number(args?.a ?? 0) + Number(args?.b ?? 0)) }] };
  return { content: [{ type: "text", text: `未知工具:${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());

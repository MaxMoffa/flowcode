// Flowcode's MCP server, handed to chat agents over ACP. It does nothing itself:
// Flowcode reads the tool call from the chat stream and acts on it there.
const readline = require("node:readline");

const TOOLS = [
  {
    name: "open_in_browser",
    description:
      "Show a web page or a file to the user in Flowcode. Always use this instead of shell commands like start, open, xdg-open or Start-Process, which would open the page a second time in the system browser.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "An http(s) URL, or the path of a file to preview (html, svg, pdf, image, video).",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
];

const send = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);

function answer(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "flowcode", version: "1.0.0" },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call" && TOOLS.some((tool) => tool.name === params?.name)) {
    return { content: [{ type: "text", text: "Sent to Flowcode." }] };
  }
  return null;
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || !message.method) return;
  const result = answer(message.method, message.params);
  if (result) send(message.id, { result });
  else send(message.id, { error: { code: -32601, message: "Method not found" } });
});

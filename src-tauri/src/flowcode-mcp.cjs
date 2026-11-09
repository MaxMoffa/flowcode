// Flowcode's MCP server, handed to chat agents over ACP (stdio, JSON-RPC lines).
// It owns no logic: each tool call becomes a request file in a folder Flowcode
// watches (works on Windows and inside WSL, no network), and the answer comes
// back as a response file. Node >= 18, no dependencies.
//
// Environment, set by Flowcode: FLOWCODE_MCP_DIR (the folder), FLOWCODE_MCP_TOKEN
// (which chat is calling) and FLOWCODE_MCP_TOOLS (comma list of the tools to offer).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const DIR = process.env.FLOWCODE_MCP_DIR || "";
const TOKEN = process.env.FLOWCODE_MCP_TOKEN || "";
const ENABLED = (process.env.FLOWCODE_MCP_TOOLS || "").split(",").map((name) => name.trim()).filter(Boolean);
const POLL_MS = 150;

const TASK_NOTES =
  "The delegated agent is a separate chat that sees ONLY the prompt you give it: no conversation, no files you read, no context. Make the prompt self-contained.";

const TOOLS = [
  {
    name: "open_in_browser",
    timeoutMs: 15_000,
    description:
      "Show a web page or a file to the user in Flowcode's own browser panel. Always use this instead of shell commands like start, open, xdg-open or Start-Process, which would open the page a second time in the system browser. PDFs (a .pdf URL or file) open in Flowcode's built-in PDF viewer.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "An http(s) URL, or the path of a file to preview (html, svg, pdf, image, video). A relative path is resolved from the chat's working folder.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agents",
    timeoutMs: 15_000,
    description:
      "List the agents you can delegate tasks to with delegate_task, and whether each one is available right now. Call it before delegating if you are unsure which agents exist.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delegate_task",
    // Covers the agent's start (an adapter may download itself the first time).
    timeoutMs: 180_000,
    description:
      "Hand a self-contained task to another coding agent, which works on it in its own chat while you carry on. " +
      TASK_NOTES +
      " Returns a task_id as soon as the agent has started; then use get_task_result with the task_id to wait for its answer. You may start several tasks in parallel (for example one per independent question), then collect them all. The user sees every task and can answer its permission prompts.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Which agent runs the task: one of the ids returned by list_agents (for example claude, codex, gemini, opencode)." },
        prompt: { type: "string", description: "The complete task. It is the only thing the agent receives, so include every detail it needs and say what the answer should contain." },
        title: { type: "string", description: "A short label for the task, 60 characters at most, shown to the user." },
      },
      required: ["agent", "prompt", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task_result",
    timeoutMs: 60_000,
    description:
      "Wait for a task started with delegate_task and return its status: running, waiting_for_user (the agent needs the user to answer a question, keep waiting), done (with the agent's final answer), failed or cancelled. Waits up to wait_seconds (default and maximum 45) and returns early when the task ends; call it again while the status is running.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id returned by delegate_task." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 45, description: "How long to wait for the task to finish. Default 45; 0 only checks." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_task",
    timeoutMs: 15_000,
    description: "Stop a task started with delegate_task that is no longer needed.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "The task_id returned by delegate_task." } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
];

const offered = () => TOOLS.filter((tool) => ENABLED.includes(tool.name));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Sends one request to Flowcode and waits for its answer file; `{ ok, text | error }`. */
async function ask(tool, args) {
  if (!DIR || !TOKEN) return { ok: false, error: "Flowcode did not configure this server (missing folder or token)." };
  const id = crypto.randomUUID();
  const request = path.join(DIR, `req-${id}.json`);
  const response = path.join(DIR, `res-${id}.json`);
  const deadline = Date.now() + tool.timeoutMs;
  try {
    writeAtomic(request, JSON.stringify({ id, token: TOKEN, tool: tool.name, args: args ?? {}, deadline_ms: deadline }));
  } catch (e) {
    return { ok: false, error: `Could not reach Flowcode: ${e.message}` };
  }
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let text;
    try {
      text = fs.readFileSync(response, "utf8");
    } catch {
      continue;
    }
    try {
      const answer = JSON.parse(text);
      fs.rmSync(response, { force: true });
      return answer;
    } catch {
      // Not readable yet: try again on the next tick.
    }
  }
  fs.rmSync(request, { force: true });
  return { ok: false, error: "Flowcode did not answer in time. Is the Flowcode window still open?" };
}

const send = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);

async function call(id, params) {
  const tool = offered().find((t) => t.name === params?.name);
  if (!tool) return send(id, { error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
  const answer = await ask(tool, params.arguments);
  const text = answer.ok ? answer.text ?? "" : answer.error ?? "Flowcode refused the request.";
  send(id, { result: { content: [{ type: "text", text }], isError: !answer.ok } });
}

function answer(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "flowcode", version: "2.0.0" },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") {
    return { tools: offered().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
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
  if (message.method === "tools/call") {
    void call(message.id, message.params);
    return;
  }
  const result = answer(message.method, message.params);
  if (result) send(message.id, { result });
  else send(message.id, { error: { code: -32601, message: "Method not found" } });
});

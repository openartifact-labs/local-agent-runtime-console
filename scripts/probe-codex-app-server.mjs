import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const isWindows = process.platform === "win32";
const codexBin = process.env.CODEX_BIN || "codex";
const directWindowsBinary = isWindows && /\.(exe|com)$/i.test(codexBin);
const command = isWindows && !directWindowsBinary
  ? process.env.ComSpec || "cmd.exe"
  : codexBin;
const args = isWindows && !directWindowsBinary
  ? ["/d", "/s", "/c", `${codexBin} app-server --stdio`]
  : ["app-server", "--stdio"];

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const pending = new Map();
let requestId = 0;
let stderr = "";

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timeout);

  if (message.error) {
    waiter.reject(new Error(message.error.message || "app-server 请求失败"));
  } else {
    waiter.resolve(message.result);
  }
});

const send = (message) => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
};

const request = (method, params) => {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 请求超时`));
    }, 15_000);
    pending.set(id, { resolve, reject, timeout });
    send({ method, id, params });
  });
};

const sourceKinds = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

try {
  const initialized = await request("initialize", {
    clientInfo: {
      name: "local_agent_runtime_console_probe",
      title: "Local Agent Runtime Console Probe",
      version: "0.1.0",
    },
  });
  send({ method: "initialized", params: {} });

  const result = await request("thread/list", {
    limit: 10,
    sortKey: "recency_at",
    sortDirection: "desc",
    sourceKinds,
  });

  const tasks = Array.isArray(result?.data) ? result.data : [];
  console.log(
    JSON.stringify(
      {
        connected: true,
        userAgent: initialized?.userAgent,
        platformFamily: initialized?.platformFamily,
        taskCountInPage: tasks.length,
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          preview: task.preview,
          cwd: task.cwd,
          status: task.status?.type,
          source: task.source,
          updatedAt: task.updatedAt,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (stderr.trim()) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}

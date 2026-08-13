import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import { ProviderUnavailableError, errorMessage } from "../errors.js";
import { hasRpcId, isJsonObject, type InitializeResponse, type JsonObject, type JsonRpcId, type JsonRpcNotification, type JsonRpcResponse } from "./protocol.js";

export interface ClientLogger {
  debug(context: object, message: string): void;
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export type CodexConnectionStatus =
  | { state: "connected"; serverInfo: InitializeResponse }
  | { state: "disconnected"; reason: string }
  | { state: "reconnecting"; attempt: number; delayMs: number };

export interface CodexRpcClient {
  readonly connected: boolean;
  readonly serverInfo?: InitializeResponse;
  connect(): Promise<void>;
  request<T>(method: string, params?: JsonObject): Promise<T>;
  notify(method: string, params?: JsonObject): void;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  onStatus(listener: (status: CodexConnectionStatus) => void): () => void;
  close(): Promise<void>;
}

interface PendingRequest { resolve(value: unknown): void; reject(reason: unknown): void; timeout: NodeJS.Timeout; }
export interface CodexAppServerClientOptions {
  command: string;
  requestTimeoutMs: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  logger: ClientLogger;
  platform?: NodeJS.Platform;
  comSpec?: string;
  spawnProcess?: typeof spawn;
}

export function appServerSpawnSpec(command: string, platform: NodeJS.Platform, comSpec = process.env.ComSpec || "cmd.exe") {
  if (platform !== "win32") return { file: command, args: ["app-server", "--stdio"] };
  if (/\.(exe|com)$/i.test(command)) return { file: command, args: ["app-server", "--stdio"] };
  if (/[\r\n&|<>^]/.test(command)) throw new ProviderUnavailableError("CODEX_BIN 包含不安全的 shell 字符");
  // cmd.exe 负责解析 npm 的 .cmd shim；不使用 shell:true，避免 DEP0190 与不可控转义。
  const commandLine = /\s/.test(command)
    ? `""${command}" app-server --stdio"`
    : `${command} app-server --stdio`;
  return { file: comSpec, args: ["/d", "/s", "/c", commandLine] };
}

export class CodexAppServerClient implements CodexRpcClient {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly statusListeners = new Set<(status: CodexConnectionStatus) => void>();
  private readonly spawnProcess: typeof spawn;
  private process?: ChildProcessWithoutNullStreams;
  private reader?: ReadLineInterface;
  private connectPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private requestId = 0;
  private reconnectAttempt = 0;
  private closing = false;
  private _connected = false;
  private _serverInfo?: InitializeResponse;

  constructor(private readonly options: CodexAppServerClientOptions) { this.spawnProcess = options.spawnProcess ?? spawn; }
  get connected(): boolean { return this._connected; }
  get serverInfo(): InitializeResponse | undefined { return this._serverInfo; }

  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.closing) throw new ProviderUnavailableError("Codex App Server 客户端已关闭");
    if (!this.connectPromise) this.connectPromise = this.openConnection().finally(() => { this.connectPromise = undefined; });
    return this.connectPromise;
  }
  async request<T>(method: string, params: JsonObject = {}): Promise<T> { await this.connect(); return this.sendRequest<T>(method, params); }
  notify(method: string, params: JsonObject = {}): void {
    if (!this._connected) throw new ProviderUnavailableError("Codex App Server 尚未连接");
    this.write({ method, params });
  }
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void { this.notificationListeners.add(listener); return () => this.notificationListeners.delete(listener); }
  onStatus(listener: (status: CodexConnectionStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending(new ProviderUnavailableError("Codex App Server 客户端正在关闭"));
    const child = this.process;
    this.process = undefined; this._connected = false; this.reader?.close(); this.reader = undefined;
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 2_000); timeout.unref();
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }

  private async openConnection(): Promise<void> {
    const spec = appServerSpawnSpec(this.options.command, this.options.platform ?? process.platform, this.options.comSpec);
    const child = this.spawnProcess(spec.file, spec.args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.process = child; this.bindProcess(child);
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const serverInfo = await this.sendRequest<InitializeResponse>("initialize", {
        clientInfo: { name: "local_agent_runtime_console", title: "Local Agent Runtime Console", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized", params: {} });
      this._serverInfo = serverInfo; this._connected = true; this.reconnectAttempt = 0;
      this.emitStatus({ state: "connected", serverInfo });
      this.options.logger.info({ userAgent: serverInfo.userAgent }, "Codex App Server 已连接");
    } catch (error) {
      this.handleDisconnect(child, `启动或初始化失败：${errorMessage(error)}`);
      throw new ProviderUnavailableError(`无法启动 Codex App Server：${errorMessage(error)}`, { cause: error });
    }
  }
  private bindProcess(child: ChildProcessWithoutNullStreams): void {
    this.reader = createInterface({ input: child.stdout }); this.reader.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => { const message = chunk.toString("utf8").trim(); if (message) this.options.logger.debug({ message }, "Codex App Server stderr"); });
    child.on("error", (error) => this.handleDisconnect(child, errorMessage(error)));
    child.on("exit", (code, signal) => this.handleDisconnect(child, `进程退出 code=${String(code)} signal=${String(signal)}`));
  }
  private handleLine(line: string): void {
    let value: unknown; try { value = JSON.parse(line); } catch (error) { this.options.logger.warn({ error: errorMessage(error) }, "忽略无法解析的 Codex JSONL 消息"); return; }
    if (!isJsonObject(value)) return;
    if (hasRpcId(value) && ("result" in value || "error" in value) && !("method" in value)) { this.handleResponse(value as JsonRpcResponse); return; }
    if (typeof value.method === "string" && hasRpcId(value)) {
      this.write({ id: value.id, error: { code: -32601, message: `AI Runtime Console 暂不支持服务端请求 ${value.method}` } }); return;
    }
    if (typeof value.method === "string") {
      const notification = { method: value.method, params: isJsonObject(value.params) ? value.params : {} };
      for (const listener of this.notificationListeners) listener(notification);
    }
  }
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id); if (!pending) return;
    this.pending.delete(response.id); clearTimeout(pending.timeout);
    if (response.error) { pending.reject(new ProviderUnavailableError(`Codex 请求失败 [${response.error.code}]：${response.error.message}`)); return; }
    pending.resolve(response.result);
  }
  private sendRequest<T>(method: string, params: JsonObject): Promise<T> {
    if (!this.process) throw new ProviderUnavailableError("Codex App Server 进程不存在");
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new ProviderUnavailableError(`Codex 请求 ${method} 超时`)); }, this.options.requestTimeoutMs); timeout.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
  private write(message: object): void {
    if (!this.process || this.process.stdin.destroyed || !this.process.stdin.writable) throw new ProviderUnavailableError("Codex App Server 输入流不可用");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private handleDisconnect(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.process !== child) return;
    this.process = undefined; this.reader?.close(); this.reader = undefined;
    const shouldPublish = this._connected || !this.closing; this._connected = false;
    this.rejectPending(new ProviderUnavailableError(`Codex App Server 连接中断：${reason}`));
    if (shouldPublish) { this.emitStatus({ state: "disconnected", reason }); this.options.logger.warn({ reason }, "Codex App Server 连接已断开"); }
    if (!this.closing) this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const attempt = ++this.reconnectAttempt; const delayMs = Math.min(this.options.reconnectBaseDelayMs * 2 ** (attempt - 1), this.options.reconnectMaxDelayMs);
    this.emitStatus({ state: "reconnecting", attempt, delayMs });
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch((error) => this.options.logger.warn({ error: errorMessage(error), attempt }, "Codex App Server 重连失败")); }, delayMs); this.reconnectTimer.unref();
  }
  private rejectPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); } this.pending.clear(); }
  private emitStatus(status: CodexConnectionStatus): void { for (const listener of this.statusListeners) listener(status); }
}

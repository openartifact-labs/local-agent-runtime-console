import type {
  AgentRuntimeProvider,
  LaunchTaskInput,
  LaunchTaskResult,
  ProviderDescriptor,
  ProviderEvent,
  ProviderUsageAnalytics,
  ProviderUsageSnapshot,
  RuntimeObservation,
  RuntimeRun,
  RuntimeTask,
  TaskStatus,
} from "@openartifact-labs/runtime-contracts";

import { ProviderUnavailableError } from "../errors.js";
import type { CodexRpcClient } from "./codex-app-server-client.js";
import { CODEX_THREAD_SOURCE_KINDS, type CodexThread, type CodexTurn, type ThreadListResponse, type ThreadReadResponse, type ThreadStartResponse, type TurnStartResponse } from "./protocol.js";
import { CodexRolloutObserver, type RolloutObservation } from "./rollout-observer.js";
import { CodexUsageAnalyzer } from "./usage-analyzer.js";

export const CODEX_PROVIDER_ID = "codex-local";

export interface CodexProviderOptions { pageSize: number; maxPages: number; staleAfterMs: number; }

function codexTimestamp(value: number | null | undefined): string {
  return value === null || value === undefined
    ? new Date().toISOString()
    : new Date(value * 1_000).toISOString();
}
function taskStatus(thread: CodexThread, observation: RolloutObservation | undefined, staleAfterMs: number): TaskStatus {
  const status = thread.status?.type;
  if (status === "systemError") return "failed";
  if (status === "active") return thread.status?.activeFlags?.length ? "waiting" : "running";
  if (observation?.status === "running" && observation.lastObservedAt) {
    const idleMs = Date.now() - Date.parse(observation.lastObservedAt);
    if (Number.isFinite(idleMs) && idleMs >= staleAfterMs) return "stale";
  }
  if (observation?.status) return observation.status;
  if (status === "notLoaded") return "not_loaded";
  if (status === "idle") return "idle";
  return "unknown";
}
function title(thread: CodexThread, latestUserMessage?: string): string {
  const value = thread.name?.trim() || latestUserMessage || thread.preview?.trim();
  return (value || `Codex 任务 ${thread.id}`).replace(/\s+/g, " ").slice(0, 512);
}

function codexVersion(userAgent?: string): string | undefined {
  return userAgent?.match(/Codex(?: Desktop)?\/([^\s]+)/)?.[1];
}

export function mapCodexThread(
  thread: CodexThread,
  source: RuntimeTask["source"] = "discovered",
  observation?: RolloutObservation,
  staleAfterMs = 180_000,
): RuntimeTask {
  const latestUserMessage = observation?.latestUserMessage;
  return {
    id: thread.id, externalId: thread.id, providerId: CODEX_PROVIDER_ID, title: title(thread, latestUserMessage),
    summary: latestUserMessage || thread.preview?.trim() || undefined, cwd: thread.cwd || undefined,
    model: thread.model || thread.modelProvider || undefined, source, status: taskStatus(thread, observation, staleAfterMs),
    createdAt: codexTimestamp(thread.createdAt),
    updatedAt: codexTimestamp(thread.updatedAt),
    lastActivityAt: codexTimestamp(thread.recencyAt ?? thread.updatedAt),
    relation: observation?.relation,
  };
}

export class CodexProvider implements AgentRuntimeProvider {
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly threadPaths = new Map<string, string>();
  private recentUsageTasks: RuntimeTask[] = [];
  private latestUsage?: ProviderUsageSnapshot;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly client: CodexRpcClient,
    private readonly options: CodexProviderOptions,
    private readonly rolloutObserver = new CodexRolloutObserver(),
    private readonly usageAnalyzer = new CodexUsageAnalyzer(CODEX_PROVIDER_ID),
  ) {
    this.unsubscribe = client.onNotification((notification) => {
      const event = { method: notification.method, params: notification.params ?? {}, receivedAt: new Date().toISOString() };
      for (const listener of this.listeners) listener(event);
    });
  }
  async descriptor(): Promise<ProviderDescriptor> {
    try {
      await this.client.connect();
      return { id: CODEX_PROVIDER_ID, kind: "codex", name: "本机 Codex", connected: true,
        capabilities: { discoverTasks: true, launchTask: true, deepObservation: true, interruptRun: true, tokenUsage: true },
        version: codexVersion(this.client.serverInfo?.userAgent), message: "已连接 Codex App Server" };
    } catch (error) {
      return { id: CODEX_PROVIDER_ID, kind: "codex", name: "本机 Codex", connected: false,
        capabilities: { discoverTasks: true, launchTask: true, deepObservation: true, interruptRun: true, tokenUsage: true },
        message: error instanceof Error ? error.message : "Codex App Server 不可用" };
    }
  }
  async listTasks(): Promise<RuntimeTask[]> {
    const threads: CodexThread[] = []; let cursor: string | null = null;
    for (let page = 0; page < this.options.maxPages; page += 1) {
      const response: ThreadListResponse = await this.client.request<ThreadListResponse>("thread/list", {
        cursor, limit: this.options.pageSize, sortKey: "recency_at", sortDirection: "desc",
        // Codex 默认只返回 cli/vscode；这里显式覆盖所有已知来源，确保全局看板完整。
        sourceKinds: [...CODEX_THREAD_SOURCE_KINDS],
      });
      threads.push(...(response.data ?? []));
      cursor = response.nextCursor;
      if (!cursor) return this.mapObservedThreads(threads);
    }
    throw new ProviderUnavailableError(`Codex 任务分页超过最大页数 ${this.options.maxPages}`);
  }
  async getTask(externalId: string): Promise<RuntimeTask | null> {
    try {
      const response = await this.client.request<ThreadReadResponse>("thread/read", { threadId: externalId, includeTurns: false });
      if (response.thread.path) this.threadPaths.set(response.thread.id, response.thread.path);
      const observation = response.thread.path ? await this.rolloutObserver.inspect(response.thread.path) : undefined;
      const task = mapCodexThread(response.thread, "discovered", observation, this.options.staleAfterMs);
      if (observation) this.captureUsage(task, observation);
      return task;
    } catch { return null; }
  }
  async readObservation(task: RuntimeTask): Promise<RuntimeObservation | null> {
    let path = this.threadPaths.get(task.externalId);
    if (!path) {
      try {
        const response = await this.client.request<ThreadReadResponse>("thread/read", {
          threadId: task.externalId,
          includeTurns: false,
        });
        path = response.thread.path ?? undefined;
        if (path) this.threadPaths.set(task.externalId, path);
      } catch {
        return null;
      }
    }
    if (!path) return null;

    const observation = await this.rolloutObserver.inspect(path);
    this.captureUsage(task, observation);
    if (!observation.run && observation.events.length === 0 && !observation.output) return null;

    const startedAt = observation.run?.startedAt
      ?? observation.events[0]?.occurredAt
      ?? task.lastActivityAt
      ?? task.updatedAt;
    const runId = observation.run?.turnId ?? `rollout:${task.externalId}`;
    // 列表同步已经结合静默时长判定失联，详情读取不能被 rollout 中遗留的 running 覆盖。
    const effectiveStatus = task.status === "stale" ? task.status : observation.status ?? task.status;
    const runStatus = this.observedRunStatus(effectiveStatus);
    const completedAt = observation.run?.completedAt;
    const inferredEndAt = runStatus === "stale" ? observation.lastObservedAt : undefined;
    const durationMs = observation.run?.durationMs
      ?? (runStatus === "running" ? Math.max(0, Date.now() - Date.parse(startedAt)) : undefined)
      ?? (inferredEndAt ? Math.max(0, Date.parse(inferredEndAt) - Date.parse(startedAt)) : undefined);
    const run: RuntimeRun = {
      id: runId,
      externalId: observation.run?.turnId,
      taskId: task.id,
      status: runStatus,
      prompt: observation.latestUserMessage,
      startedAt,
      completedAt,
      durationMs,
      inputTokens: observation.run?.inputTokens,
      cachedInputTokens: observation.run?.cachedInputTokens,
      cacheWriteInputTokens: observation.run?.cacheWriteInputTokens,
      outputTokens: observation.run?.outputTokens,
      reasoningOutputTokens: observation.run?.reasoningOutputTokens,
      totalTokens: observation.run?.totalTokens,
      toolCallCount: observation.run?.toolCallCount ?? 0,
    };

    return {
      run,
      events: observation.events.map((event) => ({
        ...event,
        runId,
        taskId: task.id,
        providerId: CODEX_PROVIDER_ID,
      })),
      output: observation.output ? {
        id: `rollout-output:${runId}`,
        runId,
        taskId: task.id,
        content: observation.output.content,
        format: "markdown",
        isFinal: observation.output.isFinal,
        createdAt: observation.output.createdAt,
      } : undefined,
    };
  }
  async launchTask(input: LaunchTaskInput): Promise<LaunchTaskResult> {
    const start = await this.client.request<ThreadStartResponse>("thread/start", {
      cwd: input.cwd, model: input.model || undefined, approvalPolicy: "never", sandbox: "workspace-write",
      serviceName: "local_agent_runtime_console",
    });
    const turn = await this.client.request<TurnStartResponse>("turn/start", {
      threadId: start.thread.id, input: [{ type: "text", text: input.prompt }], cwd: input.cwd,
      model: input.model || undefined, effort: input.reasoningEffort || undefined,
    });
    const task = mapCodexThread({ ...start.thread, cwd: start.cwd || input.cwd, model: start.model || input.model, status: { type: "active", activeFlags: [] } }, "managed");
    const startedAt = codexTimestamp(turn.turn.startedAt);
    return { task, run: { id: turn.turn.id, externalId: turn.turn.id, taskId: task.id, status: "running", prompt: input.prompt, startedAt, toolCallCount: 0 } };
  }
  async interruptRun(taskExternalId: string, runExternalId: string): Promise<void> {
    await this.client.request("turn/interrupt", { threadId: taskExternalId, turnId: runExternalId });
  }
  onEvent(listener: (event: ProviderEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async getUsageSnapshot(): Promise<ProviderUsageSnapshot | null> {
    // 手动刷新只检查最近活跃会话，既能读取刚落盘的 token_count，又避免扫描全部历史 rollout。
    await Promise.all(this.recentUsageTasks.slice(0, 8).map(async (task) => {
      const path = this.threadPaths.get(task.externalId);
      if (!path) return;
      this.captureUsage(task, await this.rolloutObserver.inspect(path));
    }));
    return this.latestUsage ? {
      ...this.latestUsage,
      usage: { ...this.latestUsage.usage },
      rateLimit: this.latestUsage.rateLimit ? { ...this.latestUsage.rateLimit } : undefined,
    } : null;
  }
  async getUsageAnalytics(days = 30): Promise<ProviderUsageAnalytics> {
    return this.usageAnalyzer.analyze(this.threadPaths.values(), days);
  }
  async close(): Promise<void> { this.unsubscribe(); await this.client.close(); }

  private async mapObservedThreads(threads: CodexThread[]): Promise<RuntimeTask[]> {
    this.threadPaths.clear();
    const results = new Array<RuntimeTask>(threads.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < threads.length) {
        const index = cursor; cursor += 1;
        const thread = threads[index]!;
        if (thread.path) this.threadPaths.set(thread.id, thread.path);
        const observation = thread.path ? await this.rolloutObserver.inspect(thread.path) : undefined;
        const task = mapCodexThread(thread, "discovered", observation, this.options.staleAfterMs);
        if (observation) this.captureUsage(task, observation);
        results[index] = task;
      }
    };
    // 限制并发文件读取，避免首次同步大量历史会话时占用过多内存和磁盘带宽。
    await Promise.all(Array.from({ length: Math.min(4, threads.length) }, () => worker()));
    this.recentUsageTasks = results.slice(0, 8);
    return results;
  }

  private observedRunStatus(status?: TaskStatus): RuntimeRun["status"] {
    if (status === "completed" || status === "idle") return "completed";
    if (status === "failed") return "failed";
    if (status === "interrupted") return "interrupted";
    if (status === "stale") return "stale";
    return "running";
  }

  private captureUsage(task: RuntimeTask, observation: RolloutObservation): void {
    if (!observation.usageSnapshot) return;
    if (this.latestUsage && Date.parse(this.latestUsage.observedAt) > Date.parse(observation.usageSnapshot.observedAt)) return;
    this.latestUsage = {
      ...observation.usageSnapshot,
      providerId: CODEX_PROVIDER_ID,
      taskExternalId: task.externalId,
      taskTitle: task.title,
    };
  }
}

export function extractTurn(params: Record<string, unknown>): CodexTurn | undefined {
  const turn = params.turn;
  return turn && typeof turn === "object" && "id" in turn ? turn as CodexTurn : undefined;
}

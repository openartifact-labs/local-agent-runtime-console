import type { LaunchTaskInput, LaunchTaskResult, ProviderDescriptor, ProviderEvent, ProviderUsageAnalytics, ProviderUsageSnapshot, RuntimeEvent, RuntimeRun, RuntimeTask, TaskDetail, TaskListResponse } from "@openartifact-labs/runtime-contracts";

import { CODEX_PROVIDER_ID, CodexProvider, extractTurn } from "./codex/codex-provider.js";
import type { AppConfig } from "./config.js";
import type { RuntimeRepository } from "./db/runtime-repository.js";
import { NotFoundError, ValidationError, errorMessage } from "./errors.js";

export type StreamMessage = { type: "task-updated" | "run-updated" | "runtime-event" | "provider-updated"; data: Record<string, unknown> };
type ManagedRun = {
  taskId: string;
  taskExternalId: string;
  runId: string;
  runExternalId: string;
  output: string;
  toolCallCount: number;
  startedAt: string;
  lastSnapshotAt: number;
  lastSnapshotLength: number;
};

const TOOL_ITEM_TYPES = new Set([
  "commandExecution", "mcpToolCall", "dynamicToolCall", "collabToolCall", "webSearch",
]);

function stringAt(value: Record<string, unknown>, key: string): string | undefined { return typeof value[key] === "string" ? value[key] : undefined; }
function nestedRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return value === null || value === undefined || !Number.isFinite(parsed) ? undefined : parsed;
}
function eventCategory(method: string): RuntimeEvent["category"] {
  if (method.startsWith("turn/")) return "lifecycle";
  if (method.includes("agentMessage") || method.includes("plan") || method.includes("reasoning")) return "message";
  if (method.includes("command")) return "command";
  if (method.includes("file")) return "file";
  if (method.startsWith("item/")) return "tool";
  return "system";
}
function eventTitle(method: string): string {
  const labels: Record<string, string> = { "turn/started": "任务开始执行", "turn/completed": "任务执行结束", "turn/interrupt": "任务中断请求", "thread/tokenUsage/updated": "Token 用量更新", "item/started": "运行项开始", "item/completed": "运行项完成", "item/agentMessage/delta": "模型输出增量" };
  return labels[method] ?? `Codex 事件：${method}`;
}
function runStatus(value: string | undefined): RuntimeRun["status"] | undefined {
  if (value === "completed") return "completed";
  if (value === "interrupted") return "interrupted";
  if (value === "failed") return "failed";
  if (value === "inProgress") return "running";
  return undefined;
}

export class RuntimeService {
  private readonly listeners = new Set<(message: StreamMessage) => void>();
  private readonly managedRuns = new Map<string, ManagedRun>();
  private readonly threadToRun = new Map<string, string>();
  private syncTimer?: NodeJS.Timeout;
  private syncing = false;
  private unsubscribeProvider?: () => void;

  constructor(private readonly repository: RuntimeRepository, private readonly provider: CodexProvider, private readonly config: AppConfig) {}
  async start(): Promise<void> {
    await this.repository.verify();
    const recovered = await this.repository.interruptOrphanedRuns();
    if (recovered > 0) console.warn(`已恢复 ${recovered} 条上次进程遗留的运行记录`);
    this.unsubscribeProvider = this.provider.onEvent((event) => {
      void this.handleProviderEvent(event).catch((error) => {
        this.emit({ type: "provider-updated", data: { providerId: CODEX_PROVIDER_ID, connected: true, message: `事件持久化失败：${errorMessage(error)}` } });
      });
    });
    await this.sync();
    this.syncTimer = setInterval(() => { void this.sync(); }, this.config.codex.syncIntervalMs);
    this.syncTimer.unref();
  }
  async close(): Promise<void> { if (this.syncTimer) clearInterval(this.syncTimer); this.unsubscribeProvider?.(); await this.provider.close(); await this.repository.close(); }
  onStream(listener: (message: StreamMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async providers(): Promise<ProviderDescriptor[]> { const descriptor = await this.provider.descriptor(); await this.repository.upsertProvider(descriptor); return [descriptor]; }
  async providerUsage(providerId: string): Promise<ProviderUsageSnapshot | null> {
    if (providerId !== CODEX_PROVIDER_ID) throw new NotFoundError("未找到运行时提供方");
    return this.provider.getUsageSnapshot?.() ?? null;
  }
  async providerUsageAnalytics(providerId: string, days?: number): Promise<ProviderUsageAnalytics> {
    if (providerId !== CODEX_PROVIDER_ID) throw new NotFoundError("未找到运行时提供方");
    if (!this.provider.getUsageAnalytics) throw new NotFoundError("运行时提供方不支持使用分析");
    return this.provider.getUsageAnalytics(days);
  }
  async tasks(): Promise<TaskListResponse> { const items = await this.repository.listTasks(); return { items, total: items.length, syncedAt: new Date().toISOString() }; }
  async taskDetail(id: string): Promise<TaskDetail> {
    const detail = await this.repository.getTaskDetail(id);
    if (detail.source !== "discovered" || !this.provider.readObservation) return detail;

    const observation = await this.provider.readObservation(detail);
    if (!observation) return detail;
    return {
      ...detail,
      runs: observation.run ? [observation.run] : [],
      events: observation.events,
      output: observation.output,
      activeRunId: observation.run?.status === "running" ? observation.run.id : undefined,
    };
  }
  async launch(input: LaunchTaskInput): Promise<LaunchTaskResult> {
    if (!input.prompt?.trim()) throw new ValidationError("任务内容不能为空");
    if (!input.cwd?.trim()) throw new ValidationError("工作目录不能为空");
    if (input.providerId && input.providerId !== CODEX_PROVIDER_ID) throw new ValidationError("当前仅支持 Codex Provider");
    const launched = await this.provider.launchTask({ ...input, prompt: input.prompt.trim(), cwd: input.cwd.trim() });
    const task = await this.repository.upsertTask(launched.task);
    const run = await this.repository.createRun({ ...launched.run, taskId: task.id });
    const managed: ManagedRun = {
      taskId: task.id, taskExternalId: task.externalId, runId: run.id,
      runExternalId: launched.run.externalId ?? launched.run.id, output: "",
      toolCallCount: 0, startedAt: run.startedAt, lastSnapshotAt: 0, lastSnapshotLength: 0,
    };
    this.managedRuns.set(managed.runExternalId, managed); this.threadToRun.set(managed.taskExternalId, managed.runExternalId);
    await this.repository.appendEvent({ runId: run.id, taskId: task.id, providerId: task.providerId, type: "turn/started", category: "lifecycle", level: "info", title: "受管任务已发起", detail: input.prompt.trim(), occurredAt: run.startedAt });
    this.emit({ type: "task-updated", data: { taskId: task.id } }); this.emit({ type: "run-updated", data: { runId: run.id, taskId: task.id } });
    return { task, run };
  }
  async interrupt(runId: string): Promise<void> {
    const found = await this.repository.getRunWithTask(runId); if (!found) throw new NotFoundError("未找到运行记录");
    if (found.run.status !== "running") throw new ValidationError("仅运行中的任务可以中断");
    if (!found.run.externalId) throw new ValidationError("该运行记录没有可中断的 Codex 会话");
    await this.provider.interruptRun(found.taskExternalId, found.run.externalId);
    await this.repository.updateRun(runId, { status: "interrupted", completedAt: new Date().toISOString(), durationMs: Date.now() - new Date(found.run.startedAt).getTime() });
    this.emit({ type: "run-updated", data: { runId, taskId: found.run.taskId } });
  }
  async sync(): Promise<void> {
    if (this.syncing) return; this.syncing = true;
    try {
      const provider = await this.provider.descriptor(); await this.repository.upsertProvider(provider); this.emit({ type: "provider-updated", data: { providerId: provider.id, connected: provider.connected } });
      if (!provider.connected) return;
      const tasks = await this.provider.listTasks();
      await this.repository.upsertTasks(tasks);
      await this.repository.removeMissingDiscoveredTasks(CODEX_PROVIDER_ID, tasks.map((task) => task.externalId));
      this.emit({ type: "task-updated", data: { synced: true } });
    } catch (error) {
      // 同步失败不终止 HTTP 服务；Provider 状态接口会返回离线原因，下一轮继续恢复。
      console.warn(`Codex 全局任务同步失败：${errorMessage(error)}`);
      this.emit({ type: "provider-updated", data: { providerId: CODEX_PROVIDER_ID, connected: false, message: errorMessage(error) } });
    } finally { this.syncing = false; }
  }
  private async handleProviderEvent(event: ProviderEvent): Promise<void> {
    const params = event.params; const turn = extractTurn(params); const embeddedThread = nestedRecord(params.thread);
    const threadId = stringAt(params, "threadId") ?? stringAt(embeddedThread ?? {}, "id");
    const turnId = stringAt(params, "turnId") ?? turn?.id;
    const managed = (turnId && this.managedRuns.get(turnId)) || (threadId && this.threadToRun.get(threadId) ? this.managedRuns.get(this.threadToRun.get(threadId)!) : undefined);
    if (!managed) return;
    const category = eventCategory(event.method); const item = nestedRecord(params.item); const detail = stringAt(params, "delta") ?? stringAt(params, "text") ?? stringAt(item ?? {}, "text");
    if (event.method === "item/agentMessage/delta" && detail) {
      managed.output += detail;
      const now = Date.now();
      if (managed.output.length - managed.lastSnapshotLength >= 200 || now - managed.lastSnapshotAt >= 1_000) {
        await this.repository.saveOutputSnapshot({
          runId: managed.runId, taskId: managed.taskId, content: managed.output,
          format: "markdown", isFinal: false, createdAt: event.receivedAt,
        });
        managed.lastSnapshotAt = now;
        managed.lastSnapshotLength = managed.output.length;
      }
      // 文本增量可能非常密集，只更新输出快照，不为每个分片写一条事件日志。
      this.emit({ type: "run-updated", data: { runId: managed.runId, taskId: managed.taskId } });
      return;
    }
    if (event.method.endsWith("/delta")) return;
    if (event.method === "item/started" && typeof item?.type === "string" && TOOL_ITEM_TYPES.has(item.type)) {
      managed.toolCallCount += 1;
      await this.repository.updateRun(managed.runId, { toolCallCount: managed.toolCallCount });
    }
    const status = event.method === "turn/completed" ? runStatus(turn?.status) ?? "completed" : undefined;
    if (event.method === "thread/tokenUsage/updated") {
      const usageRoot = nestedRecord(params.tokenUsage) ?? params;
      const usage = nestedRecord(usageRoot.total) ?? usageRoot;
      const inputTokens = finiteNumber(usage.inputTokens ?? usage.input_tokens);
      const cachedInputTokens = finiteNumber(usage.cachedInputTokens ?? usage.cached_input_tokens);
      const cacheWriteInputTokens = finiteNumber(usage.cacheWriteInputTokens ?? usage.cache_write_input_tokens);
      const outputTokens = finiteNumber(usage.outputTokens ?? usage.output_tokens);
      const reasoningOutputTokens = finiteNumber(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens);
      const totalTokens = finiteNumber(usage.totalTokens ?? usage.total_tokens)
        ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
      await this.repository.updateRun(managed.runId, {
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
      });
    }
    if (status) {
      const completedAt = event.receivedAt; const error = turn?.error?.message;
      await this.repository.updateRun(managed.runId, { status, completedAt, durationMs: Date.now() - new Date(managed.startedAt).getTime(), errorMessage: error ?? undefined });
      if (managed.output) await this.repository.saveOutputSnapshot({ runId: managed.runId, taskId: managed.taskId, content: managed.output, format: "markdown", isFinal: true, createdAt: completedAt });
      this.managedRuns.delete(managed.runExternalId); this.threadToRun.delete(managed.taskExternalId);
    }
    const persisted = await this.repository.appendEvent({ runId: managed.runId, taskId: managed.taskId, providerId: CODEX_PROVIDER_ID, type: event.method, category, level: status === "failed" ? "error" : "info", title: eventTitle(event.method), detail, durationMs: typeof item?.durationMs === "number" ? item.durationMs : undefined, payload: params, occurredAt: event.receivedAt });
    this.emit({ type: "runtime-event", data: persisted as unknown as Record<string, unknown> }); this.emit({ type: "run-updated", data: { runId: managed.runId, taskId: managed.taskId } });
  }
  private emit(message: StreamMessage): void { for (const listener of this.listeners) listener(message); }
}

import { open, stat } from "node:fs/promises";

import type {
  EventLevel,
  ProviderRateLimit,
  ProviderUsageSnapshot,
  RuntimeEvent,
  RuntimeTask,
  RuntimeTokenUsage,
  TaskStatus,
} from "@openartifact-labs/runtime-contracts";

type EventCategory = RuntimeEvent["category"];

export interface RolloutObservedEvent {
  id: string;
  type: string;
  category: EventCategory;
  level: EventLevel;
  title: string;
  detail?: string;
  occurredAt: string;
  durationMs?: number;
}

export interface RolloutRunObservation {
  turnId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  toolCallCount: number;
}

export interface RolloutObservation {
  status?: TaskStatus;
  latestUserMessage?: string;
  lastObservedAt?: string;
  relation?: RuntimeTask["relation"];
  run?: RolloutRunObservation;
  usageSnapshot?: Omit<ProviderUsageSnapshot, "providerId" | "taskExternalId" | "taskTitle">;
  events: RolloutObservedEvent[];
  output?: { content: string; isFinal: boolean; createdAt: string };
}

interface CachedObservation {
  size: number;
  observation: RolloutObservation;
  seenRecords: Set<string>;
}

interface RolloutRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

const DEFAULT_INITIAL_READ_BYTES = 16 * 1024 * 1024;
const INCREMENTAL_OVERLAP_BYTES = 64 * 1024;
const MAX_LIFECYCLE_LOOKBACK_BYTES = 128 * 1024 * 1024;
const MAX_EVENTS = 200;
const MAX_DETAIL_LENGTH = 4_000;
const SESSION_META_READ_BYTES = 64 * 1024;

function lifecycleStatus(type: unknown): TaskStatus | undefined {
  if (type === "task_started") return "running";
  if (type === "task_complete") return "completed";
  if (type === "turn_aborted") return "interrupted";
  if (type === "task_failed" || type === "turn_failed") return "failed";
  return undefined;
}

function normalizeUserMessage(message: string): string {
  const requestMarker = "## My request for Codex:";
  const markerIndex = message.lastIndexOf(requestMarker);
  const content = markerIndex >= 0 ? message.slice(markerIndex + requestMarker.length) : message;
  return content.trim().slice(0, 8_192);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokenUsage(value: unknown): RuntimeTokenUsage | undefined {
  const source = object(value);
  if (!source) return undefined;
  const usage: RuntimeTokenUsage = {
    inputTokens: number(source.input_tokens ?? source.inputTokens),
    cachedInputTokens: number(source.cached_input_tokens ?? source.cachedInputTokens),
    cacheWriteInputTokens: number(source.cache_write_input_tokens ?? source.cacheWriteInputTokens),
    outputTokens: number(source.output_tokens ?? source.outputTokens),
    reasoningOutputTokens: number(source.reasoning_output_tokens ?? source.reasoningOutputTokens),
    totalTokens: number(source.total_tokens ?? source.totalTokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function providerRateLimit(value: unknown): ProviderRateLimit | undefined {
  const source = object(value);
  const primary = object(source?.primary);
  const credits = object(source?.credits);
  if (!source) return undefined;
  const rateLimit: ProviderRateLimit = {
    usedPercent: number(primary?.used_percent ?? primary?.usedPercent),
    windowMinutes: number(primary?.window_minutes ?? primary?.windowMinutes),
    resetsAt: isoTime(primary?.resets_at ?? primary?.resetsAt),
    planType: text(source.plan_type ?? source.planType),
    hasCredits: typeof credits?.has_credits === "boolean" ? credits.has_credits : undefined,
    unlimited: typeof credits?.unlimited === "boolean" ? credits.unlimited : undefined,
    creditBalance: text(credits?.balance),
  };
  return Object.values(rateLimit).some((item) => item !== undefined) ? rateLimit : undefined;
}

function addTokenUsage(run: RolloutRunObservation, usage: RuntimeTokenUsage): void {
  if (usage.inputTokens !== undefined) run.inputTokens = (run.inputTokens ?? 0) + usage.inputTokens;
  if (usage.cachedInputTokens !== undefined) run.cachedInputTokens = (run.cachedInputTokens ?? 0) + usage.cachedInputTokens;
  if (usage.cacheWriteInputTokens !== undefined) run.cacheWriteInputTokens = (run.cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
  if (usage.outputTokens !== undefined) run.outputTokens = (run.outputTokens ?? 0) + usage.outputTokens;
  if (usage.reasoningOutputTokens !== undefined) run.reasoningOutputTokens = (run.reasoningOutputTokens ?? 0) + usage.reasoningOutputTokens;
  const totalTokens = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  run.totalTokens = (run.totalTokens ?? 0) + totalTokens;
}

function taskRelation(source: unknown): RuntimeTask["relation"] | undefined {
  const spawn = object(object(object(source)?.subagent)?.thread_spawn);
  const parentExternalId = text(spawn?.parent_thread_id);
  if (!parentExternalId) return undefined;
  return {
    type: "subtask",
    parentExternalId,
    depth: number(spawn?.depth) ?? 1,
    agentName: text(spawn?.agent_nickname),
  };
}

function isoTime(value: unknown, fallback?: string): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1_000).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback && !Number.isNaN(Date.parse(fallback)) ? new Date(fallback).toISOString() : undefined;
}

function detail(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().slice(0, MAX_DETAIL_LENGTH) || undefined;
  if (value === undefined || value === null) return undefined;
  try { return JSON.stringify(value).slice(0, MAX_DETAIL_LENGTH); } catch { return undefined; }
}

function recordKey(record: RolloutRecord, payload: Record<string, unknown>): string {
  return [record.timestamp, record.type, payload.type, payload.id, payload.event_id, payload.call_id, payload.turn_id].join(":");
}

function cloneObservation(initial?: RolloutObservation): RolloutObservation {
  return {
    ...initial,
    run: initial?.run ? { ...initial.run } : undefined,
    usageSnapshot: initial?.usageSnapshot ? {
      ...initial.usageSnapshot,
      usage: { ...initial.usageSnapshot.usage },
      rateLimit: initial.usageSnapshot.rateLimit ? { ...initial.usageSnapshot.rateLimit } : undefined,
    } : undefined,
    events: [...(initial?.events ?? [])],
    output: initial?.output ? { ...initial.output } : undefined,
  };
}

function pushEvent(observation: RolloutObservation, event: RolloutObservedEvent): void {
  if (observation.events.some((item) => item.id === event.id)) return;
  observation.events.push(event);
  if (observation.events.length > MAX_EVENTS) observation.events.splice(0, observation.events.length - MAX_EVENTS);
}

function ensureRun(observation: RolloutObservation): RolloutRunObservation {
  observation.run ??= { toolCallCount: 0 };
  return observation.run;
}

function toolCategory(name: string, input: string): EventCategory {
  const value = `${name} ${input}`.toLowerCase();
  if (value.includes("apply_patch") || value.includes("writefile") || value.includes("edit")) return "file";
  if (value.includes("shell_command") || value.includes("command:") || value.includes("command=")) return "command";
  return "tool";
}

function parseRollout(
  content: string,
  initial?: RolloutObservation,
  seenRecords = new Set<string>(),
): RolloutObservation {
  const observation = cloneObservation(initial);
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const record = JSON.parse(line) as RolloutRecord;
      const payload = record.payload;
      if (!payload) continue;
      const key = recordKey(record, payload);
      if (seenRecords.has(key)) continue;
      seenRecords.add(key);

      const payloadType = text(payload.type);
      const occurredAt = isoTime(record.timestamp) ?? new Date().toISOString();
      observation.lastObservedAt = occurredAt;
      if (record.type === "session_meta") observation.relation = taskRelation(payload.source);
      const status = lifecycleStatus(payloadType);
      if (status) observation.status = status;

      if (record.type === "event_msg" && payloadType === "task_started") {
        const turnId = text(payload.turn_id);
        observation.run = {
          turnId,
          startedAt: isoTime(payload.started_at, occurredAt),
          toolCallCount: 0,
        };
        observation.events = [];
        observation.output = undefined;
        pushEvent(observation, {
          id: `task-started:${turnId ?? occurredAt}`,
          type: payloadType,
          category: "lifecycle",
          level: "info",
          title: "任务开始执行",
          occurredAt,
        });
        continue;
      }

      if (record.type === "event_msg" && payloadType === "user_message") {
        const message = text(payload.message);
        if (!message) continue;
        observation.latestUserMessage = normalizeUserMessage(message);
        pushEvent(observation, {
          id: `user-message:${text(payload.event_id) ?? occurredAt}`,
          type: payloadType,
          category: "lifecycle",
          level: "info",
          title: "收到任务输入",
          detail: observation.latestUserMessage.slice(0, MAX_DETAIL_LENGTH),
          occurredAt,
        });
        continue;
      }

      if (record.type === "event_msg" && payloadType === "agent_reasoning") {
        pushEvent(observation, {
          id: `reasoning:${text(payload.event_id) ?? occurredAt}`,
          type: payloadType,
          category: "message",
          level: "debug",
          title: "Agent 推理",
          detail: detail(payload.text),
          occurredAt,
        });
        continue;
      }

      if (record.type === "event_msg" && payloadType === "agent_message") {
        const message = text(payload.message);
        if (!message) continue;
        const phase = text(payload.phase);
        observation.output = { content: message, isFinal: phase === "final", createdAt: occurredAt };
        pushEvent(observation, {
          id: `agent-message:${text(payload.event_id) ?? occurredAt}:${phase ?? "message"}`,
          type: payloadType,
          category: "message",
          level: "info",
          title: phase === "commentary" ? "Agent 进度更新" : "Agent 输出",
          detail: message.slice(0, MAX_DETAIL_LENGTH),
          occurredAt,
        });
        continue;
      }

      if (record.type === "event_msg" && payloadType === "token_count") {
        const info = object(payload.info);
        const lastUsage = tokenUsage(info?.last_token_usage);
        if (lastUsage) addTokenUsage(ensureRun(observation), lastUsage);

        const cumulativeUsage = tokenUsage(info?.total_token_usage);
        if (cumulativeUsage) {
          observation.usageSnapshot = {
            observedAt: occurredAt,
            scope: "latest-session",
            modelContextWindow: number(info?.model_context_window),
            usage: cumulativeUsage,
            rateLimit: providerRateLimit(payload.rate_limits),
          };
        }
        continue;
      }

      if (record.type === "response_item" && (payloadType === "custom_tool_call" || payloadType === "function_call")) {
        const name = text(payload.name) ?? "未知工具";
        const input = detail(payload.input ?? payload.arguments) ?? "未记录调用参数";
        const category = toolCategory(name, input);
        ensureRun(observation).toolCallCount += 1;
        pushEvent(observation, {
          id: `tool-call:${text(payload.call_id) ?? text(payload.id) ?? occurredAt}:${payloadType}`,
          type: payloadType,
          category,
          level: "info",
          title: category === "command" ? `执行命令：${name}` : category === "file" ? `修改文件：${name}` : `调用工具：${name}`,
          detail: input,
          occurredAt,
        });
        continue;
      }

      if (record.type === "response_item" && (payloadType === "custom_tool_call_output" || payloadType === "function_call_output")) {
        pushEvent(observation, {
          id: `tool-output:${text(payload.call_id) ?? text(payload.id) ?? occurredAt}:${payloadType}`,
          type: payloadType,
          category: "tool",
          level: "info",
          title: "工具调用完成",
          detail: detail(payload.output),
          occurredAt,
        });
        continue;
      }

      if (record.type === "event_msg" && (payloadType === "patch_apply_end" || payloadType === "mcp_tool_call_end")) {
        const isPatch = payloadType === "patch_apply_end";
        pushEvent(observation, {
          id: `${payloadType}:${text(payload.call_id) ?? text(payload.event_id) ?? occurredAt}`,
          type: payloadType,
          category: isPatch ? "file" : "tool",
          level: payload.status === "failed" ? "error" : "info",
          title: isPatch ? "文件修改完成" : "MCP 工具调用完成",
          detail: detail(payload.output ?? payload.message),
          occurredAt,
        });
        continue;
      }

      if (record.type === "event_msg" && payloadType === "task_complete") {
        const run = ensureRun(observation);
        run.turnId ??= text(payload.turn_id);
        run.startedAt ??= isoTime(payload.started_at);
        run.completedAt = isoTime(payload.completed_at, occurredAt);
        run.durationMs = number(payload.duration_ms);
        const finalMessage = text(payload.last_agent_message);
        if (finalMessage) observation.output = { content: finalMessage, isFinal: true, createdAt: run.completedAt ?? occurredAt };
        pushEvent(observation, {
          id: `task-complete:${run.turnId ?? occurredAt}`,
          type: payloadType,
          category: "lifecycle",
          level: "info",
          title: "任务执行完成",
          detail: finalMessage?.slice(0, MAX_DETAIL_LENGTH),
          occurredAt: run.completedAt ?? occurredAt,
          durationMs: run.durationMs,
        });
        continue;
      }

      if (record.type === "event_msg" && payloadType === "turn_aborted") {
        const run = ensureRun(observation);
        run.turnId ??= text(payload.turn_id);
        run.startedAt ??= isoTime(payload.started_at);
        run.completedAt = isoTime(payload.completed_at, occurredAt);
        run.durationMs = number(payload.duration_ms);
        pushEvent(observation, {
          id: `turn-aborted:${run.turnId ?? occurredAt}`,
          type: payloadType,
          category: "lifecycle",
          level: "warning",
          title: "任务已中断",
          detail: detail(payload.reason),
          occurredAt: run.completedAt ?? occurredAt,
          durationMs: run.durationMs,
        });
      }
    } catch {
      // 文件可能正处于追加写入中；忽略不完整行，下一轮通过重叠区重新读取。
    }
  }
  return observation;
}

export class CodexRolloutObserver {
  private readonly cache = new Map<string, CachedObservation>();

  constructor(private readonly initialReadBytes = DEFAULT_INITIAL_READ_BYTES) {}

  async inspect(path: string): Promise<RolloutObservation> {
    try {
      const file = await stat(path);
      const cached = this.cache.get(path);
      if (cached?.size === file.size) return cached.observation;

      // 首轮读取文件尾部建立最新一轮快照，后续只处理新增区间。
      const start = cached && file.size > cached.size
        ? Math.max(0, cached.size - INCREMENTAL_OVERLAP_BYTES)
        : Math.max(0, file.size - this.initialReadBytes);
      const length = file.size - start;
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, start);
        let content = buffer.toString("utf8");
        if (start > 0) {
          const firstLineEnd = content.indexOf("\n");
          content = firstLineEnd >= 0 ? content.slice(firstLineEnd + 1) : "";
        }
        const seenRecords = cached?.seenRecords ?? new Set<string>();
        const initial = cached?.observation ?? {
          events: [],
          relation: await this.readSessionRelation(handle, file.size),
        };
        const observation = parseRollout(content, initial, seenRecords);
        if (!cached && !observation.status && start > 0) {
          const previous = await this.findPreviousLifecycle(handle, file.size, start);
          observation.status = previous.status;
          if (previous.run || observation.run) {
            observation.run = {
              ...previous.run,
              ...observation.run,
              toolCallCount: observation.run?.toolCallCount ?? previous.run?.toolCallCount ?? 0,
            };
          }
        }
        this.cache.set(path, { size: file.size, observation, seenRecords });
        return observation;
      } finally {
        await handle.close();
      }
    } catch {
      return { events: [] };
    }
  }

  private async readSessionRelation(
    handle: Awaited<ReturnType<typeof open>>,
    fileSize: number,
  ): Promise<RuntimeTask["relation"] | undefined> {
    const length = Math.min(fileSize, SESSION_META_READ_BYTES);
    if (length === 0) return undefined;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, 0);
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      try {
        const record = JSON.parse(line) as RolloutRecord;
        if (record.type === "session_meta") return taskRelation(record.payload?.source);
      } catch {
        // 会话元数据位于首行；首段异常时交由常规降级逻辑处理。
      }
    }
    return undefined;
  }

  private async findPreviousLifecycle(
    handle: Awaited<ReturnType<typeof open>>,
    fileSize: number,
    before: number,
  ): Promise<Pick<RolloutObservation, "status" | "run">> {
    let end = before;
    let scanned = 0;
    while (end > 0 && scanned < MAX_LIFECYCLE_LOOKBACK_BYTES) {
      const start = Math.max(0, end - this.initialReadBytes);
      const readEnd = Math.min(fileSize, end + INCREMENTAL_OVERLAP_BYTES);
      const buffer = Buffer.allocUnsafe(readEnd - start);
      await handle.read(buffer, 0, buffer.length, start);
      let content = buffer.toString("utf8");
      if (start > 0) {
        const firstLineEnd = content.indexOf("\n");
        content = firstLineEnd >= 0 ? content.slice(firstLineEnd + 1) : "";
      }
      const observation = parseRollout(content);
      if (observation.status) return { status: observation.status, run: observation.run };
      scanned += end - start;
      end = start;
    }
    return {};
  }
}

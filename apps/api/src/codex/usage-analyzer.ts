import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type {
  ProviderUsageAnalytics,
  ProviderUsageTodaySession,
  RuntimeTokenUsage,
  UsageAnalyticsSeries,
} from "@openartifact-labs/runtime-contracts";

interface RolloutRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface UsageEntry {
  date: string;
  key: string;
}

interface UsageDaySummary {
  date: string;
  firstActivityAt: string;
  lastActivityAt: string;
  models: string[];
  usage?: RuntimeTokenUsage;
  tokenUsagePartial: boolean;
}

interface UsageFileSummary {
  sessions: UsageEntry[];
  turns: UsageEntry[];
  skills: UsageEntry[];
  daily: UsageDaySummary[];
}

interface CachedSummary {
  size: number;
  mtimeMs: number;
  summary: UsageFileSummary;
}

interface PersistedCache {
  version: 2;
  files: Array<[string, CachedSummary]>;
}

export interface UsageAnalysisSource {
  path: string;
  task?: {
    externalId?: string;
    title?: string;
    model?: string;
  };
}

interface TokenSnapshot {
  date: string;
  occurredAt: string;
  usage: RuntimeTokenUsage;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const satisfies ReadonlyArray<keyof RuntimeTokenUsage>;
const EMPTY_SUMMARY: UsageFileSummary = { sessions: [], turns: [], skills: [], daily: [] };
const SKILL_PATH_PATTERN = /[\\/]skills[\\/](?:\.system[\\/])?([^\\/"']+)[\\/]SKILL\.md/gi;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function localDate(value: unknown): string | undefined {
  const timestamp = text(value);
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return undefined;
  return dateFormatter.format(new Date(timestamp));
}

function timestamp(value: unknown): string | undefined {
  const raw = text(value);
  return raw && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenUsage(value: unknown): RuntimeTokenUsage | undefined {
  const source = object(value);
  if (!source) return undefined;
  const usage: RuntimeTokenUsage = {
    inputTokens: finiteNumber(source.input_tokens ?? source.inputTokens),
    cachedInputTokens: finiteNumber(source.cached_input_tokens ?? source.cachedInputTokens),
    cacheWriteInputTokens: finiteNumber(source.cache_write_input_tokens ?? source.cacheWriteInputTokens),
    outputTokens: finiteNumber(source.output_tokens ?? source.outputTokens),
    reasoningOutputTokens: finiteNumber(source.reasoning_output_tokens ?? source.reasoningOutputTokens),
    totalTokens: finiteNumber(source.total_tokens ?? source.totalTokens),
  };
  return TOKEN_FIELDS.some((field) => usage[field] !== undefined) ? usage : undefined;
}

function subtractTokenUsage(current: RuntimeTokenUsage, baseline?: RuntimeTokenUsage): RuntimeTokenUsage {
  const difference: RuntimeTokenUsage = {};
  for (const field of TOKEN_FIELDS) {
    const value = current[field];
    if (value === undefined) continue;
    difference[field] = Math.max(0, value - (baseline?.[field] ?? 0));
  }
  return difference;
}

function addTokenUsage(target: RuntimeTokenUsage, usage?: RuntimeTokenUsage): void {
  if (!usage) return;
  for (const field of TOKEN_FIELDS) {
    const value = usage[field];
    if (value !== undefined) target[field] = (target[field] ?? 0) + value;
  }
}

function surface(payload: Record<string, unknown>): { id: string; label: string } {
  const originator = text(payload.originator)?.toLowerCase() ?? "";
  const threadSource = text(payload.thread_source)?.toLowerCase() ?? "";
  if (threadSource === "exec" || originator.includes("exec")) return { id: "exec", label: "Exec" };
  if (originator.includes("desktop")) return { id: "desktop", label: "Desktop App" };
  if (originator.includes("vscode") || threadSource === "vscode") return { id: "vscode", label: "VS Code" };
  if (originator.includes("cli") || threadSource === "cli") return { id: "cli", label: "CLI" };
  return { id: "uncategorized", label: "未分类" };
}

function skillLabel(id: string): string {
  return id
    .replace(/\.bak\.\d+$/i, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toolArguments(payload: Record<string, unknown>): string | undefined {
  const value = payload.input ?? payload.arguments;
  if (typeof value === "string") return value;
  if (!value) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function extractSkills(value: string): string[] {
  const skills = new Set<string>();
  const normalized = value.replace(/\\\\/g, "\\");
  SKILL_PATH_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(SKILL_PATH_PATTERN)) {
    if (match[1]) skills.add(match[1].toLowerCase().replace(/\.bak\.\d+$/i, ""));
  }
  return [...skills];
}

function dateRange(days: number): string[] {
  const result: string[] = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    result.push(dateFormatter.format(new Date(today.getTime() - offset * DAY_MS)));
  }
  return result;
}

function buildSeries(
  dates: string[],
  entries: UsageEntry[],
  labelFor: (id: string) => string,
  maxKeys: number,
): UsageAnalyticsSeries {
  const totals = new Map<string, number>();
  for (const entry of entries) totals.set(entry.key, (totals.get(entry.key) ?? 0) + 1);

  const sortedKeys = [...totals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key]) => key);
  const visibleKeys = sortedKeys.slice(0, maxKeys);
  const hiddenKeys = new Set(sortedKeys.slice(maxKeys));
  const keys = visibleKeys.map((id) => ({ id, label: labelFor(id) }));
  if (hiddenKeys.size > 0) keys.push({ id: "__other", label: "其他" });

  const dateSet = new Set(dates);
  const valuesByDate = new Map(dates.map((date) => [date, {} as Record<string, number>]));
  for (const entry of entries) {
    if (!dateSet.has(entry.date)) continue;
    const key = hiddenKeys.has(entry.key) ? "__other" : entry.key;
    const values = valuesByDate.get(entry.date)!;
    values[key] = (values[key] ?? 0) + 1;
  }

  return {
    keys,
    points: dates.map((date) => ({ date, values: valuesByDate.get(date)! })),
  };
}

export class CodexUsageAnalyzer {
  private readonly cache = new Map<string, CachedSummary>();
  private cacheLoad?: Promise<void>;
  private cacheDirty = false;

  constructor(
    private readonly providerId: string,
    private readonly cachePath = join(homedir(), ".codex", "local-agent-runtime-console", "usage-analysis-cache.json"),
  ) {}

  async analyze(paths: Iterable<string | UsageAnalysisSource>, requestedDays = 30): Promise<ProviderUsageAnalytics> {
    await this.loadCache();
    const normalizedDays = Number.isFinite(requestedDays) ? Math.round(requestedDays) : 30;
    const days = Math.min(90, Math.max(1, normalizedDays));
    const dates = dateRange(days);
    const cutoffMs = Date.now() - (days + 1) * DAY_MS;
    const sourcesByPath = new Map<string, UsageAnalysisSource>();
    for (const entry of paths) {
      const source = typeof entry === "string" ? { path: entry } : entry;
      if (source.path) sourcesByPath.set(source.path, source);
    }
    const sources = [...sourcesByPath.values()];
    const candidates: UsageAnalysisSource[] = [];
    let statCursor = 0;
    const statWorker = async (): Promise<void> => {
      while (statCursor < sources.length) {
        const source = sources[statCursor]!;
        statCursor += 1;
        try {
          const file = await stat(source.path);
          if (file.mtimeMs >= cutoffMs) candidates.push(source);
        } catch {
          // 会话文件可能在列表刷新期间被移动或清理，忽略单文件失败不影响其余统计。
        }
      }
    };
    // Windows 上大量小文件逐个 stat 延迟明显；有界并发可缩短首次分析，同时避免瞬时打开全部文件。
    await Promise.all(Array.from({ length: Math.min(16, sources.length) }, () => statWorker()));

    const summaries = new Array<{ source: UsageAnalysisSource; summary: UsageFileSummary }>(candidates.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        const source = candidates[index]!;
        summaries[index] = { source, summary: await this.analyzeFile(source.path) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => worker()));
    await this.persistCache();

    const sessions = summaries.flatMap(({ summary }) => summary.sessions);
    const turns = summaries.flatMap(({ summary }) => summary.turns);
    const skills = summaries.flatMap(({ summary }) => summary.skills);
    const today = this.todayDetails(summaries, dates.at(-1)!);
    return {
      providerId: this.providerId,
      observedAt: new Date().toISOString(),
      scope: "local",
      days,
      sessionCount: sessions.filter((entry) => dates.includes(entry.date)).length,
      turnCount: turns.filter((entry) => dates.includes(entry.date)).length,
      skillInvocationCount: skills.filter((entry) => dates.includes(entry.date)).length,
      bySurface: buildSeries(dates, sessions, (id) => ({
        desktop: "Desktop App",
        cli: "CLI",
        exec: "Exec",
        vscode: "VS Code",
        uncategorized: "未分类",
      })[id] ?? id, 5),
      byModel: buildSeries(dates, turns, (id) => id, 6),
      bySkill: buildSeries(dates, skills, skillLabel, 8),
      today,
    };
  }

  private todayDetails(
    summaries: Array<{ source: UsageAnalysisSource; summary: UsageFileSummary }>,
    date: string,
  ): ProviderUsageAnalytics["today"] {
    const sessions: ProviderUsageTodaySession[] = summaries.flatMap(({ source, summary }) => {
      const daily = summary.daily.find((entry) => entry.date === date);
      if (!daily) return [];
      return [{
        taskExternalId: source.task?.externalId,
        taskTitle: source.task?.title ?? "未命名 Codex 会话",
        model: daily.models.at(-1) ?? source.task?.model,
        firstActivityAt: daily.firstActivityAt,
        lastActivityAt: daily.lastActivityAt,
        usage: daily.usage,
        tokenUsagePartial: daily.tokenUsagePartial,
      }];
    }).sort((left, right) => (
      Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
      || left.taskTitle.localeCompare(right.taskTitle, "zh-CN")
    ));
    const usage: RuntimeTokenUsage = {};
    for (const session of sessions) addTokenUsage(usage, session.usage);
    return {
      date,
      sessionCount: sessions.length,
      tokenObservedSessionCount: sessions.filter((session) => session.usage !== undefined).length,
      partialTokenSessionCount: sessions.filter((session) => session.tokenUsagePartial).length,
      usage,
      sessions,
    };
  }

  private async analyzeFile(path: string): Promise<UsageFileSummary> {
    try {
      const file = await stat(path);
      const cached = this.cache.get(path);
      if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.summary;

      const summary: UsageFileSummary = { sessions: [], turns: [], skills: [], daily: [] };
      const seenSkills = new Set<string>();
      const dailyByDate = new Map<string, UsageDaySummary>();
      const tokenSnapshots: TokenSnapshot[] = [];
      let turnSequence = 0;
      let fallbackDate: string | undefined;
      const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.startsWith("{")) continue;
        // rollout 中绝大多数是长文本、Token 心跳和工具输出；先用固定标记过滤，避免对无关大行执行 JSON.parse。
        const isSessionMeta = line.includes('"type":"session_meta"');
        const isTurnContext = line.includes('"type":"turn_context"');
        const isTokenCount = line.includes('"type":"token_count"');
        const isSkillToolCall = line.includes("SKILL.md")
          && line.includes('"type":"response_item"')
          && (line.includes('"type":"custom_tool_call"') || line.includes('"type":"function_call"'));
        if (!isSessionMeta && !isTurnContext && !isTokenCount && !isSkillToolCall) continue;
        try {
          const record = JSON.parse(line) as RolloutRecord;
          const payload = record.payload;
          if (!payload) continue;
          const occurredAt = timestamp(record.timestamp);
          const date = localDate(occurredAt) ?? fallbackDate;
          if (date) fallbackDate = date;

          if (date && occurredAt && (record.type === "session_meta" || record.type === "turn_context" || payload.type === "token_count")) {
            const current = dailyByDate.get(date);
            if (current) {
              if (Date.parse(occurredAt) < Date.parse(current.firstActivityAt)) current.firstActivityAt = occurredAt;
              if (Date.parse(occurredAt) > Date.parse(current.lastActivityAt)) current.lastActivityAt = occurredAt;
            } else {
              dailyByDate.set(date, { date, firstActivityAt: occurredAt, lastActivityAt: occurredAt, models: [], tokenUsagePartial: false });
            }
          }

          if (record.type === "session_meta" && date) {
            const source = surface(payload);
            summary.sessions.push({ date, key: source.id });
            continue;
          }

          if (record.type === "turn_context" && date) {
            turnSequence += 1;
            const model = text(payload.model) ?? "未知模型";
            summary.turns.push({ date, key: model });
            const day = dailyByDate.get(date);
            if (day && !day.models.includes(model)) day.models.push(model);
            continue;
          }

          if (record.type === "event_msg" && payload.type === "token_count" && date && occurredAt) {
            const info = object(payload.info);
            const cumulative = tokenUsage(info?.total_token_usage ?? info?.totalTokenUsage);
            if (cumulative) tokenSnapshots.push({ date, occurredAt, usage: cumulative });
            continue;
          }

          if (record.type !== "response_item" || !date) continue;
          if (payload.type !== "custom_tool_call" && payload.type !== "function_call") continue;
          const input = toolArguments(payload);
          if (!input || !input.includes("SKILL.md")) continue;
          for (const skill of extractSkills(input)) {
            const invocationKey = `${turnSequence}:${skill}`;
            if (seenSkills.has(invocationKey)) continue;
            seenSkills.add(invocationKey);
            summary.skills.push({ date, key: skill });
          }
        } catch {
          // rollout 正在追加时末行可能不完整，下一次文件变更后会重新分析。
        }
      }

      tokenSnapshots.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
      const firstActivityDate = [...dailyByDate.keys()].sort().at(0);
      for (const day of dailyByDate.values()) {
        const snapshotsToday = tokenSnapshots.filter((snapshot) => snapshot.date === day.date);
        const latest = snapshotsToday.at(-1);
        if (!latest) continue;
        const previous = tokenSnapshots.filter((snapshot) => snapshot.date < day.date).at(-1);
        day.usage = subtractTokenUsage(latest.usage, previous?.usage);
        // 长会话没有日初累计快照时无法严格还原当天增量，显式标记而非把会话总量伪装成当天数据。
        day.tokenUsagePartial = !previous && firstActivityDate !== undefined && firstActivityDate < day.date;
      }
      summary.daily = [...dailyByDate.values()].sort((left, right) => left.date.localeCompare(right.date));

      this.cache.set(path, { size: file.size, mtimeMs: file.mtimeMs, summary });
      this.cacheDirty = true;
      return summary;
    } catch {
      return EMPTY_SUMMARY;
    }
  }

  private async loadCache(): Promise<void> {
    this.cacheLoad ??= (async () => {
      try {
        const stored = JSON.parse(await readFile(this.cachePath, "utf8")) as PersistedCache;
        if (stored.version !== 2 || !Array.isArray(stored.files)) return;
        for (const [path, cached] of stored.files) {
          if (!path || !cached || !Array.isArray(cached.summary?.sessions) || !Array.isArray(cached.summary?.daily)) continue;
          this.cache.set(path, cached);
        }
      } catch {
        // 首次运行或缓存损坏时重新生成；缓存只用于提速，不参与运行事实判断。
      }
    })();
    await this.cacheLoad;
  }

  private async persistCache(): Promise<void> {
    if (!this.cacheDirty) return;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      const payload: PersistedCache = { version: 2, files: [...this.cache.entries()] };
      await writeFile(this.cachePath, JSON.stringify(payload), "utf8");
      this.cacheDirty = false;
    } catch {
      // 写入失败仅影响下次启动速度，当前请求仍返回已完成的内存统计。
    }
  }
}

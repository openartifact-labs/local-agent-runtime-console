import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type { ProviderUsageAnalytics, UsageAnalyticsSeries } from "@openartifact-labs/runtime-contracts";

interface RolloutRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface UsageEntry {
  date: string;
  key: string;
}

interface UsageFileSummary {
  sessions: UsageEntry[];
  turns: UsageEntry[];
  skills: UsageEntry[];
}

interface CachedSummary {
  size: number;
  mtimeMs: number;
  summary: UsageFileSummary;
}

interface PersistedCache {
  version: 1;
  files: Array<[string, CachedSummary]>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const EMPTY_SUMMARY: UsageFileSummary = { sessions: [], turns: [], skills: [] };
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

  async analyze(paths: Iterable<string>, requestedDays = 30): Promise<ProviderUsageAnalytics> {
    await this.loadCache();
    const normalizedDays = Number.isFinite(requestedDays) ? Math.round(requestedDays) : 30;
    const days = Math.min(90, Math.max(7, normalizedDays));
    const dates = dateRange(days);
    const cutoffMs = Date.now() - (days + 1) * DAY_MS;
    const candidates: string[] = [];
    const uniquePaths = [...new Set(paths)];
    let statCursor = 0;
    const statWorker = async (): Promise<void> => {
      while (statCursor < uniquePaths.length) {
        const path = uniquePaths[statCursor]!;
        statCursor += 1;
        try {
          const file = await stat(path);
          if (file.mtimeMs >= cutoffMs) candidates.push(path);
        } catch {
          // 会话文件可能在列表刷新期间被移动或清理，忽略单文件失败不影响其余统计。
        }
      }
    };
    // Windows 上大量小文件逐个 stat 延迟明显；有界并发可缩短首次分析，同时避免瞬时打开全部文件。
    await Promise.all(Array.from({ length: Math.min(16, uniquePaths.length) }, () => statWorker()));

    const summaries = new Array<UsageFileSummary>(candidates.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        summaries[index] = await this.analyzeFile(candidates[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => worker()));
    await this.persistCache();

    const sessions = summaries.flatMap((summary) => summary.sessions);
    const turns = summaries.flatMap((summary) => summary.turns);
    const skills = summaries.flatMap((summary) => summary.skills);
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
    };
  }

  private async analyzeFile(path: string): Promise<UsageFileSummary> {
    try {
      const file = await stat(path);
      const cached = this.cache.get(path);
      if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.summary;

      const summary: UsageFileSummary = { sessions: [], turns: [], skills: [] };
      const seenSkills = new Set<string>();
      let turnSequence = 0;
      let fallbackDate: string | undefined;
      const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.startsWith("{")) continue;
        // rollout 中绝大多数是长文本、Token 心跳和工具输出；先用固定标记过滤，避免对无关大行执行 JSON.parse。
        const isSessionMeta = line.includes('"type":"session_meta"');
        const isTurnContext = line.includes('"type":"turn_context"');
        const isSkillToolCall = line.includes("SKILL.md")
          && line.includes('"type":"response_item"')
          && (line.includes('"type":"custom_tool_call"') || line.includes('"type":"function_call"'));
        if (!isSessionMeta && !isTurnContext && !isSkillToolCall) continue;
        try {
          const record = JSON.parse(line) as RolloutRecord;
          const payload = record.payload;
          if (!payload) continue;
          const date = localDate(record.timestamp) ?? fallbackDate;
          if (date) fallbackDate = date;

          if (record.type === "session_meta" && date) {
            const source = surface(payload);
            summary.sessions.push({ date, key: source.id });
            continue;
          }

          if (record.type === "turn_context" && date) {
            turnSequence += 1;
            summary.turns.push({ date, key: text(payload.model) ?? "未知模型" });
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
        if (stored.version !== 1 || !Array.isArray(stored.files)) return;
        for (const [path, cached] of stored.files) {
          if (!path || !cached || !Array.isArray(cached.summary?.sessions)) continue;
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
      const payload: PersistedCache = { version: 1, files: [...this.cache.entries()] };
      await writeFile(this.cachePath, JSON.stringify(payload), "utf8");
      this.cacheDirty = false;
    } catch {
      // 写入失败仅影响下次启动速度，当前请求仍返回已完成的内存统计。
    }
  }
}

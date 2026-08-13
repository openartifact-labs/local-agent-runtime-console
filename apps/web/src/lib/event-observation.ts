import type { EventLevel, RuntimeEvent } from "@openartifact-labs/runtime-contracts";

export type EventObservationMode = "key" | "full";
export type EventCategory = RuntimeEvent["category"];

export interface EventObservationFilters {
  mode: EventObservationMode;
  categories?: readonly EventCategory[];
  query?: string;
}

export interface ObservedEventItem {
  kind: "event";
  id: string;
  event: RuntimeEvent;
}

export interface AggregatedEventItem {
  kind: "aggregate";
  id: string;
  title: string;
  count: number;
  events: readonly RuntimeEvent[];
  categories: readonly EventCategory[];
  levels: readonly EventLevel[];
  startedAt: string;
  endedAt: string;
}

export type EventObservationItem = ObservedEventItem | AggregatedEventItem;

export interface EventDetailField {
  key: "type" | "category" | "level" | "occurredAt" | "durationMs";
  label: string;
  value: string | number;
}

export interface StructuredEventDetails {
  id: string;
  title: string;
  fields: readonly EventDetailField[];
  sections: readonly EventDetailSection[];
  content?: string;
  payload?: Record<string, unknown>;
}

export interface EventDetailSection {
  key: string;
  label: string;
  value: string;
  format: "text" | "code" | "json";
}

export const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "auth",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessionid",
  "setcookie",
]);

function normalizeIdentifier(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function isAgentOutput(event: RuntimeEvent): boolean {
  if (event.category !== "message") return false;
  const normalizedType = normalizeIdentifier(event.type);
  if (normalizedType.includes("agentmessage") || normalizedType.includes("agentoutput")) return true;
  return event.level !== "debug" && /agent\s*(输出|进度|消息)|agent\s*(output|message|response)/iu.test(event.title);
}

/**
 * 关键视图必须覆盖执行边界和所有产生副作用的事件；警告、错误优先级最高，
 * 避免后端新增事件类型后因尚未加入白名单而隐藏故障。
 */
export function isKeyRuntimeEvent(event: RuntimeEvent): boolean {
  if (event.level === "warning" || event.level === "error") return true;
  if (event.category === "lifecycle") return true;
  if (event.category === "command" || event.category === "tool" || event.category === "file") return true;
  return isAgentOutput(event);
}

function collectSearchValues(value: unknown, values: string[], seen: WeakSet<object>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    values.push(String(value));
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectSearchValues(item, values, seen);
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    values.push(key);
    collectSearchValues(item, values, seen);
  }
}

function matchesQuery(event: RuntimeEvent, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const values = [event.title, event.detail ?? "", event.type, event.category, event.level];
  collectSearchValues(event.payload, values, new WeakSet<object>());
  return values.some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
}

export function filterRuntimeEvents(
  events: readonly RuntimeEvent[],
  filters: EventObservationFilters,
): RuntimeEvent[] {
  const categories = filters.categories?.length ? new Set(filters.categories) : undefined;
  const normalizedQuery = filters.query?.trim().toLocaleLowerCase("zh-CN") ?? "";

  return events.filter((event) => {
    if (filters.mode === "key" && !isKeyRuntimeEvent(event)) return false;
    if (categories && !categories.has(event.category)) return false;
    return matchesQuery(event, normalizedQuery);
  });
}

function distinctValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function aggregate(events: RuntimeEvent[]): AggregatedEventItem {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  return {
    kind: "aggregate",
    id: `aggregate:${first.id}:${last.id}`,
    title: `${events.length} 条低价值事件`,
    count: events.length,
    events: [...events],
    categories: distinctValues(events.map((event) => event.category)),
    levels: distinctValues(events.map((event) => event.level)),
    startedAt: first.occurredAt,
    endedAt: last.occurredAt,
  };
}

/**
 * 只折叠两个关键事件之间连续出现的低价值事件。单条低价值事件保持普通形态，
 * 这样完整视图不会为偶发信息额外增加一次展开操作。
 */
export function aggregateLowValueEvents(events: readonly RuntimeEvent[]): EventObservationItem[] {
  const result: EventObservationItem[] = [];
  let pending: RuntimeEvent[] = [];

  const flush = () => {
    if (pending.length === 1) {
      const event = pending[0]!;
      result.push({ kind: "event", id: event.id, event });
    } else if (pending.length > 1) {
      result.push(aggregate(pending));
    }
    pending = [];
  };

  for (const event of events) {
    if (!isKeyRuntimeEvent(event)) {
      pending.push(event);
      continue;
    }
    flush();
    result.push({ kind: "event", id: event.id, event });
  }
  flush();
  return result;
}

export function buildEventObservation(
  events: readonly RuntimeEvent[],
  filters: EventObservationFilters,
): EventObservationItem[] {
  const matchingEvents = new Set(filterRuntimeEvents(events, filters));
  const result: EventObservationItem[] = [];
  let segment: RuntimeEvent[] = [];

  // 未命中的原始事件仍然是边界，避免搜索后把原本不连续的低价值事件误合并。
  const flush = () => {
    result.push(...aggregateLowValueEvents(segment));
    segment = [];
  };
  for (const event of events) {
    if (matchingEvents.has(event)) segment.push(event);
    else flush();
  }
  flush();
  return result;
}

function isSensitiveField(key: string): boolean {
  const normalized = normalizeIdentifier(key);
  if (SENSITIVE_FIELD_NAMES.has(normalized)) return true;
  return normalized.endsWith("token")
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("apikey")
    || normalized.endsWith("authorization")
    || normalized.endsWith("privatekey");
}

/**
 * 事件 payload 来自外部 Provider，详情展示前统一深拷贝并按字段名脱敏。
 * WeakMap 同时处理共享引用和意外循环引用，确保任何情况下都不回写原对象。
 */
export function redactSensitiveFields<T>(value: T): T {
  const copies = new WeakMap<object, unknown>();

  const visit = (current: unknown): unknown => {
    if (current === null || typeof current !== "object") return current;
    const cached = copies.get(current);
    if (cached !== undefined) return cached;

    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      copies.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }

    const copy: Record<string, unknown> = {};
    copies.set(current, copy);
    for (const [key, item] of Object.entries(current)) {
      copy[key] = isSensitiveField(key) ? REDACTED_VALUE : visit(item);
    }
    return copy;
  };

  return visit(value) as T;
}

function findPayloadValue(value: unknown, keys: ReadonlySet<string>, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPayloadValue(item, keys, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(normalizeIdentifier(key)) && item !== undefined && item !== null && item !== "") return item;
  }
  for (const item of Object.values(value)) {
    const found = findPayloadValue(item, keys, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function detailSection(payload: unknown, key: string, label: string, aliases: string[], format: EventDetailSection["format"]): EventDetailSection | undefined {
  const value = findPayloadValue(payload, new Set(aliases.map(normalizeIdentifier)));
  if (value === undefined) return undefined;
  return {
    key,
    label,
    value: typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value, null, 2),
    format,
  };
}

function structuredSections(event: RuntimeEvent, payload: Record<string, unknown> | undefined): EventDetailSection[] {
  if (!payload) return [];
  const candidates = event.category === "command" ? [
    detailSection(payload, "command", "执行命令", ["command", "cmd", "script"], "code"),
    detailSection(payload, "cwd", "工作目录", ["cwd", "workdir", "workingDirectory"], "code"),
    detailSection(payload, "exitCode", "退出码", ["exitCode", "code"], "text"),
    detailSection(payload, "stdout", "标准输出", ["stdout"], "code"),
    detailSection(payload, "stderr", "错误输出", ["stderr"], "code"),
  ] : event.category === "tool" ? [
    detailSection(payload, "toolName", "工具名称", ["toolName", "name", "tool"], "text"),
    detailSection(payload, "arguments", "调用参数", ["arguments", "args", "input"], "json"),
    detailSection(payload, "result", "调用结果", ["result", "output"], "json"),
  ] : event.category === "file" ? [
    detailSection(payload, "path", "文件路径", ["path", "filePath", "filename"], "code"),
    detailSection(payload, "change", "变更类型", ["change", "changeType", "action", "kind"], "text"),
    detailSection(payload, "diff", "文件差异", ["diff", "patch"], "code"),
  ] : [];
  return candidates.filter((section): section is EventDetailSection => section !== undefined);
}

export function extractStructuredEventDetails(event: RuntimeEvent): StructuredEventDetails {
  const fields: EventDetailField[] = [
    { key: "type", label: "事件类型", value: event.type },
    { key: "category", label: "分类", value: event.category },
    { key: "level", label: "级别", value: event.level },
    { key: "occurredAt", label: "发生时间", value: event.occurredAt },
  ];
  if (event.durationMs !== undefined) {
    fields.push({ key: "durationMs", label: "耗时（毫秒）", value: event.durationMs });
  }

  const payload = event.payload ? redactSensitiveFields(event.payload) : undefined;
  return {
    id: event.id,
    title: event.title,
    fields,
    sections: structuredSections(event, payload),
    content: event.detail?.trim() || undefined,
    payload,
  };
}

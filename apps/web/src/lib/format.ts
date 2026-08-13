import type { EventLevel, RunStatus, TaskStatus } from "@openartifact-labs/runtime-contracts";

export const taskStatusMeta: Record<TaskStatus, { label: string; tone: string; description: string }> = {
  not_loaded: {
    label: "客户端持有",
    tone: "muted",
    description: "任务由其他 Codex 客户端进程持有，当前 Provider 无法读取其实时运行状态",
  },
  idle: { label: "空闲", tone: "neutral", description: "任务已由当前 Provider 加载，当前没有运行中的回合" },
  running: { label: "运行中", tone: "blue", description: "任务正在执行" },
  waiting: { label: "等待中", tone: "amber", description: "任务正在等待输入、审批或外部结果" },
  completed: { label: "已完成", tone: "green", description: "任务已完成" },
  failed: { label: "失败", tone: "red", description: "任务执行失败" },
  interrupted: { label: "已中断", tone: "muted", description: "任务执行已中断" },
  stale: {
    label: "已失联",
    tone: "amber",
    description: "最后一轮没有结束记录，且长时间没有新事件；Codex 客户端可能已关闭",
  },
  unknown: { label: "未识别状态", tone: "muted", description: "Provider 未返回可识别的任务状态" },
};

export const runStatusMeta: Record<RunStatus, { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "amber" },
  running: { label: "运行中", tone: "blue" },
  completed: { label: "已完成", tone: "green" },
  failed: { label: "失败", tone: "red" },
  interrupted: { label: "已中断", tone: "muted" },
  stale: { label: "已失联", tone: "amber" },
};

export const eventLevelLabel: Record<EventLevel, string> = {
  debug: "调试",
  info: "信息",
  warning: "警告",
  error: "错误",
};

const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatDateTime(value?: string): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : dateTimeFormat.format(date);
}

export function formatTime(value?: string): string {
  if (!value) return "--:--:--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : timeFormat.format(date);
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return "--";
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} 秒`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function formatNumber(value?: number): string {
  return value === undefined ? "--" : new Intl.NumberFormat("zh-CN").format(value);
}

export function shortenPath(value?: string): string {
  if (!value) return "未记录工作目录";
  if (value.length <= 42) return value;
  const pieces = value.replaceAll("\\", "/").split("/");
  return `…/${pieces.slice(-3).join("/")}`;
}

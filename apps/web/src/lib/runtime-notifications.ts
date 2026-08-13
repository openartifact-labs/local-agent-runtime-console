export const RUNTIME_NOTIFICATION_TYPES = [
  "completed",
  "failed",
  "disconnected",
  "waiting_user",
  "waiting_approval",
] as const;

export type RuntimeNotificationType = (typeof RUNTIME_NOTIFICATION_TYPES)[number];

export interface RuntimeNotificationSignal {
  type: RuntimeNotificationType;
  taskId: string;
  runId: string;
  providerId: string;
  projectId: string;
}

export interface RuntimeNotificationData {
  taskId: string;
  runId: string;
}

export interface RuntimeNotificationCandidate extends RuntimeNotificationSignal {
  title: string;
  body: string;
  tag: string;
  data: RuntimeNotificationData;
}

export interface RuntimeNotificationSettings {
  enabled: boolean;
  providers?: Readonly<Record<string, boolean>>;
  projects?: Readonly<Record<string, boolean>>;
  types?: Readonly<Partial<Record<RuntimeNotificationType, boolean>>>;
}

export const DEFAULT_RUNTIME_NOTIFICATION_SETTINGS: Readonly<RuntimeNotificationSettings> = Object.freeze({
  enabled: false,
});

const notificationCopy: Record<RuntimeNotificationType, { title: string; body: string }> = {
  completed: {
    title: "任务已完成",
    body: "任务已完成，可返回运行控制台查看结果。",
  },
  failed: {
    title: "任务执行失败",
    body: "任务执行失败，可返回运行控制台查看详情。",
  },
  disconnected: {
    title: "任务意外失联",
    body: "任务运行连接意外中断，可返回运行控制台检查状态。",
  },
  waiting_user: {
    title: "任务等待你的输入",
    body: "任务正在等待你的输入，可返回运行控制台继续处理。",
  },
  waiting_approval: {
    title: "任务等待审批",
    body: "任务正在等待审批，可返回运行控制台处理。",
  },
};

/**
 * 候选文案只使用固定模板，避免将提问、命令、路径或文件内容带入系统通知。
 */
export function createRuntimeNotificationCandidate(
  signal: RuntimeNotificationSignal,
): RuntimeNotificationCandidate {
  const copy = notificationCopy[signal.type];
  return {
    ...signal,
    ...copy,
    tag: `runtime-task:${signal.taskId}:${signal.runId}:${signal.type}`,
    data: { taskId: signal.taskId, runId: signal.runId },
  };
}

export function isRuntimeNotificationEnabled(
  candidate: RuntimeNotificationCandidate,
  settings: RuntimeNotificationSettings = DEFAULT_RUNTIME_NOTIFICATION_SETTINGS,
): boolean {
  if (!settings.enabled) return false;
  if (settings.providers?.[candidate.providerId] === false) return false;
  if (settings.projects?.[candidate.projectId] === false) return false;
  if (settings.types?.[candidate.type] === false) return false;
  return true;
}

export interface BrowserNotification {
  close(): void;
}

export interface BrowserNotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): BrowserNotification;
}

export type RuntimeNotificationSkipReason =
  | "disabled"
  | "filtered"
  | "unsupported"
  | "permission_not_granted"
  | "deduplicated"
  | "send_failed";

export type RuntimeNotificationSendResult =
  | { sent: true; notification: BrowserNotification }
  | { sent: false; reason: RuntimeNotificationSkipReason };

export interface RuntimeNotificationSenderOptions {
  notificationApi?: BrowserNotificationApi | null;
  dedupeWindowMs?: number;
  now?: () => number;
}

const DEFAULT_DEDUPE_WINDOW_MS = 30_000;

function browserNotificationApi(): BrowserNotificationApi | null {
  return typeof Notification === "undefined"
    ? null
    : Notification as unknown as BrowserNotificationApi;
}

export class RuntimeNotificationSender {
  private readonly notificationApi: BrowserNotificationApi | null;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly sentAtByKey = new Map<string, number>();

  constructor(options: RuntimeNotificationSenderOptions = {}) {
    this.notificationApi = options.notificationApi === undefined
      ? browserNotificationApi()
      : options.notificationApi;
    this.dedupeWindowMs = Math.max(0, options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS);
    this.now = options.now ?? Date.now;
  }

  async requestPermission(): Promise<NotificationPermission | "unsupported"> {
    if (!this.notificationApi) return "unsupported";
    try {
      return await this.notificationApi.requestPermission();
    } catch {
      return this.notificationApi.permission;
    }
  }

  send(
    candidate: RuntimeNotificationCandidate,
    settings: RuntimeNotificationSettings = DEFAULT_RUNTIME_NOTIFICATION_SETTINGS,
  ): RuntimeNotificationSendResult {
    if (!settings.enabled) return { sent: false, reason: "disabled" };
    if (!isRuntimeNotificationEnabled(candidate, settings)) {
      return { sent: false, reason: "filtered" };
    }
    if (!this.notificationApi) return { sent: false, reason: "unsupported" };
    if (this.notificationApi.permission !== "granted") {
      return { sent: false, reason: "permission_not_granted" };
    }

    const now = this.now();
    const dedupeKey = `${candidate.taskId}:${candidate.runId}:${candidate.type}`;
    const lastSentAt = this.sentAtByKey.get(dedupeKey);
    if (lastSentAt !== undefined && now - lastSentAt < this.dedupeWindowMs) {
      return { sent: false, reason: "deduplicated" };
    }

    try {
      const notification = new this.notificationApi(candidate.title, {
        body: candidate.body,
        tag: candidate.tag,
        data: candidate.data,
      });
      // 只有浏览器成功创建通知后才记录时间，失败时允许下一次状态同步重试。
      this.sentAtByKey.set(dedupeKey, now);
      this.pruneDedupeEntries(now);
      return { sent: true, notification };
    } catch {
      return { sent: false, reason: "send_failed" };
    }
  }

  clearDedupe(): void {
    this.sentAtByKey.clear();
  }

  private pruneDedupeEntries(now: number): void {
    for (const [key, sentAt] of this.sentAtByKey) {
      if (now - sentAt >= this.dedupeWindowMs) this.sentAtByKey.delete(key);
    }
  }
}

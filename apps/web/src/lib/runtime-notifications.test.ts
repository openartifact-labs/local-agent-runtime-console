import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNTIME_NOTIFICATION_SETTINGS,
  RUNTIME_NOTIFICATION_TYPES,
  RuntimeNotificationSender,
  createRuntimeNotificationCandidate,
  isRuntimeNotificationEnabled,
  type BrowserNotification,
  type BrowserNotificationApi,
  type RuntimeNotificationSettings,
  type RuntimeNotificationType,
} from "./runtime-notifications";

const sensitiveContent = "rm -rf /private/path --secret=abc";

function candidate(type: RuntimeNotificationType = "completed") {
  return createRuntimeNotificationCandidate({
    type,
    taskId: "task-1",
    runId: "run-1",
    providerId: "codex-local",
    projectId: "project-console",
  });
}

function notificationApi(permission: NotificationPermission = "granted") {
  const calls: Array<{ title: string; options?: NotificationOptions }> = [];

  class FakeNotification implements BrowserNotification {
    static permission = permission;

    static async requestPermission(): Promise<NotificationPermission> {
      return FakeNotification.permission;
    }

    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
    }

    close(): void {}
  }

  return { api: FakeNotification as BrowserNotificationApi, calls };
}

test("为五类运行状态生成固定脱敏通知候选", () => {
  for (const type of RUNTIME_NOTIFICATION_TYPES) {
    const result = createRuntimeNotificationCandidate({
      type,
      taskId: "task-sensitive",
      runId: "run-sensitive",
      providerId: "provider-sensitive",
      projectId: "project-sensitive",
      // 即使调用方错误地附带敏感字段，候选文案也不会读取这些字段。
      prompt: sensitiveContent,
      command: sensitiveContent,
      fileContent: sensitiveContent,
    } as Parameters<typeof createRuntimeNotificationCandidate>[0]);

    assert.ok(result.title.length > 0);
    assert.ok(result.body.length > 0);
    assert.equal(result.body.includes(sensitiveContent), false);
    assert.deepEqual(result.data, { taskId: "task-sensitive", runId: "run-sensitive" });
  }
});

test("通知默认关闭，并支持按 provider、project 和 type 禁用", () => {
  const item = candidate();
  assert.equal(DEFAULT_RUNTIME_NOTIFICATION_SETTINGS.enabled, false);
  assert.equal(isRuntimeNotificationEnabled(item), false);
  assert.equal(isRuntimeNotificationEnabled(item, { enabled: true }), true);

  const disabledSettings: RuntimeNotificationSettings[] = [
    { enabled: true, providers: { "codex-local": false } },
    { enabled: true, projects: { "project-console": false } },
    { enabled: true, types: { completed: false } },
  ];
  for (const settings of disabledSettings) {
    assert.equal(isRuntimeNotificationEnabled(item, settings), false);
  }
});

test("只有显式开启且浏览器授权后才发送，并携带点击定位数据", () => {
  const { api, calls } = notificationApi();
  const sender = new RuntimeNotificationSender({ notificationApi: api });

  assert.deepEqual(sender.send(candidate()), { sent: false, reason: "disabled" });
  const result = sender.send(candidate(), { enabled: true });

  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.options?.data, { taskId: "task-1", runId: "run-1" });
});

test("浏览器未授权时不发送通知", () => {
  const { api, calls } = notificationApi("default");
  const sender = new RuntimeNotificationSender({ notificationApi: api });

  assert.deepEqual(sender.send(candidate(), { enabled: true }), {
    sent: false,
    reason: "permission_not_granted",
  });
  assert.equal(calls.length, 0);
});

test("相同任务、运行和通知类型在窗口内去重，窗口后允许再次发送", () => {
  const { api, calls } = notificationApi();
  let now = 1_000;
  const sender = new RuntimeNotificationSender({
    notificationApi: api,
    dedupeWindowMs: 5_000,
    now: () => now,
  });
  const settings = { enabled: true };

  assert.equal(sender.send(candidate(), settings).sent, true);
  now = 3_000;
  assert.deepEqual(sender.send(candidate(), settings), { sent: false, reason: "deduplicated" });
  now = 6_000;
  assert.equal(sender.send(candidate(), settings).sent, true);
  assert.equal(calls.length, 2);
});

test("不同通知类型不会互相吞掉关键状态变更", () => {
  const { api, calls } = notificationApi();
  const sender = new RuntimeNotificationSender({ notificationApi: api });

  assert.equal(sender.send(candidate("waiting_user"), { enabled: true }).sent, true);
  assert.equal(sender.send(candidate("failed"), { enabled: true }).sent, true);
  assert.equal(calls.length, 2);
});

test("Notification API 不可用时安全降级", async () => {
  const sender = new RuntimeNotificationSender({ notificationApi: null });

  assert.equal(await sender.requestPermission(), "unsupported");
  assert.deepEqual(sender.send(candidate(), { enabled: true }), {
    sent: false,
    reason: "unsupported",
  });
});

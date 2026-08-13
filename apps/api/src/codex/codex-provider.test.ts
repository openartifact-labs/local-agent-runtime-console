import assert from "node:assert/strict";
import test from "node:test";

import type { CodexThread } from "./protocol.js";
import { mapCodexThread } from "./codex-provider.js";

test("未结束且长时间无事件的客户端任务标记为已失联", () => {
  const thread: CodexThread = {
    id: "thread-stale",
    status: { type: "notLoaded" },
    createdAt: 1_786_080_000,
    updatedAt: 1_786_080_000,
  };
  const task = mapCodexThread(thread, "discovered", {
    status: "running",
    lastObservedAt: new Date(Date.now() - 10_000).toISOString(),
    events: [],
  }, 1_000);

  assert.equal(task.status, "stale");
});

test("近期仍有事件的客户端任务保持运行中", () => {
  const thread: CodexThread = { id: "thread-running", status: { type: "notLoaded" } };
  const task = mapCodexThread(thread, "discovered", {
    status: "running",
    lastObservedAt: new Date().toISOString(),
    events: [],
  }, 60_000);

  assert.equal(task.status, "running");
});

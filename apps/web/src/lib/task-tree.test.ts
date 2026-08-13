import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeTask } from "@openartifact-labs/runtime-contracts";

import {
  ancestorTaskIds,
  buildTaskTree,
  findFirstDirectMatch,
  taskIsDirectMatch,
  taskMatchesMetric,
} from "./task-tree";

function task(
  externalId: string,
  title: string,
  relation?: RuntimeTask["relation"],
): RuntimeTask {
  return {
    id: `id-${externalId}`,
    externalId,
    providerId: "codex-local",
    title,
    source: "discovered",
    status: "running",
    createdAt: "2026-08-07T06:00:00.000Z",
    updatedAt: "2026-08-07T06:00:00.000Z",
    relation,
  };
}

const tasks = [
  task("parent-a", "腾讯"),
  task("child-a", "每日简报前端", {
    type: "subtask",
    parentExternalId: "parent-a",
    parentTitle: "腾讯",
    depth: 1,
    agentName: "Ampere",
  }),
  task("parent-b", "小程序"),
  task("child-b", "生成题库", {
    type: "subtask",
    parentExternalId: "parent-b",
    parentTitle: "小程序",
    depth: 1,
    agentName: "Zeno",
  }),
];

test("按父任务 ID 将多个父任务及其子任务分别建组", () => {
  const result = buildTaskTree(tasks, { query: "", source: "all", status: "all" });

  assert.equal(result.roots.length, 2);
  assert.equal(result.matchedTaskCount, 4);
  assert.deepEqual(
    result.roots.map((root) => [root.task.title, root.children.map((child) => child.task.title)]),
    [["腾讯", ["每日简报前端"]], ["小程序", ["生成题库"]]],
  );
});

test("筛选子任务时保留各自父任务作为上下文", () => {
  const result = buildTaskTree(tasks, { query: "", source: "subtask", status: "all" });

  assert.equal(result.roots.length, 2);
  assert.equal(result.matchedTaskCount, 2);
  assert.ok(result.roots.every((root) => !root.directMatch));
  assert.ok(result.roots.every((root) => root.children.length === 1));
});

test("可以按 Agent 名称定位子任务及所属父任务", () => {
  const result = buildTaskTree(tasks, { query: "ampere", source: "subtask", status: "all" });

  assert.equal(result.matchedTaskCount, 1);
  assert.equal(result.roots.length, 1);
  assert.equal(result.roots[0]?.task.title, "腾讯");
  assert.equal(result.roots[0]?.children[0]?.task.title, "每日简报前端");
  assert.deepEqual(ancestorTaskIds(result.roots, "id-child-a"), ["id-parent-a"]);
});

test("顶部组合指标使用独立于原子状态的统一筛选口径", () => {
  const statusTask = (status: RuntimeTask["status"], source: RuntimeTask["source"] = "discovered") => ({ status, source });

  assert.equal(taskMatchesMetric(statusTask("running"), "active"), true);
  assert.equal(taskMatchesMetric(statusTask("waiting"), "active"), true);
  assert.equal(taskMatchesMetric(statusTask("completed"), "active"), false);
  assert.equal(taskMatchesMetric(statusTask("failed"), "abnormal"), true);
  assert.equal(taskMatchesMetric(statusTask("stale"), "abnormal"), true);
  assert.equal(taskMatchesMetric(statusTask("interrupted"), "abnormal"), false);
  assert.equal(taskMatchesMetric(statusTask("completed", "managed"), "managed"), true);
});

test("父任务仅作筛选上下文时首个直接命中项是子任务", () => {
  const result = buildTaskTree(tasks, { query: "ampere", source: "all", status: "all", metric: "active" });
  const firstMatch = findFirstDirectMatch(result.roots);

  assert.equal(result.matchedTaskCount, 1);
  assert.equal(firstMatch?.task.id, "id-child-a");
  assert.equal(taskIsDirectMatch(result.roots, "id-parent-a"), false);
  assert.equal(taskIsDirectMatch(result.roots, "id-child-a"), true);
});

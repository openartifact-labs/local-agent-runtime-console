import assert from "node:assert/strict";
import test from "node:test";

import { appServerSpawnSpec } from "./codex-app-server-client.js";

test("Windows 通过 ComSpec 启动 app-server，且不依赖 shell:true", () => {
  assert.deepEqual(appServerSpawnSpec("codex", "win32", "C:\\Windows\\System32\\cmd.exe"), {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "codex app-server --stdio"],
  });
});

test("Windows 可直接启动显式 codex.exe", () => {
  assert.deepEqual(appServerSpawnSpec("C:\\Tools\\codex.exe", "win32"), {
    file: "C:\\Tools\\codex.exe",
    args: ["app-server", "--stdio"],
  });
});

test("非 Windows 平台直接执行 codex", () => {
  assert.deepEqual(appServerSpawnSpec("/usr/local/bin/codex", "linux"), { file: "/usr/local/bin/codex", args: ["app-server", "--stdio"] });
});

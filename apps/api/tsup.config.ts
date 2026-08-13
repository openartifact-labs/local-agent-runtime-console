import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  shims: true,
  banner: {
    js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);',
  },
  // 桌面安装包只复制 API 构建目录，因此直接运行依赖必须一并打入产物。
  // 不使用全匹配，避免把 node:sqlite 等 Node 内置模块误当成 npm 包处理。
  noExternal: [
    "@openartifact-labs/runtime-contracts",
    "@fastify/cors",
    "@fastify/static",
    "dotenv",
    "fastify",
  ],
});

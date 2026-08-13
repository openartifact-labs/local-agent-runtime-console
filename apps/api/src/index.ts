import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { CodexAppServerClient } from "./codex/codex-app-server-client.js";
import { CodexProvider } from "./codex/codex-provider.js";
import { loadConfig } from "./config.js";
import { SqliteRuntimeRepository } from "./db/sqlite-runtime-repository.js";
import { errorMessage } from "./errors.js";
import { RuntimeService } from "./runtime-service.js";

export interface RuntimeServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  staticRoot?: string;
}

export interface RuntimeServerHandle {
  url: string;
  close(): Promise<void>;
}

const logger = {
  debug: (context: object, message: string) => console.debug(message, context),
  info: (context: object, message: string) => console.info(message, context),
  warn: (context: object, message: string) => console.warn(message, context),
  error: (context: object, message: string) => console.error(message, context),
};

export async function startRuntimeServer(options: RuntimeServerOptions = {}): Promise<RuntimeServerHandle> {
  const loaded = loadConfig(process.env, { dataDirectory: options.dataDir });
  const config = {
    ...loaded,
    host: options.host ?? loaded.host,
    port: options.port ?? loaded.port,
  };
  const client = new CodexAppServerClient({
    command: config.codex.bin,
    requestTimeoutMs: config.codex.requestTimeoutMs,
    reconnectBaseDelayMs: config.codex.reconnectBaseDelayMs,
    reconnectMaxDelayMs: config.codex.reconnectMaxDelayMs,
    logger,
  });
  const provider = new CodexProvider(client, {
    pageSize: config.codex.listPageSize,
    maxPages: config.codex.listMaxPages,
    staleAfterMs: config.codex.staleAfterMs,
  });
  const repository = new SqliteRuntimeRepository(config.database);
  const service = new RuntimeService(repository, provider, config);

  try {
    await service.start();
    const app = await buildApp(config, service, { staticRoot: options.staticRoot });
    const url = await app.listen({ host: config.host, port: config.port });
    return { url, close: () => app.close() };
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  startRuntimeServer().catch((error) => {
    console.error(`Local Agent Runtime API 启动失败：${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

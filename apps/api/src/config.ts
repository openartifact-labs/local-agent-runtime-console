import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";

import { ConfigurationError } from "./errors.js";

export interface AppConfig {
  host: string;
  port: number;
  webOrigin: string;
  logLevel: string;
  database: {
    path: string;
  };
  codex: {
    bin: string;
    requestTimeoutMs: number;
    reconnectBaseDelayMs: number;
    reconnectMaxDelayMs: number;
    syncIntervalMs: number;
    staleAfterMs: number;
    listPageSize: number;
    listMaxPages: number;
  };
}

export interface LoadConfigOptions {
  /** 桌面端应传入操作系统分配给应用的本地数据目录。 */
  dataDirectory?: string;
}

const ROOT_ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));
const APP_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const DEVELOPMENT_DATA_DIRECTORY = fileURLToPath(new URL("../../../.runtime/data/", import.meta.url));
let dotEnvLoaded = false;

function loadEnvironmentFiles(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const explicitPath = process.env.ENV_FILE;
  for (const path of explicitPath ? [explicitPath] : [ROOT_ENV_PATH, APP_ENV_PATH]) {
    if (existsSync(path)) loadDotEnv({ path, override: false, quiet: true });
  }
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new ConfigurationError(`${name} 必须是 1 到 ${max} 之间的整数`);
  }
  return value;
}

function databasePath(env: NodeJS.ProcessEnv, options: LoadConfigOptions): string {
  const configuredPath = env.DATABASE_PATH?.trim();
  if (configuredPath) return isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);

  const configuredDataDirectory = options.dataDirectory?.trim() || env.RUNTIME_DATA_DIR?.trim();
  const dataDirectory = configuredDataDirectory
    ? (isAbsolute(configuredDataDirectory) ? configuredDataDirectory : resolve(configuredDataDirectory))
    : DEVELOPMENT_DATA_DIRECTORY;
  return join(dataDirectory, "runtime-console.sqlite");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  if (env === process.env) loadEnvironmentFiles();
  return {
    host: env.API_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env, "API_PORT", 4318, 65_535),
    webOrigin: env.WEB_ORIGIN?.trim() || "http://127.0.0.1:5173",
    logLevel: env.LOG_LEVEL?.trim() || "info",
    database: {
      path: databasePath(env, options),
    },
    codex: {
      bin: env.CODEX_BIN?.trim() || "codex",
      requestTimeoutMs: positiveInteger(env, "CODEX_REQUEST_TIMEOUT_MS", 30_000),
      reconnectBaseDelayMs: positiveInteger(env, "CODEX_RECONNECT_BASE_DELAY_MS", 500),
      reconnectMaxDelayMs: positiveInteger(env, "CODEX_RECONNECT_MAX_DELAY_MS", 30_000),
      syncIntervalMs: positiveInteger(env, "CODEX_SYNC_INTERVAL_MS", 5_000),
      staleAfterMs: positiveInteger(env, "CODEX_STALE_AFTER_MS", 180_000),
      listPageSize: positiveInteger(env, "CODEX_LIST_PAGE_SIZE", 100, 1_000),
      listMaxPages: positiveInteger(env, "CODEX_LIST_MAX_PAGES", 100, 1_000),
    },
  };
}

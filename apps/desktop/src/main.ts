import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, session, shell } from "electron";

app.setName("Local Agent Runtime Console");

const DEFAULT_DEVELOPMENT_API_PORT = 4318;
const LOOPBACK_HOST = "127.0.0.1";

interface RuntimeServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  staticRoot?: string;
}

interface RuntimeServerHandle {
  url: string;
  close: () => Promise<void> | void;
}

interface RuntimeServerModule {
  startRuntimeServer: (options: RuntimeServerOptions) => Promise<RuntimeServerHandle> | RuntimeServerHandle;
}

let runtimeServer: RuntimeServerHandle | undefined;
let runtimeUrl: URL | undefined;
let mainWindow: BrowserWindow | undefined;
let isQuitting = false;

function parseLoopbackUrl(rawValue: string | undefined, variableName: string): URL | undefined {
  const value = rawValue?.trim();
  if (!value) return undefined;

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`${variableName} 仅允许使用本机 HTTP 地址`);
  }
  return url;
}

function parsePort(rawValue: string | undefined, fallback: number): number {
  if (!rawValue?.trim()) return fallback;
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LARC_API_PORT 必须是 1 到 65535 之间的整数");
  }
  return port;
}

function resolveApiEntry(): string {
  const explicitEntry = process.env.LARC_API_ENTRY?.trim();
  const entry = explicitEntry
    ? path.resolve(explicitEntry)
    : app.isPackaged
      ? path.join(process.resourcesPath, "api", "index.js")
      : path.resolve(app.getAppPath(), "../api/dist/index.js");

  if (!existsSync(entry)) {
    throw new Error("未找到本地 API 构建产物，请先构建 apps/api");
  }
  return entry;
}

function resolveWebStaticDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.resolve(app.getAppPath(), "../web/dist");
}

async function loadRuntimeServerModule(): Promise<RuntimeServerModule> {
  const module = await import(pathToFileURL(resolveApiEntry()).href) as Partial<RuntimeServerModule>;
  if (typeof module.startRuntimeServer !== "function") {
    throw new Error("本地 API 未导出 startRuntimeServer");
  }
  return module as RuntimeServerModule;
}

async function startApi(): Promise<URL> {
  const externalApiUrl = parseLoopbackUrl(process.env.LARC_API_URL, "LARC_API_URL");
  if (externalApiUrl) return externalApiUrl;

  const developmentWebUrl = parseLoopbackUrl(process.env.LARC_WEB_URL, "LARC_WEB_URL");
  const staticRoot = developmentWebUrl ? undefined : resolveWebStaticDirectory();
  if (staticRoot && !existsSync(staticRoot)) {
    throw new Error("未找到 Web 构建产物，请先构建 apps/web");
  }

  const { startRuntimeServer } = await loadRuntimeServerModule();
  runtimeServer = await startRuntimeServer({
    host: LOOPBACK_HOST,
    // 生产态使用随机空闲端口，开发态保持与 Vite 代理约定一致。
    port: app.isPackaged ? 0 : parsePort(process.env.LARC_API_PORT, DEFAULT_DEVELOPMENT_API_PORT),
    dataDir: app.getPath("userData"),
    staticRoot
  });

  const apiBaseUrl = parseLoopbackUrl(runtimeServer.url, "startRuntimeServer.url");
  if (!apiBaseUrl) throw new Error("本地 API 未返回访问地址");
  return apiBaseUrl;
}

async function stopApi(): Promise<void> {
  const server = runtimeServer;
  runtimeServer = undefined;
  runtimeUrl = undefined;
  if (server) await server.close();
}

function configureSessionSecurity(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

async function createMainWindow(apiBaseUrl: URL): Promise<void> {
  const developmentWebUrl = parseLoopbackUrl(process.env.LARC_WEB_URL, "LARC_WEB_URL");
  const targetUrl = developmentWebUrl ?? apiBaseUrl;

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: "#101722",
    title: "Local Agent Runtime Console",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  const allowedOrigin = targetUrl.origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = new URL(url);
    if (externalUrl.protocol === "https:") void shell.openExternal(externalUrl.toString());
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });

  await mainWindow.loadURL(targetUrl.toString());
}

async function bootstrap(): Promise<void> {
  configureSessionSecurity();
  runtimeUrl ??= await startApi();
  await createMainWindow(runtimeUrl);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "桌面应用启动失败";
    dialog.showErrorBox("Local Agent Runtime Console 启动失败", message);
    isQuitting = true;
    await stopApi();
    app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow) void bootstrap();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (isQuitting || !runtimeServer) return;
    event.preventDefault();
    isQuitting = true;
    void stopApi().finally(() => app.quit());
  });
}

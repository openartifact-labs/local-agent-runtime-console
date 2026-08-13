import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { LaunchTaskInput } from "@openartifact-labs/runtime-contracts";

import type { AppConfig } from "./config.js";
import { AppError, ValidationError, errorMessage } from "./errors.js";
import type { RuntimeService, StreamMessage } from "./runtime-service.js";

export interface BuildAppOptions {
  staticRoot?: string;
}

function writeSse(response: NodeJS.WritableStream, message: StreamMessage): void {
  response.write(`event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`);
}

function httpErrorDetails(error: unknown): { statusCode: number; message?: string } {
  if (error instanceof AppError) return { statusCode: error.statusCode, message: error.message };
  if (typeof error !== "object" || error === null) return { statusCode: 500 };

  const candidate = error as { statusCode?: unknown; message?: unknown };
  return {
    statusCode: typeof candidate.statusCode === "number" ? candidate.statusCode : 500,
    message: typeof candidate.message === "string" ? candidate.message : undefined,
  };
}

export async function buildApp(
  config: AppConfig,
  service: RuntimeService,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel, base: undefined } });
  await app.register(cors, { origin: config.webOrigin });
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, message } = httpErrorDetails(error);
    if (statusCode >= 500) app.log.error({ err: error }, "API 请求失败");
    reply.status(statusCode).send({
      message: statusCode < 500 ? message ?? "请求失败" : "服务器内部错误",
    });
  });
  app.get("/api/health", async () => ({ status: "ok", time: new Date().toISOString() }));
  app.get("/api/providers", async () => ({ items: await service.providers() }));
  app.get<{ Params: { id: string } }>("/api/providers/:id/usage", async (request) => service.providerUsage(request.params.id));
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>("/api/providers/:id/usage-analytics", async (request) => {
    const days = request.query.days === undefined ? undefined : Number(request.query.days);
    return service.providerUsageAnalytics(request.params.id, days);
  });
  app.get("/api/tasks", async () => service.tasks());
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => service.taskDetail(request.params.id));
  app.post<{ Body: LaunchTaskInput }>("/api/tasks", async (request, reply) => { const body = request.body; if (!body || typeof body !== "object") throw new ValidationError("请求体必须是 JSON 对象"); reply.code(201); return service.launch(body); });
  app.post<{ Params: { id: string } }>("/api/runs/:id/interrupt", async (request, reply) => { await service.interrupt(request.params.id); reply.code(204).send(); });
  app.get("/api/stream", async (request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.write(": connected\n\n");
    const unsubscribe = service.onStream((message) => writeSse(reply.raw, message));
    request.raw.once("close", unsubscribe);
  });
  if (options.staticRoot) {
    await app.register(fastifyStatic, {
      root: options.staticRoot,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      // API 路由拼写错误必须返回结构化 404，只有界面路由才回退到 SPA 入口。
      if (request.url.startsWith("/api/")) {
        reply.code(404).send({ message: "接口不存在" });
        return;
      }
      reply.sendFile("index.html");
    });
  }
  app.addHook("onClose", async () => { await service.close(); });
  return app;
}

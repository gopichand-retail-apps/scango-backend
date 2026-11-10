import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createCheckoutRepository } from "./checkout.repository.mjs";
import { APP_VERSION } from "./app-version.mjs";
import { createCheckoutService, CheckoutError } from "./checkout.service.mjs";
import { contentModelSchema } from "./content-model.schema.mjs";
import { createRouteRegistry, resolveRoute } from "./routes.mjs";

const modelPath = fileURLToPath(new URL("../../scango-frontend/public/scango-model.json", import.meta.url));
const idempotencyPattern = /^[a-zA-Z0-9._:-]{1,128}$/;
const defaultAllowedOrigins = ["http://127.0.0.1:5111", "http://localhost:5111"];
const defaultRateLimit = 160;
const defaultRateWindowMs = 60_000;

export function loadModel() {
  let sourceText;
  try {
    sourceText = readFileSync(modelPath, "utf8");
  } catch {
    throw new Error("The ScanGo content model is unavailable or invalid.");
  }
  return parseModelText(sourceText);
}

export function parseModelText(sourceText) {
  let source;
  try {
    source = JSON.parse(sourceText);
  } catch {
    throw new Error("The ScanGo content model is unavailable or invalid.");
  }
  const parsed = contentModelSchema.safeParse(source);
  if (!parsed.success) throw new Error("The ScanGo content model does not match the supported versioned contract.");
  return parsed.data;
}

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function writeLog(entry) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

function getTraceIds(request) {
  const traceParent = request.headers.traceparent ?? "";
  const match = /^\w{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i.exec(traceParent);
  return {
    traceId: match?.[1] ?? randomUUID().replaceAll("-", ""),
    spanId: match?.[2] ?? randomUUID().replaceAll("-", "").slice(0, 16),
  };
}

function createRateLimiter(maximum, windowMs) {
  const windows = new Map();
  return function isLimited(key, now = Date.now()) {
    const current = windows.get(key);
    if (!current || now >= current.resetAt) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }
    current.count += 1;
    return current.count > maximum;
  };
}

async function readJsonBody(request, maximumBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new RequestError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the allowed size.");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
}

function parseBody(schema, body, model) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new RequestError(400, "INVALID_REQUEST", model.messages.errors.invalidRequest);
  }
  return parsed.data;
}

function requireIdempotencyKey(request, model) {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !idempotencyPattern.test(key)) {
    throw new RequestError(400, "IDEMPOTENCY_KEY_REQUIRED", model.messages.errors.invalidRequest);
  }
  return key;
}

function setResponseHeaders(request, response, allowedOrigins, model, requestId, traceId) {
  response.setHeader("X-Request-ID", requestId);
  response.setHeader("X-Trace-ID", traceId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    throw new RequestError(403, "ORIGIN_NOT_ALLOWED", model.messages.errors.originNotAllowed);
  }
  if (!origin) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, Traceparent");
  response.setHeader("Access-Control-Expose-Headers", "X-Request-ID, X-Trace-ID");
}

async function dispatchRequest(request, url, routes, model, isRateLimited) {
  if (isRateLimited(request.socket.remoteAddress ?? "local")) {
    throw new RequestError(429, "RATE_LIMITED", model.messages.errors.rateLimited);
  }
  const resolved = resolveRoute(request.method ?? "GET", url.pathname, routes);
  if (!resolved) {
    throw new RequestError(404, "NOT_FOUND", model.messages.errors.notFound);
  }
  const body =
    request.method === "POST"
      ? parseBody(resolved.route.schema, await readJsonBody(request, model.data.app.maximumBodyBytes), model)
      : undefined;
  const key = resolved.route.requiresIdempotency ? requireIdempotencyKey(request, model) : undefined;
  return {
    status: resolved.route.status,
    routeTemplate: resolved.route.template,
    data: resolved.route.execute({ sessionId: resolved.sessionId, body, key }),
  };
}

async function handleApiRequest(request, response, context) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const { traceId, spanId } = getTraceIds(request);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let status = 500;
  let errorCode;
  let routeTemplate = url.pathname;
  try {
    setResponseHeaders(request, response, context.allowedOrigins, context.model, requestId, traceId);
    if (request.method === "OPTIONS") {
      status = 204;
      response.writeHead(status);
      response.end();
      return;
    }
    const result = await dispatchRequest(request, url, context.routes, context.model, context.isRateLimited);
    status = result.status;
    routeTemplate = result.routeTemplate;
    sendJson(response, status, { data: result.data });
  } catch (error) {
    status = Number.isInteger(error.status) ? error.status : 500;
    errorCode = error.code ?? "INTERNAL_ERROR";
    const message =
      error instanceof CheckoutError || error instanceof RequestError
        ? error.message
        : context.model.messages.errors.server;
    sendJson(response, status, {
      error: { code: errorCode, message, requestId },
    });
  } finally {
    writeLog({
      level: status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO",
      service: "scango-api",
      environment: process.env.NODE_ENV ?? "development",
      version: APP_VERSION,
      eventName: status >= 400 ? "api.request.failed" : "api.request.completed",
      requestId,
      traceId,
      spanId,
      method: request.method,
      routeTemplate,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: status < 400 ? "success" : "failure",
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

export function createApiServer({
  databasePath = "data/scango.sqlite",
  model = loadModel(),
  allowedOrigins = defaultAllowedOrigins,
  rateLimit = defaultRateLimit,
  rateWindowMs = defaultRateWindowMs,
} = {}) {
  const repository = createCheckoutRepository({ databasePath, model });
  const service = createCheckoutService({ repository, model });
  const routes = createRouteRegistry(service, model);
  const isRateLimited = createRateLimiter(rateLimit, rateWindowMs);
  const context = { model, routes, isRateLimited, allowedOrigins };
  const server = createServer((request, response) => handleApiRequest(request, response, context));

  return {
    server,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => {
          repository.close();
          if (error) reject(error);
          else resolveClose();
        });
        server.closeAllConnections();
      }),
  };
}

export function addLocalE2EOrigin(allowedOrigins, origin = process.env.SCANGO_E2E_FRONTEND_ORIGIN) {
  if (!origin) return allowedOrigins;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("SCANGO_E2E_FRONTEND_ORIGIN must be an HTTP loopback origin.");
  }
  if (
    parsedOrigin.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsedOrigin.hostname) ||
    parsedOrigin.origin !== origin
  ) {
    throw new Error("SCANGO_E2E_FRONTEND_ORIGIN must be an HTTP loopback origin.");
  }
  return [...new Set([...allowedOrigins, origin])];
}

export function readAllowedOrigins(value = process.env.SCANGO_ALLOWED_ORIGINS) {
  if (value === undefined) return defaultAllowedOrigins;
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!origins.length) throw new Error("SCANGO_ALLOWED_ORIGINS must contain at least one absolute origin.");
  for (const origin of origins) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error("SCANGO_ALLOWED_ORIGINS must contain only absolute HTTP(S) origins.");
    }
    if (!(parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") || parsedOrigin.origin !== origin) {
      throw new Error("SCANGO_ALLOWED_ORIGINS must contain only absolute HTTP(S) origins.");
    }
  }
  return [...new Set(origins)];
}

export function resolveServerSettings(environment = process.env) {
  return {
    databasePath: environment.SCANGO_DB_PATH ?? fileURLToPath(new URL("../data/scango.sqlite", import.meta.url)),
    port: Number(environment.PORT ?? 5112),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const settings = resolveServerSettings();
  const api = createApiServer({
    databasePath: settings.databasePath,
    model: loadModel(),
    allowedOrigins: addLocalE2EOrigin(readAllowedOrigins()),
  });
  const port = settings.port;
  api.server.listen(port, "127.0.0.1", () => {
    writeLog({
      level: "INFO",
      service: "scango-api",
      version: APP_VERSION,
      eventName: "service.started",
      port,
      storage: "sqlite",
    });
  });
  const shutdown = () => api.close().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contentModelSchema } from "./content-model.schema.mjs";
import {
  addLocalE2EOrigin,
  createApiServer,
  loadModel,
  parseModelText,
  readAllowedOrigins,
  resolveServerSettings,
} from "./server.mjs";

async function startApi(t, overrides = {}) {
  const api = createApiServer({ databasePath: ":memory:", ...overrides });
  await new Promise((resolveListen, rejectListen) => {
    api.server.once("error", rejectListen);
    api.server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => api.close());
  const address = api.server.address();
  return `http://127.0.0.1:${address.port}/api/v1`;
}

async function startSession(baseUrl, key = "start-session-key") {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: "{}",
  });
  return { response, payload: await response.json() };
}

async function postJson(baseUrl, path, key, payload = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(payload),
  });
}

test("health and catalog expose readiness and synthetic products", async (t) => {
  const baseUrl = await startApi(t);
  const health = await fetch(`${baseUrl}/health`);
  const version = await fetch(`${baseUrl}/version`);
  const catalog = await fetch(`${baseUrl}/catalog`);
  const healthBody = await health.json();
  const versionBody = await version.json();
  const catalogBody = await catalog.json();

  assert.equal(health.status, 200);
  assert.equal(healthBody.data.service, "scango-api");
  assert.ok(health.headers.get("x-request-id"));
  assert.equal(version.status, 200);
  assert.deepEqual(versionBody.data, { service: "scango-api", version: "1.0.0" });
  assert.equal(catalog.status, 200);
  assert.equal(catalogBody.data.products.length, 7);
});

test("the API validates the strict versioned content model and server origin settings", () => {
  const model = loadModel();
  const legacyModel = { modelVersion: 1, app: {}, copy: {} };
  const missingMessageModel = { ...model, messages: { ...model.messages, sessionExpired: undefined } };
  const endpointModel = { ...model, data: { ...model.data, apiBaseUrl: "http://127.0.0.1" } };

  assert.equal(model.version, 1);
  assert.equal(model.appId, "scango");
  assert.equal(model.locale, "en-US");
  assert.equal(contentModelSchema.safeParse(legacyModel).success, false);
  assert.equal(contentModelSchema.safeParse({ ...model, appId: "another-app" }).success, false);
  assert.equal(contentModelSchema.safeParse(missingMessageModel).success, false);
  assert.equal(contentModelSchema.safeParse(endpointModel).success, false);
  assert.deepEqual(readAllowedOrigins("http://localhost:5111, https://kiosk.example"), [
    "http://localhost:5111",
    "https://kiosk.example",
  ]);
  assert.throws(() => readAllowedOrigins("*"), /absolute HTTP\(S\) origins/);
  assert.throws(() => readAllowedOrigins(""), /at least one absolute origin/);
  assert.throws(() => readAllowedOrigins("ftp://kiosk.example"), /absolute HTTP\(S\) origins/);
  assert.deepEqual(addLocalE2EOrigin(["http://localhost:5111"], null), ["http://localhost:5111"]);
  assert.deepEqual(addLocalE2EOrigin(["http://localhost:5111"], "http://127.0.0.1:5113"), [
    "http://localhost:5111",
    "http://127.0.0.1:5113",
  ]);
  assert.throws(() => addLocalE2EOrigin([], "not-an-origin"), /HTTP loopback origin/);
  assert.throws(() => addLocalE2EOrigin([], "https://outside.example"), /HTTP loopback origin/);
  assert.throws(() => addLocalE2EOrigin([], "http://outside.example"), /HTTP loopback origin/);
  assert.equal(resolveServerSettings({}).port, 5112);
  assert.match(resolveServerSettings({}).databasePath, /scango-backend\/data\/scango\.sqlite$/);
  assert.deepEqual(resolveServerSettings({ PORT: "0", SCANGO_DB_PATH: ":memory:" }), {
    port: 0,
    databasePath: ":memory:",
  });
});

test("model source parsing returns safe errors for invalid JSON and unsupported models", () => {
  assert.throws(() => parseModelText("{"), /unavailable or invalid/);
  assert.throws(() => parseModelText(JSON.stringify({ version: 2 })), /supported versioned contract/);
});

test("session start and scan replay are idempotent and totals use API prices", async (t) => {
  const baseUrl = await startApi(t);
  const first = await startSession(baseUrl);
  const replay = await startSession(baseUrl);
  const sessionId = first.payload.data.id;
  const scanRequest = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "scan-idempotency-key",
    },
    body: JSON.stringify({ barcode: "QS-BRD-031", source: "barcode" }),
  };
  const scan = await fetch(`${baseUrl}/sessions/${sessionId}/scan`, scanRequest);
  const scanReplay = await fetch(`${baseUrl}/sessions/${sessionId}/scan`, scanRequest);
  const scanBody = await scan.json();
  const replayBody = await scanReplay.json();

  assert.equal(first.response.status, 201);
  assert.equal(first.payload.data.state, "scanning");
  assert.equal(replay.payload.data.id, sessionId);
  assert.equal(scan.status, 200);
  assert.deepEqual(replayBody.data, scanBody.data);
  assert.equal(scanBody.data.items[0].unitPriceCents, 549);
  assert.equal(scanBody.data.subtotalCents, 549);
});

test("a new session after reset starts with a separate empty basket", async (t) => {
  const baseUrl = await startApi(t);
  const previous = await startSession(baseUrl, "previous-session-key");
  const previousSessionId = previous.payload.data.id;
  const scanResponse = await fetch(`${baseUrl}/sessions/${previousSessionId}/scan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "previous-session-scan",
    },
    body: JSON.stringify({ barcode: "QS-BRD-031", source: "barcode" }),
  });
  const scanned = await scanResponse.json();
  const resetResponse = await fetch(`${baseUrl}/sessions/${previousSessionId}/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "previous-session-reset",
    },
    body: "{}",
  });
  const reset = await resetResponse.json();
  const next = await startSession(baseUrl, "next-session-key");

  assert.equal(scanResponse.status, 200);
  assert.equal(scanned.data.items.length, 1);
  assert.equal(resetResponse.status, 200);
  assert.equal(reset.data.state, "reset");
  assert.equal(next.response.status, 201);
  assert.notEqual(next.payload.data.id, previousSessionId);
  assert.equal(next.payload.data.state, "scanning");
  assert.deepEqual(next.payload.data.items, []);
  assert.equal(next.payload.data.couponCode, null);
  assert.equal(next.payload.data.paymentStatus, "not_started");
  assert.equal(next.payload.data.subtotalCents, 0);
  assert.equal(next.payload.data.discountCents, 0);
  assert.equal(next.payload.data.taxCents, 0);
  assert.equal(next.payload.data.totalCents, 0);
});

test("invalid barcodes return a request-correlated safe error", async (t) => {
  const baseUrl = await startApi(t);
  const { payload } = await startSession(baseUrl);
  const response = await fetch(`${baseUrl}/sessions/${payload.data.id}/scan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "unknown-item-key",
    },
    body: JSON.stringify({ barcode: "UNKNOWN", source: "barcode" }),
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "ITEM_NOT_FOUND");
  assert.equal(body.error.requestId, response.headers.get("x-request-id"));
  assert.equal("barcode" in body.error, false);
});

test("CORS allows configured kiosk origin and rejects other origins", async (t) => {
  const baseUrl = await startApi(t);
  const allowed = await fetch(`${baseUrl}/catalog`, {
    headers: { Origin: "http://127.0.0.1:5111" },
  });
  const denied = await fetch(`${baseUrl}/catalog`, {
    headers: { Origin: "https://untrusted.invalid" },
  });

  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:5111");
  assert.equal(denied.status, 403);
});

test("request body size is bounded before checkout state changes", async (t) => {
  const baseUrl = await startApi(t);
  const model = loadModel();
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "oversized-session-request",
    },
    body: JSON.stringify({ pad: "x".repeat(model.data.app.maximumBodyBytes + 1) }),
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
});

test("checkout without an item is rejected without advancing state", async (t) => {
  const baseUrl = await startApi(t);
  const { payload } = await startSession(baseUrl);
  const response = await fetch(`${baseUrl}/sessions/${payload.data.id}/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "empty-checkout-key",
    },
    body: "{}",
  });
  const body = await response.json();
  const session = await fetch(`${baseUrl}/sessions/${payload.data.id}`);

  assert.equal(response.status, 422);
  assert.equal(body.error.code, "EMPTY_BASKET");
  assert.equal((await session.json()).data.state, "scanning");
});

test("versioned session routes complete scan, quantity, coupon, payment, receipt, and reset", async (t) => {
  const baseUrl = await startApi(t);
  const started = await startSession(baseUrl, "route-flow-start");
  const sessionId = started.payload.data.id;
  const initialSession = await fetch(`${baseUrl}/sessions/${sessionId}`);
  assert.equal((await initialSession.json()).data.state, "scanning");

  const batch = await postJson(baseUrl, `/sessions/${sessionId}/scan-batch`, "route-flow-batch", {
    barcodes: ["QS-MLK-044", "QS-EGG-056"],
  });
  assert.equal(batch.status, 200);
  const quantity = await postJson(baseUrl, `/sessions/${sessionId}/quantity`, "route-flow-quantity", {
    productId: "dairy-milk",
    delta: 1,
  });
  assert.equal((await quantity.json()).data.items[0].quantity, 2);

  const coupon = await postJson(baseUrl, `/sessions/${sessionId}/coupon`, "route-flow-coupon", { code: "FRESH10" });
  assert.equal((await coupon.json()).data.couponCode, "FRESH10");
  const checkout = await postJson(baseUrl, `/sessions/${sessionId}/checkout`, "route-flow-checkout");
  assert.equal((await checkout.json()).data.state, "ready_to_pay");
  const tender = await postJson(baseUrl, `/sessions/${sessionId}/tenders`, "route-flow-tender", {
    method: "cash",
    outcome: "approve",
  });
  assert.equal((await tender.json()).data.session.state, "paid");

  const receipt = await postJson(baseUrl, `/sessions/${sessionId}/receipt`, "route-flow-receipt");
  const receiptBody = await receipt.json();
  assert.equal(receipt.status, 201);
  assert.equal(receiptBody.data.totalCents > 0, true);
  const receiptRead = await fetch(`${baseUrl}/sessions/${sessionId}/receipt`);
  assert.deepEqual((await receiptRead.json()).data, receiptBody.data);

  const reset = await postJson(baseUrl, `/sessions/${sessionId}/reset`, "route-flow-reset");
  assert.equal((await reset.json()).data.state, "reset");
});

test("weight-check and attendant-intervention routes enforce recovery transitions", async (t) => {
  const baseUrl = await startApi(t);
  const { payload } = await startSession(baseUrl, "weight-flow-start");
  const sessionId = payload.data.id;
  const scan = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "weight-flow-scan", {
    barcode: "QS-APL-014",
    source: "barcode",
  });
  assert.equal((await scan.json()).data.state, "weight_check_pending");

  const mismatch = await postJson(baseUrl, `/sessions/${sessionId}/weight-check`, "weight-flow-mismatch", {
    simulatedWeightGrams: 1500,
  });
  assert.equal((await mismatch.json()).data.state, "attention_required");
  const intervention = await postJson(baseUrl, `/sessions/${sessionId}/intervention`, "weight-flow-remove", {
    action: "remove_item",
  });
  assert.equal((await intervention.json()).data.items.length, 0);

  const secondScan = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "weight-flow-scan-again", {
    barcode: "QS-BAN-022",
  });
  assert.equal((await secondScan.json()).data.state, "weight_check_pending");
  const passed = await postJson(baseUrl, `/sessions/${sessionId}/weight-check`, "weight-flow-pass", {
    simulatedWeightGrams: 760,
  });
  assert.equal((await passed.json()).data.state, "scanning");
});

test("request parsing, preflight, trace propagation, and route misses return safe results", async (t) => {
  const baseUrl = await startApi(t);
  const preflight = await fetch(`${baseUrl}/catalog`, {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:5111" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");

  const traceId = "1".repeat(32);
  const traceParent = `00-${traceId}-${"2".repeat(16)}-01`;
  const traced = await fetch(`${baseUrl}/catalog`, { headers: { Traceparent: traceParent } });
  assert.equal(traced.headers.get("x-trace-id"), traceId);

  const malformedJson = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "invalid-json" },
    body: "{",
  });
  assert.equal(malformedJson.status, 400);
  assert.equal((await malformedJson.json()).error.code, "INVALID_JSON");

  const emptyBody = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "empty-body" },
  });
  assert.equal(emptyBody.status, 201);

  const invalidBody = await postJson(baseUrl, "/sessions", "invalid-body", { unexpected: true });
  assert.equal(invalidBody.status, 400);
  assert.equal((await invalidBody.json()).error.code, "INVALID_REQUEST");

  const missingKey = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "IDEMPOTENCY_KEY_REQUIRED");
  const invalidKey = await postJson(baseUrl, "/sessions", "x".repeat(129), {});
  assert.equal(invalidKey.status, 400);
  assert.equal((await invalidKey.json()).error.code, "IDEMPOTENCY_KEY_REQUIRED");

  const routeMiss = await fetch(`${baseUrl}/unknown`);
  assert.equal(routeMiss.status, 404);
  assert.equal((await routeMiss.json()).error.code, "NOT_FOUND");
  const methodMiss = await fetch(`${baseUrl}/sessions/00000000-0000-4000-8000-000000000001/scan`);
  assert.equal(methodMiss.status, 404);
});

test("unexpected domain exceptions return the model-backed safe server error", async (t) => {
  const model = loadModel();
  const baseUrl = await startApi(t, { model });
  const { payload } = await startSession(baseUrl, "unexpected-start");
  const sessionId = payload.data.id;
  const scan = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "unexpected-scan", {
    barcode: "QS-MLK-044",
    source: "barcode",
  });
  assert.equal(scan.status, 200);

  model.data.app.taxRateBasisPoints = "invalid";
  const checkout = await postJson(baseUrl, `/sessions/${sessionId}/checkout`, "unexpected-checkout", {});
  const error = await checkout.json();
  assert.equal(checkout.status, 500);
  assert.equal(error.error.code, "INTERNAL_ERROR");
  assert.equal(error.error.message, model.messages.errors.server);
  assert.equal(error.error.message.includes("Cannot convert"), false);
});

test("rate limiting rejects repeated requests and expires its window", async (t) => {
  const limitedBaseUrl = await startApi(t, { rateLimit: 1, rateWindowMs: 60_000 });
  assert.equal((await fetch(`${limitedBaseUrl}/health`)).status, 200);
  const limited = await fetch(`${limitedBaseUrl}/health`);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "RATE_LIMITED");

  const expiredWindowBaseUrl = await startApi(t, { rateLimit: 1, rateWindowMs: 0 });
  assert.equal((await fetch(`${expiredWindowBaseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${expiredWindowBaseUrl}/health`)).status, 200);
});

test("CLI startup and graceful shutdown use an ephemeral port and in-memory SQLite", async (t) => {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: "0",
      SCANGO_DB_PATH: ":memory:",
      SCANGO_E2E_FRONTEND_ORIGIN: "http://127.0.0.1:5113",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const started = new Promise((resolveStarted, rejectStarted) => {
    const timeout = setTimeout(() => rejectStarted(new Error("The isolated API did not start.")), 5_000);
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes('"eventName":"service.started"')) return;
      clearTimeout(timeout);
      resolveStarted();
    });
    child.once("error", rejectStarted);
    child.once("exit", (code) => {
      if (code !== 0) rejectStarted(new Error(`The isolated API exited before startup: ${output}`));
    });
  });

  await started;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exit;
  assert.equal(code, 0);
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createClock,
  createTempDatabase,
  getJson,
  openInspector,
  payAndIssueReceipt,
  postJson,
  probeAs,
  startApi,
  startSession,
} from "../test-support/api-client.mjs";
import { checkoutSchema } from "./checkout.schema.mjs";
import { digestToken } from "./identity.mjs";
import { loadModel } from "./server.mjs";

test("a second kiosk at the same location cannot read or resume the first kiosk's basket or receipt", async (t) => {
  const baseUrl = await startApi(t);
  const first = await startSession(baseUrl, "first-kiosk-start", "kiosk-01");
  const sessionId = first.payload.data.id;
  const firstToken = first.payload.data.accessToken;
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "first-kiosk-scan", {
    barcode: "QS-BRD-031",
    source: "barcode",
  });
  const issued = await payAndIssueReceipt(baseUrl, sessionId, "first-kiosk");
  assert.equal(issued.status, 201);
  const second = await startSession(baseUrl, "second-kiosk-start", "kiosk-02");
  const secondToken = second.payload.data.accessToken;
  const unknownId = "00000000-0000-4000-8000-000000000009";

  const probes = [
    [`/sessions/${sessionId}`, secondToken, "kiosk-02"],
    [`/sessions/${sessionId}/receipt`, secondToken, "kiosk-02"],
    [`/sessions/${sessionId}`, firstToken, "kiosk-02"],
    [`/sessions/${sessionId}`, "not-the-token", "kiosk-01"],
    [`/sessions/${sessionId}`, undefined, "kiosk-01"],
    [`/sessions/${sessionId}`, firstToken, undefined],
  ];
  const missing = await probeAs(baseUrl, `/sessions/${unknownId}`, secondToken, "kiosk-02");
  const missingBody = await missing.json();
  for (const [path, token, kioskId] of probes) {
    const denied = await probeAs(baseUrl, path, token, kioskId);
    const body = await denied.json();
    assert.equal(denied.status, 404, `${path} as ${kioskId}`);
    assert.equal(body.error.code, "SESSION_NOT_FOUND");
    assert.equal(body.error.message, missingBody.error.message);
    assert.equal(JSON.stringify(body).includes("QS-BRD-031"), false);
  }
  const malformed = await fetch(`${baseUrl}/sessions/${sessionId}`, {
    headers: { Authorization: `Token ${firstToken}`, "X-Kiosk-Id": "kiosk-01" },
  });
  assert.equal(malformed.status, 404);

  const own = await probeAs(baseUrl, `/sessions/${sessionId}`, firstToken, "kiosk-01");
  assert.equal(own.status, 200);
  assert.equal((await own.json()).data.items.length, 1);
  const ownReceipt = await probeAs(baseUrl, `/sessions/${sessionId}/receipt`, firstToken, "kiosk-01");
  assert.equal(ownReceipt.status, 200);
});

test("starting a session requires a registered kiosk", async (t) => {
  const baseUrl = await startApi(t);
  for (const kioskId of ["kiosk-99", "", undefined]) {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `kiosk-check-${kioskId ?? "none"}`,
        ...(kioskId === undefined ? {} : { "X-Kiosk-Id": kioskId }),
      },
      body: "{}",
    });
    const body = await response.json();
    assert.equal(response.status, 403, String(kioskId));
    assert.equal(body.error.code, "KIOSK_NOT_REGISTERED");
  }
});

test("a started session stores only a token digest and binds business, location and kiosk", async (t) => {
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath });
  const { payload } = await startSession(baseUrl, "digest-start", "kiosk-03");
  const token = payload.data.accessToken;
  const inspector = openInspector(t, databasePath);
  const row = inspector
    .prepare("SELECT business_id, location_id, kiosk_id, token_digest, version FROM checkout_sessions WHERE id = ?")
    .get(payload.data.id);
  const records = inspector.prepare("SELECT response_json FROM idempotency_records").all();

  assert.equal(token.length, 43);
  assert.equal(row.token_digest, digestToken(token));
  assert.equal(row.token_digest.includes(token), false);
  assert.deepEqual([row.business_id, row.location_id, row.kiosk_id], ["quickstop", "store-02", "kiosk-03"]);
  assert.equal(typeof payload.data.version, "number");
  assert.equal(
    records.some((record) => record.response_json.includes(token)),
    false,
  );
});

test("start replay with the same key and kiosk rotates the token; another kiosk is a conflict", async (t) => {
  const baseUrl = await startApi(t);
  const first = await startSession(baseUrl, "replay-start", "kiosk-01");
  const firstToken = first.payload.data.accessToken;
  const replay = await startSession(baseUrl, "replay-start", "kiosk-01");
  const stale = await probeAs(baseUrl, `/sessions/${first.payload.data.id}`, firstToken, "kiosk-01");
  const fresh = await probeAs(
    baseUrl,
    `/sessions/${first.payload.data.id}`,
    replay.payload.data.accessToken,
    "kiosk-01",
  );
  const conflict = await startSession(baseUrl, "replay-start", "kiosk-02");

  assert.equal(replay.payload.data.id, first.payload.data.id);
  assert.notEqual(replay.payload.data.accessToken, firstToken);
  assert.equal(stale.status, 404);
  assert.equal(fresh.status, 200);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(conflict.payload.data, undefined);
});

test("a start replay after the session was reset is refused without issuing a token", async (t) => {
  const baseUrl = await startApi(t);
  const first = await startSession(baseUrl, "reset-replay-start", "kiosk-01");
  await postJson(baseUrl, `/sessions/${first.payload.data.id}/reset`, "reset-replay-reset");
  const replay = await startSession(baseUrl, "reset-replay-start", "kiosk-01");

  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.error.code, "INVALID_STATE");
  assert.equal(replay.payload.data, undefined);
});

test("idle expiry returns 410 on every route, keeps the rows and writes exactly one audit entry", async (t) => {
  const clock = createClock();
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath, now: clock.now });
  const idle = loadModel().data.app.sessionIdleSeconds;
  const { payload } = await startSession(baseUrl, "expiry-start");
  const sessionId = payload.data.id;
  assert.equal(payload.data.expiresInSeconds, idle);
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "expiry-scan", { barcode: "QS-BRD-031", source: "barcode" });
  await payAndIssueReceipt(baseUrl, sessionId, "expiry");

  clock.advance(idle + 1);
  const attempts = [
    await getJson(baseUrl, `/sessions/${sessionId}`),
    await getJson(baseUrl, `/sessions/${sessionId}/receipt`),
    await postJson(baseUrl, `/sessions/${sessionId}/scan`, "expiry-late-scan", {
      barcode: "QS-MLK-044",
      source: "barcode",
    }),
    await postJson(baseUrl, `/sessions/${sessionId}/extend`, "expiry-late-extend"),
  ];
  for (const response of attempts) {
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error.code, "SESSION_EXPIRED");
  }
  const inspector = openInspector(t, databasePath);
  const session = inspector.prepare("SELECT state, closed_reason FROM checkout_sessions WHERE id = ?").get(sessionId);
  const counts = {
    items: inspector.prepare("SELECT COUNT(*) AS n FROM session_items WHERE session_id = ?").get(sessionId).n,
    receipts: inspector.prepare("SELECT COUNT(*) AS n FROM receipts WHERE session_id = ?").get(sessionId).n,
    audits: inspector
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target_session_id = ? AND action = 'session.expired'")
      .get(sessionId).n,
  };

  assert.deepEqual({ ...session }, { state: "expired", closed_reason: "idle_timeout" });
  assert.deepEqual(counts, { items: 1, receipts: 1, audits: 1 });
});

test("extend slides expiry, a read does not, and an authorised write does", async (t) => {
  const clock = createClock();
  const baseUrl = await startApi(t, { now: clock.now });
  const idle = loadModel().data.app.sessionIdleSeconds;
  const { payload } = await startSession(baseUrl, "slide-start");
  const sessionId = payload.data.id;

  clock.advance(100);
  const read = await (await getJson(baseUrl, `/sessions/${sessionId}`)).json();
  assert.equal(read.data.expiresInSeconds, idle - 100);
  const extended = await (await postJson(baseUrl, `/sessions/${sessionId}/extend`, "slide-extend")).json();
  assert.equal(extended.data.expiresInSeconds, idle);
  assert.equal(extended.data.version, read.data.version);

  clock.advance(100);
  const scanned = await (
    await postJson(baseUrl, `/sessions/${sessionId}/scan`, "slide-scan", { barcode: "QS-BRD-031", source: "barcode" })
  ).json();
  assert.equal(scanned.data.expiresInSeconds, idle);
  assert.equal(scanned.data.version > extended.data.version, true);

  clock.advance(idle - 1);
  assert.equal((await getJson(baseUrl, `/sessions/${sessionId}`)).status, 200);
  clock.advance(2);
  assert.equal((await getJson(baseUrl, `/sessions/${sessionId}`)).status, 410);
});

test("reset clears shopper access so the receipt cannot be reopened", async (t) => {
  const baseUrl = await startApi(t);
  const { payload } = await startSession(baseUrl, "reset-access-start");
  const sessionId = payload.data.id;
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "reset-access-scan", {
    barcode: "QS-BRD-031",
    source: "barcode",
  });
  await payAndIssueReceipt(baseUrl, sessionId, "reset-access");
  assert.equal((await getJson(baseUrl, `/sessions/${sessionId}/receipt`)).status, 200);

  const reset = await postJson(baseUrl, `/sessions/${sessionId}/reset`, "reset-access-reset");
  assert.equal(reset.status, 200);
  const receipt = await getJson(baseUrl, `/sessions/${sessionId}/receipt`);
  const session = await getJson(baseUrl, `/sessions/${sessionId}`);
  assert.equal(receipt.status, 404);
  assert.equal(session.status, 404);
  assert.equal((await receipt.json()).error.code, "SESSION_NOT_FOUND");
});

test("sessions created before the migration are not resumable", async (t) => {
  const databasePath = createTempDatabase();
  const legacyId = "11111111-1111-4111-8111-111111111111";
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(checkoutSchema);
  legacy
    .prepare("INSERT INTO checkout_sessions (id, state, created_at, updated_at) VALUES (?, 'scanning', ?, ?)")
    .run(legacyId, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
  legacy.close();
  const baseUrl = await startApi(t, { databasePath });

  for (const token of ["anything", undefined]) {
    const response = await probeAs(baseUrl, `/sessions/${legacyId}`, token, "kiosk-01");
    assert.equal(response.status, 404);
  }
});

test("CORS preflight allows the kiosk, bearer and request-id headers", async (t) => {
  const baseUrl = await startApi(t);
  const preflight = await fetch(`${baseUrl}/sessions`, {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:5111" },
  });
  const allowed = preflight.headers.get("access-control-allow-headers");

  for (const header of ["Authorization", "X-Kiosk-Id", "X-Request-ID", "Idempotency-Key"]) {
    assert.match(allowed, new RegExp(header, "i"));
  }
});

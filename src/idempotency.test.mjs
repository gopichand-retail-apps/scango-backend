import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createTempDatabase,
  getJson,
  openInspector,
  postJson,
  startApi,
  startSession,
} from "../test-support/api-client.mjs";
import { fingerprintOf } from "./identity.mjs";

const bread = { barcode: "QS-BRD-031", source: "barcode" };
const milk = { barcode: "QS-MLK-044", source: "barcode" };

async function basket(baseUrl, sessionId) {
  return (await (await getJson(baseUrl, `/sessions/${sessionId}`)).json()).data.items.map((item) => [
    item.productId,
    item.quantity,
  ]);
}

test("fingerprints are canonical: key order does not matter, values do", () => {
  assert.equal(fingerprintOf({ a: 1, b: [2, { c: 3, d: 4 }] }), fingerprintOf({ b: [2, { d: 4, c: 3 }], a: 1 }));
  assert.notEqual(fingerprintOf({ barcode: "A" }), fingerprintOf({ barcode: "B" }));
  assert.notEqual(fingerprintOf({}), fingerprintOf({ barcode: null }));
  assert.match(fingerprintOf({}), /^[0-9a-f]{64}$/);
});

test("a lost reply retried with the same key adds exactly one unit", async (t) => {
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath });
  const { payload } = await startSession(baseUrl, "lost-reply-start");
  const sessionId = payload.data.id;

  const first = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "lost-reply-scan", bread);
  const retry = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "lost-reply-scan", bread);
  const scans = openInspector(t, databasePath).prepare("SELECT COUNT(*) AS n FROM scan_events WHERE session_id = ?");

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).data.items, (await first.json()).data.items);
  assert.deepEqual(await basket(baseUrl, sessionId), [["bread-country", 1]]);
  assert.equal(scans.get(sessionId).n, 1);
});

test("a reused key with a different payload is refused and changes nothing", async (t) => {
  const baseUrl = await startApi(t);
  const { payload } = await startSession(baseUrl, "changed-payload-start");
  const sessionId = payload.data.id;
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "changed-payload-scan", bread);

  const changed = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "changed-payload-scan", milk);
  const body = await changed.json();

  assert.equal(changed.status, 409);
  assert.equal(body.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.deepEqual(await basket(baseUrl, sessionId), [["bread-country", 1]]);
});

test("a deliberate second scan with a new key adds a second unit", async (t) => {
  const baseUrl = await startApi(t);
  const { payload } = await startSession(baseUrl, "second-scan-start");
  const sessionId = payload.data.id;
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "second-scan-one", bread);
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "second-scan-two", bread);

  assert.deepEqual(await basket(baseUrl, sessionId), [["bread-country", 2]]);
});

test("replay rows stored before fingerprints existed still replay", async (t) => {
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath });
  const { payload } = await startSession(baseUrl, "legacy-replay-start");
  const sessionId = payload.data.id;
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "legacy-replay-scan", bread);
  const writer = new DatabaseSync(databasePath);
  writer.prepare("UPDATE idempotency_records SET request_fingerprint = NULL").run();
  writer.close();

  const replay = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "legacy-replay-scan", milk);
  assert.equal(replay.status, 200);
  assert.deepEqual(await basket(baseUrl, sessionId), [["bread-country", 1]]);
});

test("the same key on two different sessions never returns a server error", async (t) => {
  const baseUrl = await startApi(t);
  const first = (await startSession(baseUrl, "shared-key-start-1")).payload.data.id;
  const second = (await startSession(baseUrl, "shared-key-start-2", "kiosk-02")).payload.data.id;

  const one = await postJson(baseUrl, `/sessions/${first}/scan`, "shared-key", bread);
  const two = await postJson(baseUrl, `/sessions/${second}/scan`, "shared-key", bread);
  await postJson(baseUrl, `/sessions/${first}/checkout`, "shared-checkout");
  await postJson(baseUrl, `/sessions/${second}/checkout`, "shared-checkout");
  const tenderOne = await postJson(baseUrl, `/sessions/${first}/tenders`, "shared-tender", {
    method: "cash",
    outcome: "approve",
  });
  const tenderTwo = await postJson(baseUrl, `/sessions/${second}/tenders`, "shared-tender", {
    method: "cash",
    outcome: "approve",
  });

  assert.deepEqual([one.status, two.status, tenderOne.status, tenderTwo.status], [200, 200, 200, 200]);
  assert.deepEqual(await basket(baseUrl, second), [["bread-country", 1]]);
});

test("a tender retried with its key records one tender; a changed outcome under that key is refused", async (t) => {
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath });
  const { payload } = await startSession(baseUrl, "tender-replay-start");
  const sessionId = payload.data.id;
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, "tender-replay-scan", bread);
  await postJson(baseUrl, `/sessions/${sessionId}/checkout`, "tender-replay-checkout");

  const tender = { method: "simulated_card", outcome: "approve" };
  const first = await postJson(baseUrl, `/sessions/${sessionId}/tenders`, "tender-replay-pay", tender);
  const retry = await postJson(baseUrl, `/sessions/${sessionId}/tenders`, "tender-replay-pay", tender);
  const changed = await postJson(baseUrl, `/sessions/${sessionId}/tenders`, "tender-replay-pay", {
    ...tender,
    outcome: "decline",
  });
  const tenders = openInspector(t, databasePath).prepare("SELECT COUNT(*) AS n FROM tenders WHERE session_id = ?");

  assert.deepEqual([first.status, retry.status, changed.status], [200, 200, 409]);
  assert.equal(tenders.get(sessionId).n, 1);
  assert.equal((await getJson(baseUrl, `/sessions/${sessionId}`).then((r) => r.json())).data.paymentStatus, "approved");
});

test("a refused write stores no replay, so the same key can carry the corrected request", async (t) => {
  const baseUrl = await startApi(t);
  const { payload } = await startSession(baseUrl, "refused-start");
  const sessionId = payload.data.id;

  const unknown = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "refused-scan", {
    barcode: "UNKNOWN",
    source: "barcode",
  });
  const corrected = await postJson(baseUrl, `/sessions/${sessionId}/scan`, "refused-scan", bread);

  assert.equal(unknown.status, 404);
  assert.equal(corrected.status, 200);
  assert.deepEqual(await basket(baseUrl, sessionId), [["bread-country", 1]]);
});

test("a client X-Request-ID is echoed and logged; a malformed one is replaced", async (t) => {
  const baseUrl = await startApi(t);
  const write = t.mock.method(process.stdout, "write", () => true);
  const echoed = await fetch(`${baseUrl}/catalog`, { headers: { "X-Request-ID": "kiosk-attempt-0001" } });
  const replaced = await fetch(`${baseUrl}/catalog`, { headers: { "X-Request-ID": "has spaces and !" } });
  const logged = write.mock.calls.map((call) => String(call.arguments[0])).join("");
  write.mock.restore();

  assert.equal(echoed.headers.get("x-request-id"), "kiosk-attempt-0001");
  assert.match(replaced.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.match(logged, /"requestId":"kiosk-attempt-0001"/);
});

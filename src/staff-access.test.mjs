import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createClock,
  createTempDatabase,
  driveToAttention,
  getJson,
  openInspector,
  postJson,
  probeAs,
  signInStaff,
  staffRequest,
  startApi,
  startSession,
} from "../test-support/api-client.mjs";
import { loadIdentityFixture } from "./identity.mjs";

const pins = Object.fromEntries(loadIdentityFixture().staff.map((member) => [member.code, member.pin]));

async function signedIn(baseUrl, code) {
  const { payload } = await signInStaff(baseUrl, code, pins[code]);
  return payload.data.accessToken;
}

function resolveBody(target, overrides = {}) {
  return {
    action: "approve_weight",
    reasonCode: "weight_verified",
    productId: target.productId,
    expectedVersion: target.version,
    ...overrides,
  };
}

async function resolve(baseUrl, token, target, key, overrides) {
  return staffRequest(baseUrl, `/sessions/${target.sessionId}/intervention`, token, {
    method: "POST",
    key,
    body: resolveBody(target, overrides),
  });
}

test("a shopper token or no token cannot resolve an exception and the state is unchanged", async (t) => {
  const baseUrl = await startApi(t);
  const target = await driveToAttention(baseUrl, "self-approve");
  const shopper = await postJson(
    baseUrl,
    `/sessions/${target.sessionId}/intervention`,
    "self-approve-try",
    resolveBody(target),
  );
  const anonymous = await resolve(baseUrl, undefined, target, "anonymous-try");
  const session = await (await getJson(baseUrl, `/sessions/${target.sessionId}`)).json();

  for (const response of [shopper, anonymous]) {
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "STAFF_REQUIRED");
  }
  assert.equal(session.data.state, "attention_required");
  assert.equal(session.data.version, target.version);
});

test("an attendant at another location sees nothing and cannot resolve", async (t) => {
  const baseUrl = await startApi(t);
  const target = await driveToAttention(baseUrl, "other-location");
  const elsewhere = await signedIn(baseUrl, "att-03");
  const listed = await (await staffRequest(baseUrl, "/staff/exceptions", elsewhere)).json();
  const response = await resolve(baseUrl, elsewhere, target, "other-location-resolve");
  const session = await (await getJson(baseUrl, `/sessions/${target.sessionId}`)).json();

  assert.deepEqual(listed.data.exceptions, []);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "SESSION_NOT_FOUND");
  assert.equal(session.data.state, "attention_required");
});

test("a staff token opens no shopper route", async (t) => {
  const baseUrl = await startApi(t);
  const target = await driveToAttention(baseUrl, "staff-on-shopper");
  const token = await signedIn(baseUrl, "att-01");

  const response = await probeAs(baseUrl, `/sessions/${target.sessionId}`, token, "kiosk-01");
  assert.equal(response.status, 404);
});

test("sign-in failures look identical, are throttled per code, and never record the PIN", async (t) => {
  const clock = createClock();
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath, now: clock.now });
  const wrongPin = await signInStaff(baseUrl, "att-01", "000000");
  const unknownCode = await signInStaff(baseUrl, "att-99", pins["att-01"]);

  assert.equal(wrongPin.response.status, 401);
  assert.deepEqual({ ...wrongPin.payload.error, requestId: null }, { ...unknownCode.payload.error, requestId: null });
  for (let attempt = 0; attempt < 4; attempt += 1) await signInStaff(baseUrl, "att-01", "000000");
  const throttled = await signInStaff(baseUrl, "att-01", pins["att-01"]);
  assert.equal(throttled.response.status, 429);
  assert.equal(throttled.payload.error.code, "STAFF_THROTTLED");

  clock.advance(61);
  const allowed = await signInStaff(baseUrl, "att-01", pins["att-01"]);
  assert.equal(allowed.response.status, 201);
  assert.deepEqual(allowed.payload.data.staff, { code: "att-01", name: "Attendant Alder", locationId: "store-01" });

  const audit = openInspector(t, databasePath).prepare("SELECT * FROM audit_log WHERE action = 'staff.sign_in'").all();
  assert.equal(audit.filter((row) => row.result === "success").length, 1);
  assert.equal(audit.filter((row) => row.result === "denied").length >= 5, true);
  assert.equal(JSON.stringify(audit).includes(pins["att-01"]), false);
});

test("an attendant resolves with reason, line and version, and the audit records all four", async (t) => {
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath });
  const target = await driveToAttention(baseUrl, "resolve");
  const token = await signedIn(baseUrl, "att-01");
  const listed = await (await staffRequest(baseUrl, "/staff/exceptions", token)).json();

  assert.equal(listed.data.exceptions.length, 1);
  assert.deepEqual(Object.keys(listed.data.exceptions[0]).sort(), ["line", "sessionId", "since", "version"]);
  assert.equal(listed.data.exceptions[0].line.productId, target.productId);

  const response = await resolve(baseUrl, token, target, "resolve-approve");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data, { sessionId: target.sessionId, state: "scanning", version: target.version + 1 });

  const inspector = openInspector(t, databasePath);
  const intervention = inspector
    .prepare("SELECT staff_code, reason_code, product_id, session_version FROM interventions WHERE session_id = ?")
    .get(target.sessionId);
  assert.deepEqual(
    { ...intervention },
    {
      staff_code: "att-01",
      reason_code: "weight_verified",
      product_id: target.productId,
      session_version: target.version,
    },
  );
  const shopperView = await (await getJson(baseUrl, `/sessions/${target.sessionId}`)).json();
  assert.equal(shopperView.data.state, "scanning");
});

test("a stale version or the wrong line is refused with the current state", async (t) => {
  const baseUrl = await startApi(t);
  const target = await driveToAttention(baseUrl, "stale");
  const token = await signedIn(baseUrl, "att-01");

  const stale = await resolve(baseUrl, token, target, "stale-version", { expectedVersion: target.version - 1 });
  const staleBody = await stale.json();
  assert.equal(stale.status, 409);
  assert.equal(staleBody.error.code, "SESSION_VERSION_CONFLICT");
  assert.deepEqual(staleBody.error.current, {
    sessionId: target.sessionId,
    state: "attention_required",
    version: target.version,
  });

  const wrongLine = await resolve(baseUrl, token, target, "wrong-line", { productId: "dairy-milk" });
  assert.equal(wrongLine.status, 409);
  assert.equal((await wrongLine.json()).error.code, "INTERVENTION_LINE_MISMATCH");
});

test("two attendants approving at once leave one result and one audit entry", async (t) => {
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath });
  const target = await driveToAttention(baseUrl, "race");
  const [first, second] = await Promise.all([signedIn(baseUrl, "att-01"), signedIn(baseUrl, "att-02")]);

  const responses = await Promise.all([
    resolve(baseUrl, first, target, "race-first"),
    resolve(baseUrl, second, target, "race-second", { action: "remove_item", reasonCode: "item_mismatch" }),
  ]);
  const statuses = responses.map((response) => response.status).sort();
  const inspector = openInspector(t, databasePath);
  const interventions = inspector.prepare("SELECT COUNT(*) AS n FROM interventions WHERE session_id = ?");
  const audits = inspector.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE target_session_id = ? AND action = 'session.intervention' AND result = 'success'",
  );

  assert.deepEqual(statuses, [200, 409]);
  assert.equal(interventions.get(target.sessionId).n, 1);
  assert.equal(audits.get(target.sessionId).n, 1);
});

test("the storage refuses a second intervention for the same session version from another connection", async (t) => {
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath });
  const target = await driveToAttention(baseUrl, "unique");
  const token = await signedIn(baseUrl, "att-01");
  await resolve(baseUrl, token, target, "unique-first");

  const writer = new DatabaseSync(databasePath);
  t.after(() => writer.close());
  assert.throws(
    () =>
      writer
        .prepare(
          `INSERT INTO interventions (id, session_id, product_id, action, occurred_at, staff_code, reason_code, session_version)
           VALUES ('second', ?, ?, 'remove_item', '2026-11-24T12:00:00.000Z', 'att-02', 'item_mismatch', ?)`,
        )
        .run(target.sessionId, target.productId, target.version),
    /UNIQUE/,
  );
});

test("staff sessions end at sign-out and after 15 idle minutes", async (t) => {
  const clock = createClock();
  const baseUrl = await startApi(t, { now: clock.now });
  const first = await signedIn(baseUrl, "att-01");
  const signOut = await staffRequest(baseUrl, "/staff/sign-out", first, { method: "POST", body: {} });
  assert.equal(signOut.status, 200);
  assert.equal((await staffRequest(baseUrl, "/staff/exceptions", first)).status, 403);

  const second = await signedIn(baseUrl, "att-01");
  clock.advance(14 * 60);
  assert.equal((await staffRequest(baseUrl, "/staff/exceptions", second)).status, 200);
  clock.advance(14 * 60);
  assert.equal((await staffRequest(baseUrl, "/staff/exceptions", second)).status, 200);
  clock.advance(15 * 60 + 1);
  assert.equal((await staffRequest(baseUrl, "/staff/exceptions", second)).status, 403);
});

test("a stale console cannot act on a session past its idle expiry, and the session stays expired", async (t) => {
  const clock = createClock();
  const databasePath = createTempDatabase();
  const baseUrl = await startApi(t, { databasePath, now: clock.now });
  const target = await driveToAttention(baseUrl, "stale-console");
  const token = await signedIn(baseUrl, "att-01");

  clock.advance(181);
  const response = await resolve(baseUrl, token, target, "stale-console-approve");
  const inspector = openInspector(t, databasePath);
  const session = inspector
    .prepare("SELECT state, closed_reason FROM checkout_sessions WHERE id = ?")
    .get(target.sessionId);
  const decisions = inspector
    .prepare("SELECT COUNT(*) AS n FROM interventions WHERE session_id = ?")
    .get(target.sessionId);

  assert.equal(response.status, 410);
  assert.equal((await response.json()).error.code, "SESSION_EXPIRED");
  assert.deepEqual({ ...session }, { state: "expired", closed_reason: "idle_timeout" });
  assert.equal(decisions.n, 0);
});

test("expired shopper sessions drop off the exception list", async (t) => {
  const clock = createClock();
  const baseUrl = await startApi(t, { now: clock.now });
  await driveToAttention(baseUrl, "expired-exception");
  await startSession(baseUrl, "unrelated-start", "kiosk-02");
  const token = await signedIn(baseUrl, "att-01");
  assert.equal((await (await staffRequest(baseUrl, "/staff/exceptions", token)).json()).data.exceptions.length, 1);

  clock.advance(181);
  const refreshed = await signedIn(baseUrl, "att-02");
  assert.deepEqual((await (await staffRequest(baseUrl, "/staff/exceptions", refreshed)).json()).data.exceptions, []);
});

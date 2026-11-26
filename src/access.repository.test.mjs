import assert from "node:assert/strict";
import test from "node:test";
import { createTempDatabase, openInspector } from "../test-support/api-client.mjs";
import { createCheckoutRepository } from "./checkout.repository.mjs";
import { createCheckoutService } from "./checkout.service.mjs";
import { loadModel } from "./server.mjs";

function createKioskSession(t, startIso = "2026-11-24T12:00:00.000Z") {
  const model = loadModel();
  const databasePath = createTempDatabase();
  const repository = createCheckoutRepository({ databasePath, model });
  t.after(() => repository.close());
  const service = createCheckoutService({ repository, model, now: () => new Date(startIso) });
  const session = service.startSession("repository-start", "kiosk-01");
  const inspector = openInspector(t, databasePath);
  const auditCount = () =>
    inspector
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target_session_id = ? AND action = 'session.expired'")
      .get(session.id).n;
  return { model, repository, session, auditCount };
}

test("expiring the same session twice changes it once and writes one audit row", (t) => {
  const { repository, session, auditCount } = createKioskSession(t);
  const now = "2026-11-24T12:10:00.000Z";

  const first = repository.access.expireSession({ sessionId: session.id, now, requestId: "first" });
  const second = repository.access.expireSession({ sessionId: session.id, now, requestId: "second" });

  assert.deepEqual([first, second], [true, false]);
  assert.equal(repository.getSessionAccess(session.id).state, "expired");
  assert.equal(auditCount(), 1);
});

test("the overdue sweep expires only open sessions past their deadline", (t) => {
  const { model, repository, auditCount } = createKioskSession(t);
  const idle = model.data.app.sessionIdleSeconds;
  const justBefore = new Date(Date.parse("2026-11-24T12:00:00.000Z") + (idle - 1) * 1000).toISOString();
  const after = new Date(Date.parse("2026-11-24T12:00:00.000Z") + idle * 1000).toISOString();

  assert.equal(repository.access.expireOverdue({ now: justBefore, requestId: null }), 0);
  assert.equal(repository.access.expireOverdue({ now: after, requestId: null }), 1);
  assert.equal(repository.access.expireOverdue({ now: after, requestId: null }), 0);
  assert.equal(auditCount(), 1);
});

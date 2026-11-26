import { randomUUID } from "node:crypto";
import { transaction } from "./sqlite-transaction.mjs";

const openStates =
  "('scanning', 'weight_check_pending', 'attention_required', 'ready_to_pay', 'paid', 'receipt_issued')";

export function createAccessRepository(database) {
  function recordAudit(entry, extra = {}) {
    const { at, actorType, actorId = null, action, sessionId = null, locationId = null, result } = entry;
    database
      .prepare(
        `
      INSERT INTO audit_log
        (id, at, actor_type, actor_id, action, target_session_id, location_id, result, reason_code, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        randomUUID(),
        at,
        actorType,
        actorId,
        action,
        sessionId,
        locationId,
        result,
        extra.reasonCode ?? null,
        extra.requestId ?? null,
      );
  }

  // Marks one open session expired; the audit row is written only by the call that changed it.
  function expireSessionRow({ sessionId, now, requestId }) {
    const changed = database
      .prepare(
        `UPDATE checkout_sessions
         SET state = 'expired', closed_reason = 'idle_timeout', updated_at = ?
         WHERE id = ? AND state IN ${openStates}`,
      )
      .run(now, sessionId).changes;
    if (changed === 0) return false;
    const { locationId, kioskId } = database
      .prepare("SELECT location_id AS locationId, kiosk_id AS kioskId FROM checkout_sessions WHERE id = ?")
      .get(sessionId);
    recordAudit(
      {
        at: now,
        actorType: "system",
        actorId: kioskId,
        action: "session.expired",
        sessionId,
        locationId,
        result: "success",
      },
      { reasonCode: "idle_timeout", requestId },
    );
    return true;
  }

  return {
    seedIdentity(identity) {
      transaction(database, () => {
        const addKiosk = database.prepare(
          "INSERT OR IGNORE INTO kiosks (id, business_id, location_id) VALUES (?, ?, ?)",
        );
        for (const kiosk of identity.kiosks) addKiosk.run(kiosk.id, identity.business, kiosk.locationId);
      });
    },
    getKiosk(kioskId) {
      const row = database
        .prepare("SELECT id, business_id AS businessId, location_id AS locationId FROM kiosks WHERE id = ?")
        .get(kioskId);
      return row ? { ...row } : null;
    },
    setSessionTokenDigest(sessionId, digest) {
      database.prepare("UPDATE checkout_sessions SET token_digest = ? WHERE id = ?").run(digest, sessionId);
    },
    recordAudit,
    expireSession(options) {
      return transaction(database, () => expireSessionRow(options));
    },
    expireOverdue({ now, requestId }) {
      return transaction(database, () => {
        const overdue = database
          .prepare(
            `SELECT id FROM checkout_sessions
             WHERE expires_at IS NOT NULL AND expires_at <= ? AND state IN ${openStates}`,
          )
          .all(now);
        return overdue.filter((row) => expireSessionRow({ sessionId: row.id, now, requestId })).length;
      });
    },
  };
}

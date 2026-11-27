import { randomUUID } from "node:crypto";
import { hashPin } from "./identity.mjs";
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

  // PIN hashes are created only for attendants not already stored, so a restart keeps existing hashes.
  function seedStaff(staff) {
    const exists = database.prepare("SELECT 1 FROM staff_profiles WHERE code = ?");
    const addStaff = database.prepare(
      "INSERT INTO staff_profiles (code, name, location_id, pin_hash) VALUES (?, ?, ?, ?)",
    );
    for (const member of staff) {
      if (!exists.get(member.code)) addStaff.run(member.code, member.name, member.locationId, hashPin(member.pin));
    }
  }

  return {
    seedIdentity(identity) {
      transaction(database, () => {
        const addKiosk = database.prepare(
          "INSERT OR IGNORE INTO kiosks (id, business_id, location_id) VALUES (?, ?, ?)",
        );
        for (const kiosk of identity.kiosks) addKiosk.run(kiosk.id, identity.business, kiosk.locationId);
        seedStaff(identity.staff);
      });
    },
    getStaff(code) {
      const row = database
        .prepare("SELECT code, name, location_id AS locationId, pin_hash AS pinHash FROM staff_profiles WHERE code = ?")
        .get(code);
      return row ? { ...row } : null;
    },
    createStaffSession({ id, staffCode, locationId, tokenDigest, expiresAt, now }) {
      database
        .prepare(
          `INSERT INTO staff_sessions (id, staff_code, location_id, token_digest, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, staffCode, locationId, tokenDigest, expiresAt, now);
    },
    getStaffSessionByDigest(tokenDigest) {
      const row = database
        .prepare(
          `SELECT id, staff_code AS staffCode, location_id AS locationId, expires_at AS expiresAt
           FROM staff_sessions WHERE token_digest = ?`,
        )
        .get(tokenDigest);
      return row ? { ...row } : null;
    },
    touchStaffSession(id, expiresAt) {
      database.prepare("UPDATE staff_sessions SET expires_at = ? WHERE id = ?").run(expiresAt, id);
    },
    deleteStaffSession(id) {
      database.prepare("DELETE FROM staff_sessions WHERE id = ?").run(id);
    },
    // Location-scoped and bounded; only the affected line and version, never totals or receipts.
    listExceptions({ locationId, now }) {
      return database
        .prepare(
          `SELECT s.id AS sessionId, s.version, s.updated_at AS since,
             i.product_id AS productId, p.name, i.expected_weight_grams AS expectedWeightGrams
           FROM checkout_sessions s
           JOIN session_items i ON i.session_id = s.id AND i.weight_status = 'attention'
           JOIN products p ON p.id = i.product_id
           WHERE s.state = 'attention_required' AND s.location_id = ?
             AND (s.expires_at IS NULL OR s.expires_at > ?)
           ORDER BY s.updated_at, s.id
           LIMIT 50`,
        )
        .all(locationId, now)
        .map(({ sessionId, version, since, productId, name, expectedWeightGrams }) => ({
          sessionId,
          version,
          since,
          line: { productId, name, expectedWeightGrams },
        }));
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

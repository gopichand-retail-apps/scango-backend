import { randomUUID } from "node:crypto";
import { CheckoutError } from "./errors.mjs";
import { digestToken, digestsEqual, hashPin, newAccessToken, verifyPin } from "./identity.mjs";
import { createSignInThrottle } from "./sign-in-throttle.mjs";

const terminalStates = new Set(["reset", "expired"]);
const staffIdleMs = 15 * 60 * 1000;

export function createAccessService({ repository, model, now, throttle = createSignInThrottle() }) {
  // Missing, wrong token and wrong kiosk share one response so session IDs cannot be probed.
  const notFound = () => new CheckoutError(404, "SESSION_NOT_FOUND", model.messages.sessionExpired);
  const expired = () => new CheckoutError(410, "SESSION_EXPIRED", model.messages.sessionTimedOut);
  const staffRequired = () => new CheckoutError(403, "STAFF_REQUIRED", model.messages.staffSignInRequired);
  let decoyPinHash = null;

  function authorizeSession({ sessionId, bearer, kioskId, requestId = null }) {
    const record = repository.getSessionAccess(sessionId);
    if (!record?.tokenDigest || !bearer || !kioskId) throw notFound();
    if (!digestsEqual(record.tokenDigest, digestToken(bearer)) || record.kioskId !== kioskId) throw notFound();
    if (record.state === "expired") throw expired();
    if (record.expiresAt && now().getTime() >= Date.parse(record.expiresAt)) {
      repository.access.expireSession({ sessionId, now: now().toISOString(), requestId });
      throw expired();
    }
    return record;
  }

  // Called after every start, including an idempotent replay: a replay means the first reply was lost,
  // so rotating the token invalidates a token nobody received.
  function issueSessionToken(sessionId) {
    const record = repository.getSessionAccess(sessionId);
    if (!record || terminalStates.has(record.state)) {
      throw new CheckoutError(409, "INVALID_STATE", model.messages.errors.invalidState);
    }
    const token = newAccessToken();
    repository.access.setSessionTokenDigest(sessionId, digestToken(token));
    return token;
  }

  function expireOverdue(requestId = null) {
    return repository.access.expireOverdue({ now: now().toISOString(), requestId });
  }

  function auditSignIn(code, locationId, result, extra) {
    repository.access.recordAudit(
      { at: now().toISOString(), actorType: "staff", actorId: code, action: "staff.sign_in", locationId, result },
      extra,
    );
  }

  // Unknown codes and wrong PINs share one response and one scrypt cost.
  function signInStaff({ code, pin, requestId = null }) {
    const nowMs = now().getTime();
    if (throttle.isBlocked(code, nowMs)) {
      auditSignIn(code, null, "denied", { reasonCode: "throttled", requestId });
      throw new CheckoutError(429, "STAFF_THROTTLED", model.messages.staffThrottled);
    }
    const staff = repository.access.getStaff(code);
    decoyPinHash ??= hashPin("000000");
    if (!verifyPin(pin, staff?.pinHash ?? decoyPinHash) || !staff) {
      throttle.recordFailure(code, nowMs);
      auditSignIn(code, staff?.locationId ?? null, "denied", { reasonCode: "bad_credentials", requestId });
      throw new CheckoutError(401, "STAFF_AUTH_FAILED", model.messages.staffSignInFailed);
    }
    throttle.clear(code);
    const accessToken = newAccessToken();
    const expiresAt = new Date(nowMs + staffIdleMs).toISOString();
    repository.access.createStaffSession({
      id: randomUUID(),
      staffCode: staff.code,
      locationId: staff.locationId,
      tokenDigest: digestToken(accessToken),
      expiresAt,
      now: now().toISOString(),
    });
    auditSignIn(staff.code, staff.locationId, "success", { requestId });
    return { accessToken, expiresAt, staff: { code: staff.code, name: staff.name, locationId: staff.locationId } };
  }

  function authorizeStaff(bearer) {
    const record = bearer ? repository.access.getStaffSessionByDigest(digestToken(bearer)) : null;
    if (!record) throw staffRequired();
    const nowMs = now().getTime();
    if (nowMs >= Date.parse(record.expiresAt)) {
      repository.access.deleteStaffSession(record.id);
      throw staffRequired();
    }
    repository.access.touchStaffSession(record.id, new Date(nowMs + staffIdleMs).toISOString());
    return { staffCode: record.staffCode, locationId: record.locationId, staffSessionId: record.id };
  }

  function signOutStaff(staff, requestId = null) {
    repository.access.deleteStaffSession(staff.staffSessionId);
    repository.access.recordAudit(
      {
        at: now().toISOString(),
        actorType: "staff",
        actorId: staff.staffCode,
        action: "staff.sign_out",
        locationId: staff.locationId,
        result: "success",
      },
      { requestId },
    );
    return { signedOut: true };
  }

  function listExceptions(staff) {
    return repository.access.listExceptions({ locationId: staff.locationId, now: now().toISOString() });
  }

  return {
    authorizeSession,
    issueSessionToken,
    expireOverdue,
    signInStaff,
    authorizeStaff,
    signOutStaff,
    listExceptions,
  };
}

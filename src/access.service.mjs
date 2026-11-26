import { CheckoutError } from "./errors.mjs";
import { digestToken, digestsEqual, newAccessToken } from "./identity.mjs";

const terminalStates = new Set(["reset", "expired"]);

export function createAccessService({ repository, model, now }) {
  // Missing, wrong token and wrong kiosk share one response so session IDs cannot be probed.
  const notFound = () => new CheckoutError(404, "SESSION_NOT_FOUND", model.messages.sessionExpired);
  const expired = () => new CheckoutError(410, "SESSION_EXPIRED", model.messages.sessionTimedOut);

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

  return { authorizeSession, issueSessionToken, expireOverdue };
}

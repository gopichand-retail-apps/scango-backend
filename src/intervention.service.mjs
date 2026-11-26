import { transition } from "./checkout.machine.mjs";
import { CheckoutError } from "./errors.mjs";
import { fingerprintOf } from "./identity.mjs";

// Attendant decisions on a shopper's exception. rules carries the checkout helpers this module shares
// with checkout.service.mjs (requireSession, requireState, clearIneligibleCoupon).
export function createInterventionService({ repository, model, timestamp, rules }) {
  function auditIntervention(staff, sessionId, result, extra) {
    repository.access.recordAudit(
      {
        at: timestamp(),
        actorType: "staff",
        actorId: staff.staffCode,
        action: "session.intervention",
        sessionId,
        locationId: staff.locationId,
        result,
      },
      extra,
    );
  }

  // Checks run in this order so a stale decision never reveals or changes another location's session.
  function requireInterventionTarget(sessionId, input, staff) {
    const access = repository.getSessionAccess(sessionId);
    if (!access || access.locationId !== staff.locationId) {
      throw new CheckoutError(404, "SESSION_NOT_FOUND", model.messages.sessionExpired);
    }
    const current = { sessionId, state: access.state, version: access.version };
    if (access.version !== input.expectedVersion) {
      throw new CheckoutError(409, "SESSION_VERSION_CONFLICT", model.messages.staffConflict, { current });
    }
    const session = rules.requireSession(repository, sessionId, model);
    rules.requireState(session, ["attention_required"], model);
    const item = session.pendingWeight;
    if (!item) {
      throw new CheckoutError(409, "INTERVENTION_NOT_REQUIRED", model.messages.errors.invalidState);
    }
    if (item.productId !== input.productId) {
      throw new CheckoutError(409, "INTERVENTION_LINE_MISMATCH", model.messages.staffConflict, { current });
    }
    return { session, item, version: access.version };
  }

  function applyIntervention(sessionId, input, staff, requestId) {
    const { session, item, version } = requireInterventionTarget(sessionId, input, staff);
    const currentTime = timestamp();
    const event = input.action === "approve_weight" ? "APPROVE_WEIGHT" : "REMOVE_ATTENTION_ITEM";
    if (input.action === "approve_weight") {
      repository.updateItemWeight(sessionId, item.productId, "passed");
    } else {
      repository.removeItem(sessionId, item.productId);
    }
    repository.recordIntervention({
      sessionId,
      productId: item.productId,
      action: input.action,
      now: currentTime,
      staffCode: staff.staffCode,
      reasonCode: input.reasonCode,
      sessionVersion: version,
    });
    const state = transition(session.state, event);
    repository.updateSession(sessionId, { state }, currentTime);
    rules.clearIneligibleCoupon(repository, model, sessionId, currentTime);
    auditIntervention(staff, sessionId, "success", { reasonCode: input.reasonCode, requestId });
    return { sessionId, state, version: repository.getSessionAccess(sessionId).version };
  }

  // Denials are audited after the transaction rolls back, so they survive it.
  function intervene(sessionId, input, key, staff, context = {}) {
    try {
      return repository.runIdempotently(
        `session:${sessionId}:intervention`,
        key,
        () => applyIntervention(sessionId, input, staff, context.requestId),
        fingerprintOf({ ...input, staffCode: staff.staffCode }),
      );
    } catch (error) {
      if (error instanceof CheckoutError) {
        auditIntervention(staff, sessionId, "denied", { reasonCode: error.code, requestId: context.requestId });
      }
      throw error;
    }
  }

  return { intervene };
}

const transitions = {
  idle: { START_SESSION: "scanning" },
  scanning: {
    SCAN_ITEM: "scanning",
    ADD_WEIGHT_ITEM: "weight_check_pending",
    ADJUST_ITEM: "scanning",
    ADJUST_WEIGHT_ITEM: "weight_check_pending",
    APPLY_COUPON: "scanning",
    BEGIN_CHECKOUT: "ready_to_pay",
    RESET: "reset",
  },
  weight_check_pending: {
    SCALE_PASSED: "scanning",
    SCALE_MISMATCH: "attention_required",
    RESET: "reset",
  },
  attention_required: {
    APPROVE_WEIGHT: "scanning",
    REMOVE_ATTENTION_ITEM: "scanning",
    RESET: "reset",
  },
  ready_to_pay: {
    PAYMENT_DECLINED: "ready_to_pay",
    PAYMENT_APPROVED: "paid",
    RESET: "reset",
  },
  paid: { ISSUE_RECEIPT: "receipt_issued", RESET: "reset" },
  receipt_issued: { RESET: "reset" },
  reset: {},
};

export class TransitionError extends Error {
  constructor(state, event) {
    super(`Event ${event} is not allowed from state ${state}.`);
    this.name = "TransitionError";
    this.code = "INVALID_STATE";
    this.status = 409;
  }
}

export function transition(state, event) {
  const nextState = transitions[state]?.[event];
  if (!nextState) throw new TransitionError(state, event);
  return nextState;
}

export function getAllowedEvents(state) {
  return Object.keys(transitions[state] ?? {});
}

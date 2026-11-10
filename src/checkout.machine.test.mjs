import assert from "node:assert/strict";
import test from "node:test";
import { getAllowedEvents, transition, TransitionError } from "./checkout.machine.mjs";

test("session startup follows the explicit idle-to-scanning transition", () => {
  assert.equal(transition("idle", "START_SESSION"), "scanning");
  assert.deepEqual(getAllowedEvents("idle"), ["START_SESSION"]);
});

test("scale mismatch blocks checkout until an attendant action resolves it", () => {
  assert.equal(transition("weight_check_pending", "SCALE_MISMATCH"), "attention_required");
  assert.equal(transition("attention_required", "APPROVE_WEIGHT"), "scanning");
  assert.throws(() => transition("attention_required", "BEGIN_CHECKOUT"), TransitionError);
});

test("declined tender remains payable while approval enters the paid state", () => {
  assert.equal(transition("ready_to_pay", "PAYMENT_DECLINED"), "ready_to_pay");
  assert.equal(transition("ready_to_pay", "PAYMENT_APPROVED"), "paid");
  assert.throws(() => transition("paid", "PAYMENT_APPROVED"), TransitionError);
});

test("the checkout state machine exposes every allowed event and rejects unknown states", () => {
  const transitions = [
    ["scanning", "SCAN_ITEM", "scanning"],
    ["scanning", "ADD_WEIGHT_ITEM", "weight_check_pending"],
    ["scanning", "ADJUST_ITEM", "scanning"],
    ["scanning", "ADJUST_WEIGHT_ITEM", "weight_check_pending"],
    ["scanning", "APPLY_COUPON", "scanning"],
    ["scanning", "BEGIN_CHECKOUT", "ready_to_pay"],
    ["scanning", "RESET", "reset"],
    ["weight_check_pending", "SCALE_PASSED", "scanning"],
    ["weight_check_pending", "RESET", "reset"],
    ["attention_required", "REMOVE_ATTENTION_ITEM", "scanning"],
    ["attention_required", "RESET", "reset"],
    ["ready_to_pay", "RESET", "reset"],
    ["paid", "ISSUE_RECEIPT", "receipt_issued"],
    ["paid", "RESET", "reset"],
    ["receipt_issued", "RESET", "reset"],
  ];

  for (const [state, event, nextState] of transitions) {
    assert.equal(transition(state, event), nextState);
    assert.ok(getAllowedEvents(state).includes(event));
  }
  assert.deepEqual(getAllowedEvents("reset"), []);
  assert.deepEqual(getAllowedEvents("unknown"), []);
  assert.throws(
    () => transition("unknown", "START_SESSION"),
    (error) => error instanceof TransitionError && error.status === 409 && error.code === "INVALID_STATE",
  );
});

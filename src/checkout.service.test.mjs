import assert from "node:assert/strict";
import test from "node:test";
import { createCheckoutRepository } from "./checkout.repository.mjs";
import { createCheckoutService, CheckoutError } from "./checkout.service.mjs";
import { loadModel } from "./server.mjs";

function createCheckout(t, customizeModel = () => {}) {
  const model = loadModel();
  customizeModel(model);
  const repository = createCheckoutRepository({ databasePath: ":memory:", model });
  t.after(() => repository.close());
  return { model, repository, service: createCheckoutService({ repository, model }) };
}

function startSession(service) {
  return service.startSession("start-session-key");
}

test("server-owned catalog prices produce exact-cent checkout totals and idempotent scans", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  const firstScan = service.scan(session.id, "QS-BRD-031", "barcode", "bread-scan-key");
  const replay = service.scan(session.id, "QS-BRD-031", "barcode", "bread-scan-key");

  assert.deepEqual(replay, firstScan);
  assert.equal(firstScan.items[0].unitPriceCents, 549);
  assert.equal(firstScan.items[0].quantity, 1);
  const quote = service.prepareCheckout(session.id, "checkout-key");
  assert.deepEqual(
    {
      subtotalCents: quote.subtotalCents,
      discountCents: quote.discountCents,
      taxCents: quote.taxCents,
      totalCents: quote.totalCents,
    },
    { subtotalCents: 549, discountCents: 0, taxCents: 45, totalCents: 594 },
  );
});

test("eligible coupon discounts and tax are calculated from integer cents", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-APL-014", "barcode", "apple-scan");
  service.checkWeight(session.id, 980, "apple-weight");
  service.scan(session.id, "QS-BRD-031", "barcode", "bread-scan");
  service.scan(session.id, "QS-EGG-056", "barcode", "egg-scan");
  const discounted = service.applyCoupon(session.id, "FRESH10", "coupon-key");

  assert.equal(discounted.couponCode, "FRESH10");
  assert.equal(discounted.subtotalCents, 1697);
  assert.equal(discounted.discountCents, 169);
  assert.equal(discounted.taxCents, 126);
  assert.equal(discounted.totalCents, 1654);
});

test("fixed coupon discounts cannot exceed the eligible category subtotal", (t) => {
  const { service } = createCheckout(t, (model) => {
    const coupon = model.data.coupons.find((item) => item.code === "FRESH10");
    coupon.kind = "fixed";
    coupon.value = 900;
    coupon.minimumSubtotalCents = 100;
    coupon.maximumDiscountCents = 900;
    coupon.categoryIds = ["produce"];
  });
  const session = startSession(service);
  service.scan(session.id, "QS-APL-014", "barcode", "apple-scan");
  service.checkWeight(session.id, 980, "apple-weight");
  service.scan(session.id, "QS-BRD-031", "barcode", "bread-scan");
  const discounted = service.applyCoupon(session.id, "FRESH10", "coupon-key");

  assert.equal(discounted.subtotalCents, 998);
  assert.equal(discounted.discountCents, 449);
  assert.equal(discounted.totalCents, 594);
});

test("scale mismatch requires attendant intervention before checkout", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  const scanned = service.scan(session.id, "QS-APL-014", "barcode", "apple-scan");
  assert.equal(scanned.state, "weight_check_pending");

  const mismatch = service.checkWeight(session.id, 1200, "bad-weight-key");
  assert.equal(mismatch.state, "attention_required");
  assert.equal(mismatch.pendingWeight.weightStatus, "attention");
  assert.throws(
    () => service.prepareCheckout(session.id, "blocked-checkout"),
    (error) => error instanceof CheckoutError && error.code === "INVALID_STATE",
  );

  const resolved = service.intervene(session.id, "approve_weight", "approve-weight-key");
  assert.equal(resolved.state, "scanning");
  assert.equal(resolved.pendingWeight, null);
});

test("a declined tender can be retried and approved without card data", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-MLK-044", "barcode", "milk-scan");
  service.prepareCheckout(session.id, "checkout-key");
  const declined = service.simulateTender(session.id, "simulated_card", "decline", "decline-key");
  const replay = service.simulateTender(session.id, "simulated_card", "decline", "decline-key");

  assert.deepEqual(replay, declined);
  assert.equal(declined.approved, false);
  assert.equal(declined.session.state, "ready_to_pay");
  const approved = service.simulateTender(session.id, "cash", "approve", "approve-key");
  assert.equal(approved.approved, true);
  assert.equal(approved.session.state, "paid");
  assert.equal("cardNumber" in approved, false);
  assert.equal("securityCode" in approved, false);
});

test("receipt metadata survives session reset", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-COF-063", "barcode", "coffee-scan");
  service.prepareCheckout(session.id, "checkout-key");
  service.simulateTender(session.id, "simulated_card", "approve", "tender-key");
  const receipt = service.issueReceipt(session.id, "receipt-key");
  const reset = service.resetSession(session.id, "reset-key");

  assert.match(receipt.receiptNumber, /^QS-\d{8}-[A-F0-9]{6}$/);
  assert.equal(receipt.totalCents > 0, true);
  assert.equal(reset.state, "reset");
  assert.equal(service.getReceipt(session.id).receiptNumber, receipt.receiptNumber);
});

test("invalid scan batches roll back every line and the idempotency record", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  assert.throws(
    () => service.scanBatch(session.id, ["QS-BRD-031", "UNKNOWN-CODE"], "batch-key"),
    (error) => error instanceof CheckoutError && error.code === "ITEM_NOT_FOUND",
  );
  assert.equal(service.getSession(session.id).items.length, 0);
});

test("scan batches are bounded by model configuration", (t) => {
  const { model, service } = createCheckout(t);
  const session = startSession(service);
  const tooMany = Array(model.data.app.maximumScanBatch + 1).fill("QS-MLK-044");
  assert.throws(
    () => service.scanBatch(session.id, tooMany, "large-batch-key"),
    (error) => error instanceof CheckoutError && error.code === "INVALID_SCAN_BATCH",
  );
  assert.equal(service.getSession(session.id).items.length, 0);
});

test("unknown sessions and missing receipts return stable domain errors", (t) => {
  const { service } = createCheckout(t);

  for (const action of [
    () => service.getSession("missing-session"),
    () => service.getReceipt("missing-session"),
    () => service.scan("missing-session", "QS-MLK-044", "barcode", "missing-scan"),
    () => service.resetSession("missing-session", "missing-reset"),
  ]) {
    assert.throws(action, (error) => error instanceof CheckoutError && error.code === "SESSION_NOT_FOUND");
  }

  const session = startSession(service);
  assert.throws(
    () => service.getReceipt(session.id),
    (error) => error instanceof CheckoutError && error.code === "RECEIPT_NOT_FOUND",
  );
});

test("quantity edits remove lines, reprice totals, and clear ineligible coupons", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-COF-063", "barcode", "coffee-scan");
  service.scan(session.id, "QS-BRD-031", "barcode", "bread-scan");
  const discounted = service.applyCoupon(session.id, "FRESH10", "apply-coupon");
  assert.equal(discounted.couponCode, "FRESH10");

  const removed = service.adjustQuantity(session.id, "bread-country", -1, "remove-bread");
  assert.equal(removed.items.length, 1);
  assert.equal(removed.items[0].productId, "pantry-coffee");
  assert.equal(removed.couponCode, null);
  assert.equal(removed.discountCents, 0);

  const increased = service.adjustQuantity(session.id, "pantry-coffee", 1, "increase-coffee");
  assert.equal(increased.items[0].quantity, 2);
  assert.equal(increased.subtotalCents, 2398);
  assert.throws(
    () => service.adjustQuantity(session.id, "unknown-product", 1, "missing-product"),
    (error) => error instanceof CheckoutError && error.code === "ITEM_NOT_FOUND",
  );
});

test("quantity and scan actions enforce the configured maximum", (t) => {
  const { service } = createCheckout(t, (model) => {
    model.data.app.maximumQuantity = 1;
  });
  const session = startSession(service);
  service.scan(session.id, "QS-MLK-044", "barcode", "milk-scan");

  assert.throws(
    () => service.scan(session.id, "QS-MLK-044", "barcode", "milk-overflow"),
    (error) => error instanceof CheckoutError && error.code === "QUANTITY_LIMIT",
  );
  assert.throws(
    () => service.adjustQuantity(session.id, "dairy-milk", 1, "milk-adjust-overflow"),
    (error) => error instanceof CheckoutError && error.code === "QUANTITY_LIMIT",
  );
});

test("coupon validation, removal, and below-minimum paths preserve server totals", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-MLK-044", "barcode", "milk-scan");

  assert.throws(
    () => service.applyCoupon(session.id, "UNKNOWN", "unknown-coupon"),
    (error) => error instanceof CheckoutError && error.code === "INVALID_COUPON",
  );
  assert.throws(
    () => service.applyCoupon(session.id, "FRESH10", "below-minimum"),
    (error) => error instanceof CheckoutError && error.code === "COUPON_MINIMUM",
  );
  const cleared = service.applyCoupon(session.id, "", "clear-no-coupon");
  assert.equal(cleared.couponCode, null);
  assert.equal(cleared.discountCents, 0);
});

test("scale success and attendant removal produce the expected server states", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-APL-014", "barcode", "apple-scan");
  const passed = service.checkWeight(session.id, 980, "apple-weight-pass");
  assert.equal(passed.state, "scanning");
  assert.equal(passed.items[0].weightStatus, "passed");

  service.scan(session.id, "QS-BAN-022", "barcode", "banana-scan");
  service.checkWeight(session.id, 2000, "banana-weight-fail");
  const removed = service.intervene(session.id, "remove_item", "remove-banana");
  assert.equal(removed.state, "scanning");
  assert.deepEqual(
    removed.items.map((item) => item.productId),
    ["fruit-apples"],
  );
  assert.equal(removed.pendingWeight, null);
});

test("scan batches roll back when a weighted item is not last", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);

  assert.throws(
    () => service.scanBatch(session.id, ["QS-APL-014", "QS-MLK-044"], "weighted-batch"),
    (error) => error instanceof CheckoutError && error.code === "WEIGHT_CHECK_REQUIRED",
  );
  assert.deepEqual(service.getSession(session.id).items, []);
  const successful = service.scanBatch(session.id, ["QS-MLK-044", "QS-EGG-056"], "simple-batch");
  assert.equal(successful.items.length, 2);
  assert.equal(successful.state, "scanning");
});

test("weight and intervention actions reject inconsistent checkout state", (t) => {
  const { repository, service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-APL-014", "barcode", "apple-scan");
  repository.removeItem(session.id, "fruit-apples");

  assert.throws(
    () => service.checkWeight(session.id, 980, "missing-pending-weight"),
    (error) => error instanceof CheckoutError && error.code === "WEIGHT_CHECK_REQUIRED",
  );

  repository.updateSession(session.id, { state: "attention_required" }, new Date().toISOString());
  assert.throws(
    () => service.intervene(session.id, "approve_weight", "missing-attention-item"),
    (error) => error instanceof CheckoutError && error.code === "INTERVENTION_NOT_REQUIRED",
  );
});

test("tender enums, receipt requirements, receipt replay, and reset replay are enforced", (t) => {
  const { service } = createCheckout(t);
  const session = startSession(service);
  service.scan(session.id, "QS-MLK-044", "barcode", "milk-scan");
  service.prepareCheckout(session.id, "checkout-key");

  assert.throws(
    () => service.simulateTender(session.id, "unknown", "approve", "invalid-method"),
    (error) => error instanceof CheckoutError && error.code === "INVALID_TENDER",
  );
  assert.throws(
    () => service.simulateTender(session.id, "cash", "unknown", "invalid-outcome"),
    (error) => error instanceof CheckoutError && error.code === "INVALID_TENDER",
  );
  assert.throws(
    () => service.issueReceipt(session.id, "receipt-before-payment"),
    (error) => error instanceof CheckoutError && error.code === "INVALID_STATE",
  );

  service.simulateTender(session.id, "cash", "approve", "approved-tender");
  const issued = service.issueReceipt(session.id, "first-receipt");
  const replayed = service.issueReceipt(session.id, "second-receipt");
  assert.deepEqual(replayed, issued);

  const reset = service.resetSession(session.id, "first-reset");
  const resetReplay = service.resetSession(session.id, "second-reset");
  assert.deepEqual(resetReplay, reset);
});

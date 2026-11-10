import { randomUUID } from "node:crypto";
import { transition } from "./checkout.machine.mjs";

export class CheckoutError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "CheckoutError";
    this.status = status;
    this.code = code;
  }
}

function requireSession(repository, sessionId, model) {
  const session = repository.getSession(sessionId);
  if (!session) {
    throw new CheckoutError(404, "SESSION_NOT_FOUND", model.messages.sessionExpired);
  }
  return session;
}

function requireState(session, expectedStates, model) {
  if (!expectedStates.includes(session.state)) {
    throw new CheckoutError(409, "INVALID_STATE", model.messages.errors.invalidState);
  }
}

function calculateDiscount(session, coupon) {
  if (!coupon) return 0;
  const eligibleSubtotal = session.items
    .filter((item) => coupon.categoryIds.includes(item.categoryId))
    .reduce((total, item) => total + item.lineTotalCents, 0);
  if (eligibleSubtotal < coupon.minimumSubtotalCents) return 0;
  const amount =
    coupon.kind === "percent" ? Number((BigInt(eligibleSubtotal) * BigInt(coupon.value)) / 10000n) : coupon.value;
  return Math.min(eligibleSubtotal, coupon.maximumDiscountCents, amount);
}

function calculateTotals(session, coupon, model) {
  const subtotalCents = session.items.reduce((total, item) => total + item.lineTotalCents, 0);
  const discountCents = calculateDiscount({ ...session, subtotalCents }, coupon);
  const taxableCents = subtotalCents - discountCents;
  const taxCents = Number((BigInt(taxableCents) * BigInt(model.data.app.taxRateBasisPoints) + 5000n) / 10000n);
  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: taxableCents + taxCents,
  };
}

function presentSession(repository, model, sessionId) {
  const session = requireSession(repository, sessionId, model);
  const coupon = session.couponCode ? repository.getCoupon(session.couponCode) : null;
  return { ...session, ...calculateTotals(session, coupon, model) };
}

function clearIneligibleCoupon(repository, model, sessionId, now) {
  const session = repository.getSession(sessionId);
  if (!session?.couponCode) return;
  const coupon = repository.getCoupon(session.couponCode);
  if (calculateDiscount(session, coupon) === 0) {
    repository.setCoupon(sessionId, null, now);
  }
}

function assertNoPendingWeight(session, model) {
  if (session.pendingWeight) {
    throw new CheckoutError(409, "WEIGHT_CHECK_REQUIRED", model.messages.weightMismatch);
  }
}

function itemWeightStatus(product) {
  return product.weightRequired ? "pending" : "not_required";
}

export function createCheckoutService({ repository, model, now = () => new Date() }) {
  function timestamp() {
    return now().toISOString();
  }

  function catalog() {
    return { categories: model.data.categories, products: repository.listProducts() };
  }

  function startSession(key) {
    return repository.runIdempotently("session:start", key, () => {
      const sessionId = randomUUID();
      const createdAt = timestamp();
      repository.createSession(sessionId, transition("idle", "START_SESSION"), createdAt);
      return presentSession(repository, model, sessionId);
    });
  }

  function getSession(sessionId) {
    return presentSession(repository, model, sessionId);
  }

  function scanOne(sessionId, barcode, source, key) {
    const session = requireSession(repository, sessionId, model);
    requireState(session, ["scanning"], model);
    const product = repository.getProduct(barcode);
    if (!product) {
      throw new CheckoutError(404, "ITEM_NOT_FOUND", model.messages.invalidBarcode);
    }
    const currentQuantity = session.items.find((item) => item.productId === product.id)?.quantity ?? 0;
    const quantity = currentQuantity + 1;
    if (quantity > model.data.app.maximumQuantity) {
      throw new CheckoutError(422, "QUANTITY_LIMIT", model.messages.errors.invalidQuantity);
    }
    const nextState = transition(session.state, product.weightRequired ? "ADD_WEIGHT_ITEM" : "SCAN_ITEM");
    const currentTime = timestamp();
    repository.upsertItem(sessionId, product, quantity, itemWeightStatus(product), currentTime);
    repository.recordScan({
      sessionId,
      productId: product.id,
      quantityDelta: 1,
      source,
      key,
      now: currentTime,
    });
    repository.updateSession(sessionId, { state: nextState }, currentTime);
    return presentSession(repository, model, sessionId);
  }

  function scan(sessionId, barcode, source, key) {
    return repository.runIdempotently(`session:${sessionId}:scan`, key, () => scanOne(sessionId, barcode, source, key));
  }

  function scanBatch(sessionId, barcodes, key) {
    if (!barcodes.length || barcodes.length > model.data.app.maximumScanBatch) {
      throw new CheckoutError(422, "INVALID_SCAN_BATCH", model.messages.errors.invalidRequest);
    }
    return repository.runIdempotently(`session:${sessionId}:scan-batch`, key, () => {
      let result;
      barcodes.forEach((barcode, index) => {
        result = scanOne(sessionId, barcode, "barcode", `${key}:${index}`);
        if (index < barcodes.length - 1 && result.state !== "scanning") {
          throw new CheckoutError(409, "WEIGHT_CHECK_REQUIRED", model.messages.weightMismatch);
        }
      });
      return result;
    });
  }

  function adjustQuantity(sessionId, productId, delta, key) {
    return repository.runIdempotently(`session:${sessionId}:quantity`, key, () => {
      const session = requireSession(repository, sessionId, model);
      requireState(session, ["scanning"], model);
      const item = session.items.find((line) => line.productId === productId);
      if (!item) {
        throw new CheckoutError(404, "ITEM_NOT_FOUND", model.messages.invalidBarcode);
      }
      const quantity = item.quantity + delta;
      if (quantity > model.data.app.maximumQuantity) {
        throw new CheckoutError(422, "QUANTITY_LIMIT", model.messages.errors.invalidQuantity);
      }
      const product = repository.getProduct(productId);
      const currentTime = timestamp();
      if (quantity <= 0) {
        repository.removeItem(sessionId, productId);
      } else {
        repository.upsertItem(sessionId, product, quantity, itemWeightStatus(product), currentTime);
      }
      const nextState =
        quantity > 0 && product.weightRequired
          ? transition(session.state, "ADJUST_WEIGHT_ITEM")
          : transition(session.state, "ADJUST_ITEM");
      repository.recordScan({
        sessionId,
        productId,
        quantityDelta: delta,
        source: "quantity",
        key,
        now: currentTime,
      });
      repository.updateSession(sessionId, { state: nextState }, currentTime);
      clearIneligibleCoupon(repository, model, sessionId, currentTime);
      return presentSession(repository, model, sessionId);
    });
  }

  function applyCoupon(sessionId, rawCode, key) {
    return repository.runIdempotently(`session:${sessionId}:coupon`, key, () => {
      const session = requireSession(repository, sessionId, model);
      requireState(session, ["scanning"], model);
      if (!rawCode) {
        repository.setCoupon(sessionId, null, timestamp());
        return presentSession(repository, model, sessionId);
      }
      const coupon = repository.getCoupon(rawCode.toUpperCase());
      if (!coupon) {
        throw new CheckoutError(422, "INVALID_COUPON", model.messages.invalidCoupon);
      }
      if (calculateDiscount(session, coupon) <= 0) {
        throw new CheckoutError(422, "COUPON_MINIMUM", model.messages.couponMinimum);
      }
      const currentTime = timestamp();
      repository.setCoupon(sessionId, coupon.code, currentTime);
      repository.updateSession(sessionId, { state: transition(session.state, "APPLY_COUPON") }, currentTime);
      return presentSession(repository, model, sessionId);
    });
  }

  function checkWeight(sessionId, simulatedWeightGrams, key) {
    return repository.runIdempotently(`session:${sessionId}:weight`, key, () => {
      const session = requireSession(repository, sessionId, model);
      requireState(session, ["weight_check_pending"], model);
      const item = session.pendingWeight;
      if (!item) {
        throw new CheckoutError(409, "WEIGHT_CHECK_REQUIRED", model.messages.weightMismatch);
      }
      const passed = Math.abs(simulatedWeightGrams - item.expectedWeightGrams) <= item.toleranceGrams;
      const currentTime = timestamp();
      repository.updateItemWeight(sessionId, item.productId, passed ? "passed" : "attention");
      repository.updateSession(
        sessionId,
        { state: transition(session.state, passed ? "SCALE_PASSED" : "SCALE_MISMATCH") },
        currentTime,
      );
      return presentSession(repository, model, sessionId);
    });
  }

  function intervene(sessionId, action, key) {
    return repository.runIdempotently(`session:${sessionId}:intervention`, key, () => {
      const session = requireSession(repository, sessionId, model);
      requireState(session, ["attention_required"], model);
      const item = session.pendingWeight;
      if (!item) {
        throw new CheckoutError(409, "INTERVENTION_NOT_REQUIRED", model.messages.errors.invalidState);
      }
      const currentTime = timestamp();
      const event = action === "approve_weight" ? "APPROVE_WEIGHT" : "REMOVE_ATTENTION_ITEM";
      if (action === "approve_weight") {
        repository.updateItemWeight(sessionId, item.productId, "passed");
      } else {
        repository.removeItem(sessionId, item.productId);
      }
      repository.recordIntervention({
        sessionId,
        productId: item.productId,
        action,
        now: currentTime,
      });
      repository.updateSession(sessionId, { state: transition(session.state, event) }, currentTime);
      clearIneligibleCoupon(repository, model, sessionId, currentTime);
      return presentSession(repository, model, sessionId);
    });
  }

  function prepareCheckout(sessionId, key) {
    return repository.runIdempotently(`session:${sessionId}:checkout`, key, () => {
      const session = requireSession(repository, sessionId, model);
      requireState(session, ["scanning"], model);
      if (!session.items.length) {
        throw new CheckoutError(422, "EMPTY_BASKET", model.messages.emptyBasket);
      }
      assertNoPendingWeight(session, model);
      const currentTime = timestamp();
      repository.updateSession(sessionId, { state: transition(session.state, "BEGIN_CHECKOUT") }, currentTime);
      return presentSession(repository, model, sessionId);
    });
  }

  function simulateTender(sessionId, method, outcome, key) {
    return repository.runIdempotently(`session:${sessionId}:tender`, key, () => {
      const session = requireSession(repository, sessionId, model);
      requireState(session, ["ready_to_pay"], model);
      if (!model.data.simulator.tenderMethods.includes(method) || !model.data.simulator.outcomes.includes(outcome)) {
        throw new CheckoutError(422, "INVALID_TENDER", model.messages.errors.invalidRequest);
      }
      const totals = calculateTotals(
        session,
        session.couponCode ? repository.getCoupon(session.couponCode) : null,
        model,
      );
      const currentTime = timestamp();
      const approved = outcome === "approve";
      repository.recordTender({
        sessionId,
        method,
        outcome,
        amountCents: totals.totalCents,
        key,
        now: currentTime,
      });
      repository.updateSession(
        sessionId,
        {
          state: transition(session.state, approved ? "PAYMENT_APPROVED" : "PAYMENT_DECLINED"),
          paymentStatus: approved ? "approved" : "declined",
        },
        currentTime,
      );
      return {
        session: presentSession(repository, model, sessionId),
        approved,
        message: model.messages[approved ? "paymentApproved" : "paymentDeclined"],
      };
    });
  }

  function issueReceipt(sessionId, key) {
    return repository.runIdempotently(`session:${sessionId}:receipt`, key, () => {
      const session = requireSession(repository, sessionId, model);
      const existing = repository.getReceipt(sessionId);
      if (existing) return existing;
      requireState(session, ["paid"], model);
      const totals = calculateTotals(
        session,
        session.couponCode ? repository.getCoupon(session.couponCode) : null,
        model,
      );
      const tender = session.latestTender;
      if (!tender || tender.outcome !== "approve") {
        throw new CheckoutError(409, "PAYMENT_REQUIRED", model.messages.errors.invalidState);
      }
      const currentTime = timestamp();
      const receiptNumber = `QS-${currentTime.slice(0, 10).replaceAll("-", "")}-${session.id.slice(-6).toUpperCase()}`;
      const receiptItems = session.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.lineTotalCents,
      }));
      repository.createReceipt({
        sessionId,
        receiptNumber,
        totals,
        tenderMethod: tender.method,
        items: receiptItems,
        now: currentTime,
      });
      repository.updateSession(sessionId, { state: transition(session.state, "ISSUE_RECEIPT") }, currentTime);
      return repository.getReceipt(sessionId);
    });
  }

  function resetSession(sessionId, key) {
    return repository.runIdempotently(`session:${sessionId}:reset`, key, () => {
      const session = requireSession(repository, sessionId, model);
      if (session.state === "reset") return { sessionId, state: "reset" };
      const currentTime = timestamp();
      const state = transition(session.state, "RESET");
      repository.updateSession(sessionId, { state, resetAt: currentTime }, currentTime);
      return { sessionId, state };
    });
  }

  return {
    catalog,
    getSession,
    getReceipt: (sessionId) => {
      requireSession(repository, sessionId, model);
      const receipt = repository.getReceipt(sessionId);
      if (!receipt) {
        throw new CheckoutError(404, "RECEIPT_NOT_FOUND", model.messages.errors.notFound);
      }
      return receipt;
    },
    startSession,
    scan,
    scanBatch,
    adjustQuantity,
    applyCoupon,
    checkWeight,
    intervene,
    prepareCheckout,
    simulateTender,
    issueReceipt,
    resetSession,
  };
}

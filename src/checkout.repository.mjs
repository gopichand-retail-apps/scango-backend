import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkoutSchema } from "./checkout.schema.mjs";

function transaction(database, work) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createCheckoutRepository({ databasePath, model }) {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  database.exec(checkoutSchema);
  seedCatalog();

  function seedCatalog() {
    transaction(database, () => {
      const addProduct = database.prepare(`
        INSERT OR IGNORE INTO products
          (id, barcode, name, description, category_id, price_cents, unit_key, image,
           weight_required, expected_weight_grams, tolerance_grams)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const product of model.data.products) {
        addProduct.run(
          product.id,
          product.barcode,
          product.name,
          product.description,
          product.categoryId,
          product.priceCents,
          product.unitKey,
          product.image,
          Number(product.weightCheck.required),
          product.weightCheck.expectedGrams,
          product.weightCheck.toleranceGrams,
        );
      }
      const addCoupon = database.prepare(`
        INSERT OR IGNORE INTO coupons
          (code, description, kind, value, minimum_subtotal_cents, maximum_discount_cents, category_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const coupon of model.data.coupons) {
        addCoupon.run(
          coupon.code,
          coupon.description,
          coupon.kind,
          coupon.value,
          coupon.minimumSubtotalCents,
          coupon.maximumDiscountCents,
          JSON.stringify(coupon.categoryIds),
        );
      }
    });
  }

  function getProduct(identifier) {
    const row = database
      .prepare(
        `
      SELECT id, barcode, name, description, category_id AS categoryId,
        price_cents AS priceCents, unit_key AS unitKey, image,
        weight_required AS weightRequired, expected_weight_grams AS expectedWeightGrams,
        tolerance_grams AS toleranceGrams
      FROM products WHERE id = ? OR barcode = ?
    `,
      )
      .get(identifier, identifier);
    if (!row) return null;
    return { ...row, weightRequired: Boolean(row.weightRequired) };
  }

  function getCoupon(code) {
    const row = database
      .prepare(
        `
      SELECT code, description, kind, value,
        minimum_subtotal_cents AS minimumSubtotalCents,
        maximum_discount_cents AS maximumDiscountCents,
        category_ids_json AS categoryIdsJson
      FROM coupons WHERE code = ?
    `,
      )
      .get(code);
    if (!row) return null;
    const { categoryIdsJson, ...coupon } = row;
    return { ...coupon, categoryIds: JSON.parse(categoryIdsJson) };
  }

  function getSessionRecord(sessionId) {
    return (
      database
        .prepare(
          `
      SELECT id, state, coupon_code AS couponCode, payment_status AS paymentStatus,
        created_at AS createdAt, updated_at AS updatedAt, reset_at AS resetAt
      FROM checkout_sessions WHERE id = ?
    `,
        )
        .get(sessionId) ?? null
    );
  }

  function getSessionItems(sessionId) {
    return database
      .prepare(
        `
      SELECT i.product_id AS productId, p.barcode, p.name, p.description,
        p.category_id AS categoryId, p.image, p.unit_key AS unitKey,
        i.quantity, i.unit_price_cents AS unitPriceCents,
        i.quantity * i.unit_price_cents AS lineTotalCents,
        i.weight_status AS weightStatus,
        i.expected_weight_grams AS expectedWeightGrams,
        i.tolerance_grams AS toleranceGrams
      FROM session_items i
      JOIN products p ON p.id = i.product_id
      WHERE i.session_id = ?
      ORDER BY i.added_at, p.name
    `,
      )
      .all(sessionId)
      .map((item) => ({ ...item }));
  }

  function getSession(sessionId) {
    const session = getSessionRecord(sessionId);
    if (!session) return null;
    const items = getSessionItems(sessionId);
    return {
      ...session,
      items,
      pendingWeight: items.find((item) => item.weightStatus === "pending" || item.weightStatus === "attention") ?? null,
      latestTender: getLatestTender(sessionId),
    };
  }

  function getLatestTender(sessionId) {
    const tender = database
      .prepare(
        `
      SELECT id, method, outcome, amount_cents AS amountCents, occurred_at AS occurredAt
      FROM tenders WHERE session_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1
    `,
      )
      .get(sessionId);
    return tender ? { ...tender } : null;
  }

  function getReceipt(sessionId) {
    const row = database
      .prepare(
        `
      SELECT id, session_id AS sessionId, receipt_number AS receiptNumber,
        subtotal_cents AS subtotalCents, discount_cents AS discountCents,
        tax_cents AS taxCents, total_cents AS totalCents, tender_method AS tenderMethod,
        items_json AS itemsJson, issued_at AS issuedAt
      FROM receipts WHERE session_id = ?
    `,
      )
      .get(sessionId);
    if (!row) return null;
    const { itemsJson, ...receipt } = row;
    return { ...receipt, items: JSON.parse(itemsJson) };
  }

  function runIdempotently(scope, key, work) {
    return transaction(database, () => {
      const previous = database
        .prepare(
          `
        SELECT response_json AS responseJson FROM idempotency_records
        WHERE scope = ? AND idempotency_key = ?
      `,
        )
        .get(scope, key);
      if (previous) return JSON.parse(previous.responseJson);
      const response = work();
      database
        .prepare(
          `
        INSERT INTO idempotency_records (scope, idempotency_key, response_json, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(scope, key, JSON.stringify(response), new Date().toISOString());
      return response;
    });
  }

  return {
    close: () => database.close(),
    health: () => database.prepare("SELECT 1 AS ready").get().ready === 1,
    listProducts: () =>
      database
        .prepare(
          `
      SELECT id, barcode, name, description, category_id AS categoryId,
        price_cents AS priceCents, unit_key AS unitKey, image,
        weight_required AS weightRequired, expected_weight_grams AS expectedWeightGrams,
        tolerance_grams AS toleranceGrams
      FROM products ORDER BY category_id, name
    `,
        )
        .all()
        .map((product) => ({
          ...product,
          weightRequired: Boolean(product.weightRequired),
        })),
    getProduct,
    getCoupon,
    getSession,
    getReceipt,
    runIdempotently,
    createSession: (id, state, now) => {
      database
        .prepare(
          `
        INSERT INTO checkout_sessions (id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(id, state, now, now);
    },
    updateSession: (sessionId, updates, now) => {
      const fields = [];
      const values = [];
      if (updates.state) {
        fields.push("state = ?");
        values.push(updates.state);
      }
      if (Object.hasOwn(updates, "couponCode")) {
        fields.push("coupon_code = ?");
        values.push(updates.couponCode);
      }
      if (updates.paymentStatus) {
        fields.push("payment_status = ?");
        values.push(updates.paymentStatus);
      }
      if (Object.hasOwn(updates, "resetAt")) {
        fields.push("reset_at = ?");
        values.push(updates.resetAt);
      }
      fields.push("updated_at = ?");
      values.push(now, sessionId);
      database.prepare(`UPDATE checkout_sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    },
    upsertItem: (sessionId, product, quantity, weightStatus, now) => {
      database
        .prepare(
          `
        INSERT INTO session_items
          (session_id, product_id, quantity, unit_price_cents, weight_status,
           expected_weight_grams, tolerance_grams, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, product_id) DO UPDATE SET
          quantity = excluded.quantity,
          weight_status = excluded.weight_status,
          expected_weight_grams = excluded.expected_weight_grams,
          tolerance_grams = excluded.tolerance_grams
      `,
        )
        .run(
          sessionId,
          product.id,
          quantity,
          product.priceCents,
          weightStatus,
          product.expectedWeightGrams * quantity,
          product.toleranceGrams * quantity,
          now,
        );
    },
    updateItemWeight: (sessionId, productId, weightStatus) => {
      database
        .prepare(
          `
        UPDATE session_items SET weight_status = ? WHERE session_id = ? AND product_id = ?
      `,
        )
        .run(weightStatus, sessionId, productId);
    },
    removeItem: (sessionId, productId) => {
      database.prepare("DELETE FROM session_items WHERE session_id = ? AND product_id = ?").run(sessionId, productId);
    },
    setCoupon: (sessionId, couponCode, now) => {
      database
        .prepare(`UPDATE checkout_sessions SET coupon_code = ?, updated_at = ? WHERE id = ?`)
        .run(couponCode, now, sessionId);
    },
    recordScan: ({ sessionId, productId, quantityDelta, source, key, now }) => {
      database
        .prepare(
          `
        INSERT INTO scan_events (id, session_id, product_id, quantity_delta, source, idempotency_key, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(randomUUID(), sessionId, productId, quantityDelta, source, key, now);
    },
    recordIntervention: ({ sessionId, productId, action, now }) => {
      database
        .prepare(
          `
        INSERT INTO interventions (id, session_id, product_id, action, occurred_at)
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(randomUUID(), sessionId, productId, action, now);
    },
    recordTender: ({ sessionId, method, outcome, amountCents, key, now }) => {
      database
        .prepare(
          `
        INSERT INTO tenders (id, session_id, method, outcome, amount_cents, idempotency_key, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(randomUUID(), sessionId, method, outcome, amountCents, key, now);
    },
    createReceipt: ({ sessionId, receiptNumber, totals, tenderMethod, items, now }) => {
      const receiptId = randomUUID();
      database
        .prepare(
          `
        INSERT INTO receipts
          (id, session_id, receipt_number, subtotal_cents, discount_cents, tax_cents,
           total_cents, tender_method, items_json, issued_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          receiptId,
          sessionId,
          receiptNumber,
          totals.subtotalCents,
          totals.discountCents,
          totals.taxCents,
          totals.totalCents,
          tenderMethod,
          JSON.stringify(items),
          now,
        );
    },
  };
}

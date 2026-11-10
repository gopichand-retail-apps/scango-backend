import { z } from "zod";
import { APP_VERSION } from "./app-version.mjs";

export function createRouteRegistry(service, model) {
  const emptySchema = z.object({}).strict();
  const scanSchema = z
    .object({
      barcode: z.string().trim().min(1).max(model.data.app.maximumBarcodeLength),
      source: z.enum(["barcode", "search"]).default("barcode"),
    })
    .strict();
  const scanBatchSchema = z
    .object({
      barcodes: z
        .array(z.string().trim().min(1).max(model.data.app.maximumBarcodeLength))
        .min(1)
        .max(model.data.app.maximumScanBatch),
    })
    .strict();
  const quantitySchema = z
    .object({
      productId: z.string().trim().min(1).max(64),
      delta: z
        .number()
        .int()
        .min(-model.data.app.maximumQuantity)
        .max(model.data.app.maximumQuantity)
        .refine((value) => value !== 0),
    })
    .strict();
  const couponSchema = z.object({ code: z.string().trim().max(40) }).strict();
  const weightSchema = z
    .object({
      simulatedWeightGrams: z
        .number()
        .int()
        .min(model.data.app.scaleMinimumGrams)
        .max(model.data.app.scaleMaximumGrams),
    })
    .strict();
  const interventionSchema = z
    .object({
      action: z.enum(["approve_weight", "remove_item"]),
    })
    .strict();
  const tenderSchema = z
    .object({
      method: z.enum(model.data.simulator.tenderMethods),
      outcome: z.enum(model.data.simulator.outcomes),
    })
    .strict();

  const exact = new Map([
    [
      "GET /api/v1/health",
      {
        template: "/api/v1/health",
        status: 200,
        execute: () => ({ status: "ok", service: "scango-api", storage: "sqlite" }),
      },
    ],
    [
      "GET /api/v1/version",
      {
        template: "/api/v1/version",
        status: 200,
        execute: () => ({ service: "scango-api", version: APP_VERSION }),
      },
    ],
    [
      "GET /api/v1/catalog",
      {
        template: "/api/v1/catalog",
        status: 200,
        execute: () => service.catalog(),
      },
    ],
    [
      "POST /api/v1/sessions",
      {
        template: "/api/v1/sessions",
        status: 201,
        schema: emptySchema,
        requiresIdempotency: true,
        execute: ({ key }) => service.startSession(key),
      },
    ],
  ]);

  const sessionRoutes = new Map([
    [
      "GET ",
      {
        template: "/api/v1/sessions/:sessionId",
        status: 200,
        execute: ({ sessionId }) => service.getSession(sessionId),
      },
    ],
    [
      "GET receipt",
      {
        template: "/api/v1/sessions/:sessionId/receipt",
        status: 200,
        execute: ({ sessionId }) => service.getReceipt(sessionId),
      },
    ],
    [
      "POST scan",
      {
        template: "/api/v1/sessions/:sessionId/scan",
        status: 200,
        schema: scanSchema,
        requiresIdempotency: true,
        execute: ({ sessionId, body, key }) => service.scan(sessionId, body.barcode, body.source, key),
      },
    ],
    [
      "POST scan-batch",
      {
        template: "/api/v1/sessions/:sessionId/scan-batch",
        status: 200,
        schema: scanBatchSchema,
        requiresIdempotency: true,
        execute: ({ sessionId, body, key }) => service.scanBatch(sessionId, body.barcodes, key),
      },
    ],
    [
      "POST quantity",
      {
        template: "/api/v1/sessions/:sessionId/quantity",
        status: 200,
        schema: quantitySchema,
        requiresIdempotency: true,
        execute: ({ sessionId, body, key }) => service.adjustQuantity(sessionId, body.productId, body.delta, key),
      },
    ],
    [
      "POST coupon",
      {
        template: "/api/v1/sessions/:sessionId/coupon",
        status: 200,
        schema: couponSchema,
        requiresIdempotency: true,
        execute: ({ sessionId, body, key }) => service.applyCoupon(sessionId, body.code, key),
      },
    ],
    [
      "POST weight-check",
      {
        template: "/api/v1/sessions/:sessionId/weight-check",
        status: 200,
        schema: weightSchema,
        requiresIdempotency: true,
        execute: ({ sessionId, body, key }) => service.checkWeight(sessionId, body.simulatedWeightGrams, key),
      },
    ],
    [
      "POST intervention",
      {
        template: "/api/v1/sessions/:sessionId/intervention",
        status: 200,
        schema: interventionSchema,
        requiresIdempotency: true,
        execute: ({ sessionId, body, key }) => service.intervene(sessionId, body.action, key),
      },
    ],
    [
      "POST checkout",
      {
        template: "/api/v1/sessions/:sessionId/checkout",
        status: 200,
        schema: emptySchema,
        requiresIdempotency: true,
        execute: ({ sessionId, key }) => service.prepareCheckout(sessionId, key),
      },
    ],
    [
      "POST tenders",
      {
        template: "/api/v1/sessions/:sessionId/tenders",
        status: 200,
        schema: tenderSchema,
        requiresIdempotency: true,
        execute: ({ sessionId, body, key }) => service.simulateTender(sessionId, body.method, body.outcome, key),
      },
    ],
    [
      "POST receipt",
      {
        template: "/api/v1/sessions/:sessionId/receipt",
        status: 201,
        schema: emptySchema,
        requiresIdempotency: true,
        execute: ({ sessionId, key }) => service.issueReceipt(sessionId, key),
      },
    ],
    [
      "POST reset",
      {
        template: "/api/v1/sessions/:sessionId/reset",
        status: 200,
        schema: emptySchema,
        requiresIdempotency: true,
        execute: ({ sessionId, key }) => service.resetSession(sessionId, key),
      },
    ],
  ]);
  return { exact, sessionRoutes };
}

export function resolveRoute(method, pathname, routes) {
  const exact = routes.exact.get(`${method} ${pathname}`);
  if (exact) return { route: exact, sessionId: null };
  const actionPattern = "scan-batch|scan|quantity|coupon|weight-check|intervention|checkout|tenders|receipt|reset";
  const sessionPattern = new RegExp(`^/api/v1/sessions/([0-9a-f-]{36})(?:/(${actionPattern}))?$`);
  const match = sessionPattern.exec(pathname);
  if (!match) return null;
  const action = match[2] ?? "";
  const route = routes.sessionRoutes.get(`${method} ${action}`);
  return route ? { route, sessionId: match[1] } : null;
}

import assert from "node:assert/strict";
import test from "node:test";
import { contentModelSchema } from "./content-model.schema.mjs";
import { loadModel } from "./server.mjs";

const validModel = loadModel();

test("the backend accepts the strict versioned ScanGo model", () => {
  assert.equal(contentModelSchema.safeParse(validModel).success, true);
});

test("the backend rejects missing API messages and malformed message groups", () => {
  const missingMessage = { ...validModel, messages: { ...validModel.messages } };
  delete missingMessage.messages.sessionExpired;
  const invalidErrors = {
    ...validModel,
    messages: { ...validModel.messages, errors: "invalid" },
  };
  const missingError = {
    ...validModel,
    messages: { ...validModel.messages, errors: { ...validModel.messages.errors } },
  };
  delete missingError.messages.errors.notFound;
  const missingProductCopy = { ...validModel, messages: { ...validModel.messages } };
  delete missingProductCopy.messages.welcomeTitle;
  const invalidCategoryCopy = {
    ...validModel,
    messages: { ...validModel.messages, categories: "invalid" },
  };
  const extraCategoryCopy = {
    ...validModel,
    messages: {
      ...validModel.messages,
      categories: { ...validModel.messages.categories, unknown: "Unknown" },
    },
  };
  const unknownMessage = {
    ...validModel,
    messages: { ...validModel.messages, architectureTitle: "System architecture" },
  };

  assert.equal(contentModelSchema.safeParse(missingMessage).success, false);
  assert.equal(contentModelSchema.safeParse(invalidErrors).success, false);
  assert.equal(contentModelSchema.safeParse(missingError).success, false);
  assert.equal(contentModelSchema.safeParse(missingProductCopy).success, false);
  assert.equal(contentModelSchema.safeParse(invalidCategoryCopy).success, false);
  assert.equal(contentModelSchema.safeParse(extraCategoryCopy).success, false);
  assert.equal(contentModelSchema.safeParse(unknownMessage).success, false);
});

test("the backend rejects legacy envelopes, unknown keys, and foreign endpoints", () => {
  const legacyModel = { modelVersion: 1, app: {}, copy: {} };
  const foreignApp = { ...validModel, appId: "another-app" };
  const legacyEndpoint = {
    ...validModel,
    data: { ...validModel.data, app: { ...validModel.data.app, apiBaseUrl: "http://127.0.0.1" } },
  };
  const unsupportedVersion = { ...validModel, version: 2 };
  const extraData = { ...validModel, data: { ...validModel.data, architecture: {} } };

  for (const candidate of [legacyModel, foreignApp, legacyEndpoint, unsupportedVersion, extraData]) {
    assert.equal(contentModelSchema.safeParse(candidate).success, false);
  }
});

test("the backend rejects invalid limits, catalog fixtures, coupons, and simulator options", () => {
  const product = validModel.data.products[0];
  const coupon = validModel.data.coupons[0];
  const category = validModel.data.categories[0];
  assert.ok(product && coupon && category);
  const invalidScale = {
    ...validModel,
    data: {
      ...validModel.data,
      app: { ...validModel.data.app, scaleMinimumGrams: validModel.data.app.scaleMaximumGrams + 1 },
    },
  };
  const invalidProduct = {
    ...validModel,
    data: {
      ...validModel.data,
      products: [{ ...product, image: "https://images.example/item.jpg" }, ...validModel.data.products.slice(1)],
    },
  };
  const invalidCoupon = {
    ...validModel,
    data: {
      ...validModel.data,
      coupons: [{ ...coupon, maximumDiscountCents: 0 }, ...validModel.data.coupons.slice(1)],
    },
  };
  const invalidCategory = {
    ...validModel,
    data: {
      ...validModel.data,
      categories: [{ ...category, labelKey: "" }, ...validModel.data.categories.slice(1)],
    },
  };
  const invalidSimulator = {
    ...validModel,
    data: {
      ...validModel.data,
      simulator: { ...validModel.data.simulator, noCardData: false },
    },
  };

  for (const candidate of [invalidScale, invalidProduct, invalidCoupon, invalidCategory, invalidSimulator]) {
    assert.equal(contentModelSchema.safeParse(candidate).success, false);
  }
});

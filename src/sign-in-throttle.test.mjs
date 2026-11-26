import assert from "node:assert/strict";
import test from "node:test";
import { createSignInThrottle } from "./sign-in-throttle.mjs";

test("a code is blocked after the failure limit inside the window and released after it", () => {
  const throttle = createSignInThrottle({ limit: 3, windowMs: 1000 });
  for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure("att-01", 100);

  assert.equal(throttle.isBlocked("att-01", 500), true);
  assert.equal(throttle.isBlocked("att-02", 500), false);
  assert.equal(throttle.isBlocked("att-01", 1100), false);
});

test("a fresh window starts after expiry and a success clears the count", () => {
  const throttle = createSignInThrottle({ limit: 2, windowMs: 1000 });
  throttle.recordFailure("att-01", 0);
  throttle.recordFailure("att-01", 1500);
  assert.equal(throttle.isBlocked("att-01", 1600), false);

  throttle.recordFailure("att-01", 1700);
  assert.equal(throttle.isBlocked("att-01", 1800), true);
  throttle.clear("att-01");
  assert.equal(throttle.isBlocked("att-01", 1800), false);
});

test("tracked codes stay bounded by dropping the oldest entry", () => {
  const throttle = createSignInThrottle({ limit: 1, windowMs: 60_000, maxKeys: 2 });
  throttle.recordFailure("first", 0);
  throttle.recordFailure("second", 0);
  throttle.recordFailure("third", 0);

  assert.equal(throttle.isBlocked("first", 1), false);
  assert.equal(throttle.isBlocked("second", 1), true);
  assert.equal(throttle.isBlocked("third", 1), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readRateLimit } from "./server.mjs";

test("the per-minute rate limit is a validated setting that defaults to 160", () => {
  assert.equal(readRateLimit(undefined), 160);
  assert.equal(readRateLimit("2000"), 2000);
  for (const invalid of ["", "0", "-5", "1.5", "abc", "100001"]) {
    assert.throws(() => readRateLimit(invalid), /SCANGO_RATE_LIMIT_PER_MINUTE/, String(invalid));
  }
});

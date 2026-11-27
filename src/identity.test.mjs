import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestToken, digestsEqual, hashPin, loadIdentityFixture, newAccessToken, verifyPin } from "./identity.mjs";

test("PINs are stored as salted scrypt hashes and verified in constant time", () => {
  const first = hashPin("482913");
  const second = hashPin("482913");

  assert.match(first, /^scrypt\$[\w-]+\$[\w-]+$/);
  assert.notEqual(first, second);
  assert.equal(first.includes("482913"), false);
  assert.equal(verifyPin("482913", first), true);
  assert.equal(verifyPin("482914", first), false);
  assert.equal(verifyPin("482913", "not-a-hash"), false);
  assert.equal(verifyPin("482913", "scrypt$AAAA"), false);
  assert.equal(verifyPin("482913", undefined), false);
  assert.equal(verifyPin("482913", `scrypt$$${first.split("$")[2]}`), false);
  assert.equal(verifyPin("482913", `md5$${first.split("$")[1]}$${first.split("$")[2]}`), false);
});

test("access tokens are 256-bit random values with a deterministic SHA-256 digest", () => {
  const token = newAccessToken();

  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, newAccessToken());
  assert.match(digestToken(token), /^[0-9a-f]{64}$/);
  assert.equal(digestToken(token), digestToken(token));
  assert.equal(digestsEqual(digestToken(token), digestToken(token)), true);
  assert.equal(digestsEqual(digestToken(token), digestToken("other")), false);
  assert.equal(digestsEqual(digestToken(token), "short"), false);
  assert.equal(digestsEqual(null, digestToken(token)), false);
});

test("the synthetic identity fixture lists kiosks and attendants across two locations", () => {
  const fixture = loadIdentityFixture();

  assert.equal(fixture.business, "quickstop");
  assert.deepEqual(
    fixture.kiosks.map((kiosk) => [kiosk.id, kiosk.locationId]),
    [
      ["kiosk-01", "store-01"],
      ["kiosk-02", "store-01"],
      ["kiosk-03", "store-02"],
    ],
  );
  assert.deepEqual(
    fixture.staff.map((member) => [member.code, member.locationId]),
    [
      ["att-01", "store-01"],
      ["att-02", "store-01"],
      ["att-03", "store-02"],
    ],
  );
  assert.equal(
    fixture.staff.every((member) => /^\d{6}$/.test(member.pin)),
    true,
  );
});

test("a malformed or missing identity fixture is rejected with a safe message", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scango-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const broken = join(directory, "broken.json");
  writeFileSync(broken, JSON.stringify({ business: "quickstop", kiosks: [{ id: "k" }], staff: [] }));
  const notJson = join(directory, "not-json.json");
  writeFileSync(notJson, "{");

  assert.throws(() => loadIdentityFixture(broken), /identity fixture/i);
  assert.throws(() => loadIdentityFixture(notJson), /identity fixture/i);
  assert.throws(() => loadIdentityFixture(join(directory, "missing.json")), /identity fixture/i);
});

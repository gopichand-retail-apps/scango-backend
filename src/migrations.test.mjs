import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { checkoutSchema } from "./checkout.schema.mjs";
import { migrate, SCHEMA_REVISION } from "./migrations.mjs";

function columns(database, table) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

test("migrate upgrades a database built from the original schema and is idempotent", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(checkoutSchema);
  database
    .prepare("INSERT INTO checkout_sessions (id, state, created_at, updated_at) VALUES (?, 'scanning', ?, ?)")
    .run("11111111-1111-4111-8111-111111111111", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");

  migrate(database);
  migrate(database);

  const revisions = database.prepare("SELECT revision FROM schema_revision").all();
  const legacy = database.prepare("SELECT state, token_digest, version, kiosk_id FROM checkout_sessions").get();
  assert.equal(SCHEMA_REVISION, 3);
  assert.deepEqual(
    revisions.map((row) => row.revision),
    [2, 3],
  );
  assert.deepEqual({ ...legacy }, { state: "scanning", token_digest: null, version: 0, kiosk_id: null });
  assert.deepEqual(
    ["business_id", "location_id", "kiosk_id", "token_digest", "expires_at", "version", "closed_reason"].filter(
      (name) => !columns(database, "checkout_sessions").includes(name),
    ),
    [],
  );
  assert.equal(columns(database, "idempotency_records").includes("request_fingerprint"), true);
  assert.deepEqual(
    ["staff_code", "reason_code", "session_version"].filter(
      (name) => !columns(database, "interventions").includes(name),
    ),
    [],
  );
  for (const table of ["kiosks", "audit_log", "staff_profiles", "staff_sessions"]) {
    assert.notEqual(columns(database, table).length, 0, table);
  }
  database.close();
});

test("a failed migration step rolls back every change and records no revision", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(checkoutSchema);
  database.exec("CREATE TABLE audit_log (conflicting TEXT)");

  assert.throws(() => migrate(database), /already exists/);
  assert.equal(columns(database, "checkout_sessions").includes("token_digest"), false);
  assert.equal(columns(database, "kiosks").length, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM schema_revision").get().n, 0);
  database.close();
});

test("migrate records the current revision on a freshly created database", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(checkoutSchema);
  migrate(database);

  assert.equal(
    database.prepare("SELECT MAX(revision) AS revision FROM schema_revision").get().revision,
    SCHEMA_REVISION,
  );
  database.close();
});

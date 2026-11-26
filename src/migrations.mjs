export const SCHEMA_REVISION = 2;

// Additive steps only: old code ignores the extra columns and tables, so rollback is "stop using the new build".
const steps = [
  {
    revision: 2,
    apply(database) {
      database.exec(`
        ALTER TABLE checkout_sessions ADD COLUMN business_id TEXT;
        ALTER TABLE checkout_sessions ADD COLUMN location_id TEXT;
        ALTER TABLE checkout_sessions ADD COLUMN kiosk_id TEXT;
        ALTER TABLE checkout_sessions ADD COLUMN token_digest TEXT;
        ALTER TABLE checkout_sessions ADD COLUMN expires_at TEXT;
        ALTER TABLE checkout_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE checkout_sessions ADD COLUMN closed_reason TEXT;
        ALTER TABLE idempotency_records ADD COLUMN request_fingerprint TEXT;
        CREATE TABLE kiosks (
          id TEXT PRIMARY KEY,
          business_id TEXT NOT NULL,
          location_id TEXT NOT NULL
        );
        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          action TEXT NOT NULL,
          target_session_id TEXT,
          location_id TEXT,
          result TEXT NOT NULL,
          reason_code TEXT,
          request_id TEXT
        );
        CREATE INDEX audit_log_session_idx ON audit_log(target_session_id, at);
      `);
    },
  },
];

export function migrate(database) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_revision (revision INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = database.prepare("SELECT COALESCE(MAX(revision), 1) AS revision FROM schema_revision").get().revision;
  for (const step of steps) {
    if (step.revision <= current) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      step.apply(database);
      database
        .prepare("INSERT INTO schema_revision (revision, applied_at) VALUES (?, ?)")
        .run(step.revision, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

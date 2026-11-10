export const checkoutSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    barcode TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category_id TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    unit_key TEXT NOT NULL,
    image TEXT NOT NULL,
    weight_required INTEGER NOT NULL CHECK (weight_required IN (0, 1)),
    expected_weight_grams INTEGER NOT NULL CHECK (expected_weight_grams >= 0),
    tolerance_grams INTEGER NOT NULL CHECK (tolerance_grams >= 0)
  );
  CREATE TABLE IF NOT EXISTS coupons (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
    value INTEGER NOT NULL CHECK (value > 0),
    minimum_subtotal_cents INTEGER NOT NULL CHECK (minimum_subtotal_cents >= 0),
    maximum_discount_cents INTEGER NOT NULL CHECK (maximum_discount_cents > 0),
    category_ids_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checkout_sessions (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    coupon_code TEXT,
    payment_status TEXT NOT NULL DEFAULT 'not_started',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reset_at TEXT
  );
  CREATE TABLE IF NOT EXISTS session_items (
    session_id TEXT NOT NULL REFERENCES checkout_sessions(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    weight_status TEXT NOT NULL CHECK (weight_status IN ('not_required', 'pending', 'passed', 'attention')),
    expected_weight_grams INTEGER NOT NULL CHECK (expected_weight_grams >= 0),
    tolerance_grams INTEGER NOT NULL CHECK (tolerance_grams >= 0),
    added_at TEXT NOT NULL,
    PRIMARY KEY (session_id, product_id)
  );
  CREATE TABLE IF NOT EXISTS scan_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES checkout_sessions(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    quantity_delta INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('barcode', 'search', 'quantity')),
    idempotency_key TEXT NOT NULL UNIQUE,
    occurred_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS interventions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES checkout_sessions(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    action TEXT NOT NULL CHECK (action IN ('approve_weight', 'remove_item')),
    occurred_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenders (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES checkout_sessions(id),
    method TEXT NOT NULL CHECK (method IN ('cash', 'simulated_card')),
    outcome TEXT NOT NULL CHECK (outcome IN ('approve', 'decline')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    occurred_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES checkout_sessions(id),
    receipt_number TEXT NOT NULL UNIQUE,
    subtotal_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    tender_method TEXT NOT NULL,
    items_json TEXT NOT NULL,
    issued_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS idempotency_records (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS session_items_session_idx ON session_items(session_id, added_at);
  CREATE INDEX IF NOT EXISTS tenders_session_idx ON tenders(session_id, occurred_at);
`;

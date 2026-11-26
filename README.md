# ScanGo Backend

[Architecture guide](docs/architecture.md) — source map, workflows, contracts, data, security, and checks.

## Repository layout and deployment boundary

This independent repository owns ScanGo's Node.js ESM API and authoritative SQLite state. The UI is the separate [scango-frontend](https://github.com/gopichand-retail-apps/scango-frontend) repository. Keep the current directory names, Git histories, origins, and independent builds.

The Vercel configuration belongs to the frontend only. This API has no verified Vercel deployment adapter. The local file database is not shared durable storage for stateless function instances. Do not deploy the local simulator as a public API or point it at real records.

Use Node **24.15.0**, npm, and the committed package-lock.json. From the full Retail Apps workspace, `./scripts/Start-Apps.ps1 -App ScanGo` uses the correct built/native entry after setup. With the required sibling frontend available, install with `npm.cmd ci` and start with `npm.cmd start`; no API build is needed.

Health: http://127.0.0.1:5112/api/v1/health. Direct startup stores data under `data/scango.sqlite`; the workspace launcher can select a separate app-owned path. The [API contract](openapi.yaml) and [canonical architecture](docs/architecture.md) describe the existing routes and trust boundaries. The architecture guide is inside this repository.

The API reads its seed/content contract from the adjacent frontend at `../scango-frontend/public/scango-model.json`. Clone both repositories as siblings before starting it; this existing file dependency is not a network integration. Backend configuration is read from process environment variables; creating a .env file alone does not load it.

Known release gaps: Shopper sessions are bound to a registered kiosk by an in-memory bearer token (SCN-01). Only an attendant signed in at the session's location can resolve an exception (SCN-02); identities are synthetic fixture profiles with PINs, not a production identity system. Two Windows backend tests and critical server coverage fail in the baseline. Separate IT fixes do not change this baseline.

The Node.js API owns the checkout state machine, catalog/coupon validation, price and tax calculation, and local SQLite persistence. It is the only database client in the application.

## Run

Use Node.js 22.13 or newer.

```sh
npm ci
npm start
```

The API binds to `127.0.0.1:5112`. By default it creates `data/scango.sqlite` under this package. Set `SCANGO_DB_PATH` to override the file or use `:memory:` for isolated tests. `PORT` overrides the listener port.

The server loads and validates `../scango-frontend/public/scango-model.json`.
`SCANGO_ALLOWED_ORIGINS` is a comma-separated server-side allowlist of absolute
HTTP(S) origins; local defaults are `http://127.0.0.1:5111` and
`http://localhost:5111`. Rate-limit defaults are server-owned, not content-model
settings.

## API contract

The versioned base URL is `http://127.0.0.1:5112/api/v1`; see [`openapi.yaml`](openapi.yaml).

- `GET /health`, `/catalog`
- `POST /sessions` (requires `X-Kiosk-Id` of a registered kiosk; returns `accessToken` once) and `GET /sessions/{sessionId}`
- Session actions: `POST /scan`, `/scan-batch`, `/quantity`, `/coupon`, `/weight-check`, `/intervention`, `/checkout`, `/tenders`, `/receipt`, `/reset`, and `/extend`
- Staff: `POST /staff/sessions` (`{ code, pin }`), `POST /staff/sign-out`, `GET /staff/exceptions` (location-scoped line and version only), and the attendant-only `POST /sessions/{id}/intervention` (`{ action, reasonCode, productId, expectedVersion }`) with `Authorization: Bearer <staff token>`
- Every other `/sessions/{sessionId}` route requires `Authorization: Bearer <accessToken>` and the same `X-Kiosk-Id`. A missing, wrong or other-kiosk token gets the same `404 SESSION_NOT_FOUND` as an unknown ID; an idle session returns `410 SESSION_EXPIRED`.
- `GET /sessions/{sessionId}/receipt`

State-changing requests require an `Idempotency-Key`. The repository stores replay responses and commits a state change, its scan/intervention/tender/receipt record, and its idempotency record transactionally. Each replay record carries a SHA-256 fingerprint of the request payload (SCN-03): the same key and payload replay the stored result, so a lost reply plus a retry adds exactly one unit or one tender; the same key with a different payload gets `409 IDEMPOTENCY_KEY_REUSED`; a refused request stores nothing. Scan and tender event keys are stored per session, so one client key on two sessions cannot collide. A well-formed client `X-Request-ID` is adopted for the response and the log line. Product prices and totals are read from the API-owned catalog; client totals are never accepted. CSV, PAN, CVV, bank credentials, and real payment tokens are not accepted.

Success responses use `{ "data": ... }`; errors use `{ "error": { "code", "message", "requestId" } }`. Request and trace IDs, method, route template, status, duration, and outcome are logged as JSON. Request bodies, barcode text, product names, and payment values are not included in operational logs.

## Checks

```sh
npm run format:check
npm run lint
npm run test:coverage
npm run check
npm audit
```

`npm run test:coverage` enforces 90% statements, branches, functions, and lines,
plus 95% for the checkout state machine, service, repository, routes, model
validator, server, and the access, identity and migration modules. Tests use in-memory SQLite and ephemeral ports. Playwright starts a
separate in-memory API instance, leaving the default database untouched.

## Security boundary

The service is loopback-only and checks configured browser origins when an `Origin` header is supplied. Shopper sessions are owned by the kiosk that started them: the API stores only a SHA-256 digest of a random 256-bit token, slides a 180-second idle expiry (from the content model) on each write, and clears the digest on reset. Kiosk IDs come from the synthetic fixture `fixtures/synthetic-identity.json`; there is no hardware attestation, so a declared kiosk ID plus the token is the binding. Attendants sign in at `POST /staff/sessions` with a staff code and a 6-digit synthetic PIN (scrypt-hashed when seeded; five failures per code per minute return `429`). A staff token lasts 15 idle minutes and only opens the `/staff/*` routes and `POST /sessions/{id}/intervention` for sessions at the attendant's location. The intervention needs a reason, the affected line and the current session `version`; a stale version returns `409 SESSION_VERSION_CONFLICT` with the current state, and a unique `(session, line, version)` index keeps concurrent approvals to one decision. Every sign-in, intervention, expiry and reset is written to `audit_log`. Administrator roles do not exist. Before any external or multi-user deployment, add verified identity, server-derived owner scope, role policies, TLS, managed data controls, and security review. See [security notes](docs/architecture.md#8-security-privacy-and-egress).

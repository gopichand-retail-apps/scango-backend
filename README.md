# ScanGo Backend

[Architecture guide](docs/architecture.md) — source map, workflows, contracts, data, security, and checks.

## Repository layout and deployment boundary

This independent repository owns ScanGo's Node.js ESM API and authoritative SQLite state. The UI is the separate [scango-frontend](https://github.com/gopichand-retail-apps/scango-frontend) repository. Keep the current directory names, Git histories, origins, and independent builds.

The Vercel configuration belongs to the frontend only. This API has no verified Vercel deployment adapter. The local file database is not shared durable storage for stateless function instances. Do not deploy the local simulator as a public API or point it at real records.

Use Node **24.15.0**, npm, and the committed package-lock.json. From the full Retail Apps workspace, `./scripts/Start-Apps.ps1 -App ScanGo` uses the correct built/native entry after setup. With the required sibling frontend available, install with `npm.cmd ci` and start with `npm.cmd start`; no API build is needed.

Health: http://127.0.0.1:5112/api/v1/health. Direct startup stores data under `data/scango.sqlite`; the workspace launcher can select a separate app-owned path. The [API contract](openapi.yaml) and [canonical architecture](docs/architecture.md) describe the existing routes and trust boundaries. The architecture guide is inside this repository.

The API reads its seed/content contract from the adjacent frontend at `../scango-frontend/public/scango-model.json`. Clone both repositories as siblings before starting it; this existing file dependency is not a network integration. Backend configuration is read from process environment variables; creating a .env file alone does not load it.

Known release gaps: Shopper session ownership and staff authorization are absent. Two Windows backend tests and critical server coverage fail in the baseline; receipt-only print CSS is absent. Separate IT fixes do not change this baseline.

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
- `POST /sessions` and `GET /sessions/{sessionId}`
- Session actions: `POST /scan`, `/scan-batch`, `/quantity`, `/coupon`, `/weight-check`, `/intervention`, `/checkout`, `/tenders`, `/receipt`, and `/reset`
- `GET /sessions/{sessionId}/receipt`

State-changing requests require an `Idempotency-Key`. The repository stores replay responses and commits a state change, its scan/intervention/tender/receipt record, and its idempotency record transactionally. Product prices and totals are read from the API-owned catalog; client totals are never accepted. CSV, PAN, CVV, bank credentials, and real payment tokens are not accepted.

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
plus 95% for the checkout state machine, service, repository, routes, and model
validator. Tests use in-memory SQLite and ephemeral ports. Playwright starts a
separate in-memory API instance, leaving the default database untouched.

## Security boundary

The service is loopback-only and checks configured browser origins when an `Origin` header is supplied. No shopper, attendant, or administrator authentication/authorization exists. The attendant intervention is explicitly simulated. Before any external or multi-user deployment, add verified identity, server-derived owner scope, role policies, TLS, managed data controls, and security review. See [security notes](docs/architecture.md#8-security-privacy-and-egress).

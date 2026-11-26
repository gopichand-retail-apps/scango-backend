import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApiServer } from "../src/server.mjs";

// Shared HTTP helpers for the API tests. Credentials stay in this process's memory only.
const sessionCredentials = new Map();
const sessionIdPattern = /\/sessions\/([0-9a-f-]{36})/;

export async function startApi(t, overrides = {}) {
  const api = createApiServer({ databasePath: ":memory:", ...overrides });
  await new Promise((resolveListen, rejectListen) => {
    api.server.once("error", rejectListen);
    api.server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => api.close());
  const address = api.server.address();
  return `http://127.0.0.1:${address.port}/api/v1`;
}

export function createClock(startIso = "2026-11-24T12:00:00.000Z") {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance(seconds) {
      current += seconds * 1000;
    },
  };
}

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

export function createTempDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "scango-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "scango.sqlite");
}

export function openInspector(t, databasePath) {
  const inspector = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => inspector.close());
  return inspector;
}

export function credentialHeaders(path) {
  const credentials = sessionCredentials.get(sessionIdPattern.exec(path)?.[1]);
  return credentials ? { Authorization: `Bearer ${credentials.token}`, "X-Kiosk-Id": credentials.kioskId } : {};
}

export async function startSession(baseUrl, key = "start-session-key", kioskId = "kiosk-01") {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-Kiosk-Id": kioskId,
    },
    body: "{}",
  });
  const payload = await response.json();
  if (payload.data?.accessToken) {
    sessionCredentials.set(payload.data.id, { token: payload.data.accessToken, kioskId });
  }
  return { response, payload };
}

export async function postJson(baseUrl, path, key, payload = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...credentialHeaders(path),
    },
    body: JSON.stringify(payload),
  });
}

export async function getJson(baseUrl, path) {
  return fetch(`${baseUrl}${path}`, { headers: credentialHeaders(path) });
}

export async function probeAs(baseUrl, path, token, kioskId) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(kioskId ? { "X-Kiosk-Id": kioskId } : {}),
  };
  return fetch(`${baseUrl}${path}`, { headers });
}

export async function signInStaff(baseUrl, code, pin) {
  const response = await fetch(`${baseUrl}/staff/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, pin }),
  });
  return { response, payload: await response.json() };
}

export async function staffRequest(baseUrl, path, token, { method = "GET", key, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Starts a kiosk session and drives it to attention_required with an apple weight mismatch.
export async function driveToAttention(baseUrl, prefix, kioskId = "kiosk-01") {
  const { payload } = await startSession(baseUrl, `${prefix}-start`, kioskId);
  const sessionId = payload.data.id;
  await postJson(baseUrl, `/sessions/${sessionId}/scan`, `${prefix}-scan`, {
    barcode: "QS-APL-014",
    source: "barcode",
  });
  const mismatch = await postJson(baseUrl, `/sessions/${sessionId}/weight-check`, `${prefix}-weight`, {
    simulatedWeightGrams: 1500,
  });
  const session = (await mismatch.json()).data;
  return { sessionId, version: session.version, productId: session.pendingWeight.productId };
}

export async function payAndIssueReceipt(baseUrl, sessionId, prefix) {
  await postJson(baseUrl, `/sessions/${sessionId}/checkout`, `${prefix}-checkout`);
  await postJson(baseUrl, `/sessions/${sessionId}/tenders`, `${prefix}-tender`, { method: "cash", outcome: "approve" });
  return postJson(baseUrl, `/sessions/${sessionId}/receipt`, `${prefix}-receipt`);
}

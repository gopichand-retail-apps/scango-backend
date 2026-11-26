import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const defaultFixturePath = fileURLToPath(new URL("../fixtures/synthetic-identity.json", import.meta.url));
const pinKeyLength = 32;
const identifier = z.string().regex(/^[a-z0-9-]{1,40}$/);

const fixtureSchema = z
  .object({
    synthetic: z.literal(true),
    business: identifier,
    locations: z.array(identifier).min(1),
    kiosks: z.array(z.object({ id: identifier, locationId: identifier }).strict()).min(1),
    staff: z
      .array(
        z
          .object({
            code: identifier,
            name: z.string().min(1).max(60),
            locationId: identifier,
            pin: z.string().regex(/^\d{6}$/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (fixture) => [...fixture.kiosks, ...fixture.staff].every((entry) => fixture.locations.includes(entry.locationId)),
    { message: "Every kiosk and attendant must belong to a listed location." },
  );

export function loadIdentityFixture(path = defaultFixturePath) {
  let source;
  try {
    source = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("The synthetic identity fixture is unavailable or invalid.");
  }
  const parsed = fixtureSchema.safeParse(source);
  if (!parsed.success) throw new Error("The synthetic identity fixture is unavailable or invalid.");
  return parsed.data;
}

export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, pinKeyLength);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPin(pin, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  if (salt.length === 0 || expected.length !== pinKeyLength) return false;
  return timingSafeEqual(scryptSync(String(pin), salt, pinKeyLength), expected);
}

export function newAccessToken() {
  return randomBytes(32).toString("base64url");
}

export function digestToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function digestsEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

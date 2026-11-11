import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { TokenError, verifyAccessToken } from "./claims";

const SECRET = "test-secret-with-at-least-32-characters-long";
const USER = "a0000000-0000-4000-8000-000000000001";
const NOW = 1_800_000_000;

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(
  claims: Record<string, unknown>,
  opts: { secret?: string; header?: Record<string, unknown> } = {},
): string {
  const header = b64(opts.header ?? { alg: "HS256", typ: "JWT" });
  const payload = b64(claims);
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

const good = { sub: USER, role: "authenticated", exp: NOW + 60 };

describe("verifyAccessToken", () => {
  test("accepts a valid user token and keeps the verified claims", () => {
    const verified = verifyAccessToken(token(good), SECRET, NOW);
    expect(verified.sub).toBe(USER);
    expect(verified.claims).toMatchObject(good);
  });

  test("rejects a wrong signature, an expired token, alg none, and non-user roles", () => {
    expect(() => verifyAccessToken(token(good, { secret: "other-secret" }), SECRET, NOW)).toThrow(
      TokenError,
    );
    expect(() => verifyAccessToken(token({ ...good, exp: NOW - 1 }), SECRET, NOW)).toThrow(
      /expired/,
    );
    expect(() => verifyAccessToken(token(good, { header: { alg: "none" } }), SECRET, NOW)).toThrow(
      /algorithm/,
    );
    expect(() => verifyAccessToken(token({ ...good, role: "service_role" }), SECRET, NOW)).toThrow(
      /signed-in user/,
    );
    expect(() => verifyAccessToken(token({ ...good, sub: "not-a-uuid" }), SECRET, NOW)).toThrow(
      /no user/,
    );
    expect(() => verifyAccessToken("garbage", SECRET, NOW)).toThrow(/malformed/);
  });
});

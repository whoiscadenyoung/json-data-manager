import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Server-side verification of a Supabase access token (HS256, the classic
 * self-host signing: GoTrue signs user tokens with JWT_SECRET, the same
 * secret PostgREST verifies with — docker-compose.yml). The server runner
 * never trusts a client-supplied user id: the ONLY identity it acts as is
 * the verified `sub` of a token whose signature, expiry and audience check
 * out, and the verified claims JSON is what it installs as
 * `request.jwt.claims` so `auth.uid()` and RLS behave exactly as through
 * PostgREST.
 */

export interface VerifiedClaims {
  sub: string;
  role: "authenticated";
  /** The full verified claim set, re-serialized for `request.jwt.claims`. */
  claims: Record<string, unknown>;
}

export class TokenError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("malformed token");
  }
}

function signatureMatches(signingInput: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = Buffer.from(signature, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verifies the token; throws `TokenError` on anything but a valid, unexpired `authenticated` user token. */
export function verifyAccessToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifiedClaims {
  const parts = token.split(".");
  const [header, payload, signature] = parts;
  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    throw new TokenError("malformed token");
  }
  const head = decodeJson(header);
  // Pin the algorithm: never let the token choose how it is verified.
  if (!isRecord(head) || head["alg"] !== "HS256") {
    throw new TokenError("unsupported token algorithm");
  }
  if (!signatureMatches(`${header}.${payload}`, signature, secret)) {
    throw new TokenError("bad token signature");
  }
  const claims = decodeJson(payload);
  if (!isRecord(claims)) {
    throw new TokenError("malformed token");
  }
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp <= nowSeconds) {
    throw new TokenError("token expired");
  }
  const sub = claims["sub"];
  if (typeof sub !== "string" || !UUID.test(sub)) {
    throw new TokenError("token has no user");
  }
  if (claims["role"] !== "authenticated") {
    throw new TokenError("token is not a signed-in user token");
  }
  return { sub, role: "authenticated", claims };
}

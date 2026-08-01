/**
 * Thread-scoped bearer tokens handed to a box so it can call back into /mcp.
 *
 * Stateless: `<base64url(payload)>.<base64url(hmac-sha256)>`. The payload names the
 * thread AND the box generation it was minted for, and carries an issue time that is
 * enforced on every use. So a leaked token can only ever address the thread it was
 * minted for, only while that exact box is still the thread's box, and only for
 * `THREAD_TOKEN_MAX_AGE_SECONDS` after it was issued.
 */

export interface ThreadTokenPayload {
  /** Durable Object name for the session. */
  tid: string;
  /** Box id this token was minted for. A token never outlives its box generation. */
  bid: string;
  /** Issued-at, epoch seconds. */
  iat: number;
}

/** How long a minted token stays valid. Sessions re-mint well before this. */
export const THREAD_TOKEN_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Tolerance for clock skew between mint and verify. */
const FUTURE_SKEW_SECONDS = 120;

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function mintThreadToken(
  secret: string,
  threadId: string,
  boxId: string,
  now = Date.now(),
): Promise<string> {
  const payload: ThreadTokenPayload = {
    tid: threadId,
    bid: boxId,
    iat: Math.floor(now / 1000),
  };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyThreadToken(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<ThreadTokenPayload | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", await key(secret), b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: ThreadTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as ThreadTokenPayload;
  } catch {
    return null;
  }

  if (typeof payload.tid !== "string" || !payload.tid) return null;
  if (typeof payload.bid !== "string" || !payload.bid) return null;
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return null;

  // A valid signature is not enough: an old token has to stop working eventually,
  // because it lives in a sandbox we do not control.
  const age = now / 1000 - payload.iat;
  if (age > THREAD_TOKEN_MAX_AGE_SECONDS) return null;
  if (age < -FUTURE_SKEW_SECONDS) return null;

  return payload;
}

/**
 * Constant-time-ish comparison for the plain `API_TOKEN` guard. The early length
 * check is deliberate: the length of a configured API token is not a secret, and
 * comparing unequal-length strings byte-wise would be meaningless anyway.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? (m[1] as string).trim() : null;
}

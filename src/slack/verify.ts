/** Slack request signing: https://api.slack.com/authentication/verifying-requests-from-slack */

const MAX_SKEW_SECONDS = 60 * 5;
const enc = new TextEncoder();

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySlackSignature(
  signingSecret: string,
  headers: Headers,
  rawBody: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale timestamp" };

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
  const expected =
    "v0=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return hexEqual(expected, signature) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

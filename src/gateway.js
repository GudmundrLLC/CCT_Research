// Gudmundr Gateway single sign-on (ecosystem IDP).
//
// Flow: /auth/gateway/start → Gateway /auth/login (Google, or straight back when
// the browser already has a Gateway session) → /auth/gateway/callback?token=&state=.
// The token is an RS256 JWT verified here against Gateway's JWKS (no new
// dependencies: node:crypto imports JWKs directly).
//
// Authorization is per app (identity is shared, access is not): a verified
// Gateway user gets in when their email is enrolled in `members`, listed in
// LAB_MEMBER_EMAILS, or granted `cct_research` by Gateway /svc/perms. Anyone
// else is asked for the lab passcode once, which enrolls their email.
import crypto from "node:crypto";

export const GATEWAY_URL = (process.env.GATEWAY_URL || "https://gateway.gudmundr.com").replace(/\/$/, "");
export const APP_ID = "cct_research";

let jwksCache = { at: 0, keys: [] };
const JWKS_TTL = 5 * 60 * 1000;

async function fetchJson(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs || 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: opts.headers });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function jwks(force = false) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < JWKS_TTL) return jwksCache.keys;
  const d = await fetchJson(`${GATEWAY_URL}/jwks.json`);
  jwksCache = { at: Date.now(), keys: Array.isArray(d.keys) ? d.keys : [] };
  return jwksCache.keys;
}

const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// Returns the verified claims, or throws with a short reason.
export async function verifyGatewayToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;
  const header = b64json(h);
  if (header.alg !== "RS256") throw new Error("unexpected algorithm");
  let keys = await jwks();
  let jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
  if (!jwk) { keys = await jwks(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("unknown signing key");
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  if (!ok) {
    // Gateway may have rotated its key since the cache was filled.
    const fresh = await jwks(true);
    const k2 = fresh.find((k) => k.kid === header.kid);
    const key2 = k2 && crypto.createPublicKey({ key: { kty: k2.kty, n: k2.n, e: k2.e }, format: "jwk" });
    if (!key2 || !crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key2, Buffer.from(s, "base64url"))) throw new Error("bad signature");
  }
  const claims = b64json(p);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - 30) throw new Error("token expired");
  if (typeof claims.iat === "number" && claims.iat > now + 60) throw new Error("token from the future");
  if (!claims.sub) throw new Error("token has no subject");
  return claims;
}

// Gateway-side grant (admin-managed per-app permissions). Best effort.
export async function gatewayGrants(sub) {
  try {
    const d = await fetchJson(`${GATEWAY_URL}/svc/perms/${encodeURIComponent(sub)}`, { timeoutMs: 5000 });
    return Boolean(d.is_super_admin || (d.perms && d.perms[APP_ID]));
  } catch { return false; }
}

export const allowListed = (email) =>
  (process.env.LAB_MEMBER_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean).includes(email);

export function loginUrl(origin, state) {
  const qs = new URLSearchParams({ redirect_uri: `${origin}/auth/gateway/callback`, state });
  return `${GATEWAY_URL}/auth/login?${qs}`;
}

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, hmacSha256Hex, json, verifyAccessJwt } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-gmail-oauth-start";
const REDIRECT_URI = Deno.env.get("GMAIL_OAUTH_REDIRECT_URI") ?? "https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-oauth-callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.modify",
];

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "GET") return json({ error: "GET or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const clientId = Deno.env.get("GMAIL_OAUTH_CLIENT_ID") ?? "";
  const stateSecret = Deno.env.get("CC_OAUTH_STATE_SECRET") ?? Deno.env.get("GMAIL_OAUTH_CLIENT_SECRET") ?? "";
  if (!clientId) return json({ error: "GMAIL_OAUTH_CLIENT_ID is not configured" }, 500, access.headerValue);
  if (!stateSecret) return json({ error: "CC_OAUTH_STATE_SECRET or GMAIL_OAUTH_CLIENT_SECRET is required to sign OAuth state" }, 500, access.headerValue);

  const state = await signedState(stateSecret, access.actor);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);

  return json({ consent_url: url.toString(), redirect_uri: REDIRECT_URI, state, scopes: SCOPES }, 200, access.headerValue);
});

async function signedState(secret: string, actor: string): Promise<string> {
  const payload = base64UrlString(JSON.stringify({ nonce: crypto.randomUUID(), actor, exp: Date.now() + 15 * 60_000 }));
  const sig = await hmacSha256Hex(secret, payload);
  return `${payload}.${sig}`;
}

function base64UrlString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

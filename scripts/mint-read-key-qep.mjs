#!/usr/bin/env node
// ============================================================================
// mint-read-key-qep.mjs
// One-shot JWT minter for READ_KEY_QEP.
//
// Mints a long-lived HS256 JWT with `role: "command_center"` signed by QEP's
// Supabase JWT secret. The control plane stores this as the edge-function
// secret `READ_KEY_QEP`; the Aggregator + cc-read-app-detail use it to call
// QEP's data plane under the scoped `command_center` Postgres role.
//
// Usage:
//   QEP_JWT_SECRET='<QEP Supabase JWT secret>' node scripts/mint-read-key-qep.mjs
//
// The JWT prints to stdout. Pipe it into `supabase secrets set`:
//   QEP_JWT_SECRET='...' node scripts/mint-read-key-qep.mjs \
//     | xargs -I {} supabase secrets set READ_KEY_QEP='{}' \
//         --project-ref gsvhuzpysxaegoecwjmf
//
// Or copy/paste the printed JWT manually.
//
// Rotate every 60 days. Re-run this script with the same QEP_JWT_SECRET to
// mint a fresh JWT, then `supabase secrets set` it.
//
// Do NOT commit the printed JWT. Do NOT commit QEP_JWT_SECRET to .env.
// ============================================================================

import crypto from "node:crypto";

const secret = process.env.QEP_JWT_SECRET;
if (!secret || !secret.trim()) {
  console.error("QEP_JWT_SECRET is required (export it before running).");
  console.error("Find it in the QEP Supabase project settings → API → JWT secret.");
  process.exit(1);
}

const b64url = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const QEP_PROJECT_REF =
  process.env.QEP_PROJECT_REF?.trim() || "iciddijgonywtxoelous";

const now = Math.floor(Date.now() / 1000);
const header = { alg: "HS256", typ: "JWT" };
const payload = {
  iss: "supabase",
  ref: QEP_PROJECT_REF,
  role: "command_center",
  iat: now,
  exp: now + 60 * 60 * 24 * 90, // 90 days — rotate this on a 60-day cadence
};

const unsigned = `${b64url(header)}.${b64url(payload)}`;
const signature = crypto
  .createHmac("sha256", secret)
  .update(unsigned)
  .digest("base64url");

console.log(`${unsigned}.${signature}`);

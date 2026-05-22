# QEP handoff — command_center read-only role

Target: QEP data plane (`iciddijgonywtxoelous`), not the Command Center control plane.

## 1. Apply the QEP data-plane SQL

Before applying this role grant, verify `cc_export_snapshot()` security mode per §1a. The GRANT below is safe only if `cc_export_snapshot()` runs as a definer-owned contract rather than exposing direct table access through `command_center`.

The permission contract is exactly:

```sql
CREATE ROLE command_center NOLOGIN;
GRANT command_center TO authenticator;
GRANT USAGE ON SCHEMA public TO command_center;
GRANT EXECUTE ON FUNCTION cc_export_snapshot() TO command_center;
```

Run this migration-safe form in the QEP repo as the next QEP migration:

```sql
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_center') THEN
    CREATE ROLE command_center NOLOGIN;
  END IF;
END$$;

GRANT command_center TO authenticator;
GRANT USAGE ON SCHEMA public TO command_center;
GRANT EXECUTE ON FUNCTION public.cc_export_snapshot() TO command_center;

COMMIT;
```

`GRANT command_center TO authenticator` is required so Supabase/PostgREST can switch into the JWT's `role: "command_center"` claim.

Do not grant `SELECT` on client tables to `command_center`.

## 1a. Verify (or convert) `cc_export_snapshot()` to `SECURITY DEFINER`

Run `scripts/qep-introspect.mjs` (delivered by the sibling agent in this commit) against QEP before cutover. It should inspect `pg_proc.prosecdef` for both `public.cc_export_snapshot()` and `public.cc_export_detail(text, text)` so the operator can see whether each function is `SECURITY DEFINER` (`prosecdef = true`) or `SECURITY INVOKER` (`prosecdef = false`).

If `cc_export_snapshot()` is already `SECURITY DEFINER`, no change is needed beyond the §1 GRANT:

```sql
BEGIN;

GRANT EXECUTE ON FUNCTION public.cc_export_snapshot() TO command_center;

COMMIT;
```

If `cc_export_snapshot()` is `SECURITY INVOKER`, the same QEP migration that adds the `command_center` role must also convert the function to a definer-owned contract. The owner must be a role that already has `SELECT` on the snapshot tables; do **not** grant those table reads to `command_center`.

```sql
BEGIN;

-- Use the existing QEP contract-owner role if one already owns snapshot reads.
-- Otherwise create a dedicated NOLOGIN owner and grant it only the SELECTs the
-- cc_export_snapshot() body needs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_contract_owner') THEN
    CREATE ROLE cc_contract_owner NOLOGIN;
  END IF;
END$$;

-- Example only: replace with the actual snapshot source tables/views used by QEP.
GRANT SELECT ON public.<snapshot_source_table> TO cc_contract_owner;

ALTER FUNCTION public.cc_export_snapshot() OWNER TO cc_contract_owner;
ALTER FUNCTION public.cc_export_snapshot() SECURITY DEFINER SET search_path = '';
GRANT EXECUTE ON FUNCTION public.cc_export_snapshot() TO command_center;

COMMIT;
```

After conversion, re-run `scripts/qep-introspect.mjs`; `cc_export_snapshot()` should report `prosecdef = true`.

## 2. Mint `READ_KEY_QEP`

Use QEP's Supabase JWT secret. Do not use the Command Center JWT secret. Rotate `READ_KEY_QEP` every 60 days; re-run this minting step with the same `QEP_JWT_SECRET`, then update the control-plane secret.

```bash
export QEP_JWT_SECRET='<QEP JWT secret>'

node <<'NODE'
const crypto = require('crypto');

const secret = process.env.QEP_JWT_SECRET;
if (!secret) throw new Error('QEP_JWT_SECRET is required');

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  iss: 'supabase',
  role: 'command_center',
  iat: now,
  exp: now + 60 * 60 * 24 * 90, // 90 days — rotate this on a 60-day cadence
};

const unsigned = `${b64url(header)}.${b64url(payload)}`;
const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
console.log(`${unsigned}.${signature}`);
NODE
```

Install the printed JWT on the Command Center control-plane project as `READ_KEY_QEP`:

```bash
supabase secrets set READ_KEY_QEP='<printed JWT>' --project-ref gsvhuzpysxaegoecwjmf
```

Leave `SVC_KEY_QEP` in place until the Command Center audit log proves the read-only key is being used in production.

## 3. Verify on QEP

Set these shell variables first:

```bash
export QEP_URL='https://iciddijgonywtxoelous.supabase.co'
export READ_KEY_QEP='<printed JWT>'
```

Prove the role can call the snapshot contract:

```bash
curl -sS -X POST "$QEP_URL/rest/v1/rpc/cc_export_snapshot" \
  -H "apikey: $READ_KEY_QEP" \
  -H "Authorization: Bearer $READ_KEY_QEP" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: HTTP 200 with the snapshot JSON.

Prove the role cannot read client tables directly. Replace `<client_table>` with a real QEP business table such as the first non-migration table in `public`.

```bash
curl -i -sS "$QEP_URL/rest/v1/<client_table>?select=*&limit=1" \
  -H "apikey: $READ_KEY_QEP" \
  -H "Authorization: Bearer $READ_KEY_QEP"
```

Expected: HTTP 401/403 or a PostgREST permission error. Any HTTP 200 with table rows means the role is over-granted and the migration must be fixed before cutover.

Optional database-side verification:

```sql
SET ROLE command_center;
SELECT public.cc_export_snapshot();
SELECT * FROM public.<client_table> LIMIT 1; -- must fail with permission denied
RESET ROLE;
```

## 4. Rollback

If the Command Center cannot poll with `READ_KEY_QEP`, leave QEP's role in place and let the Command Center fall back to `SVC_KEY_QEP` while debugging.

To remove the QEP role grant:

```sql
BEGIN;

REVOKE EXECUTE ON FUNCTION public.cc_export_snapshot() FROM command_center;
REVOKE USAGE ON SCHEMA public FROM command_center;
REVOKE command_center FROM authenticator;
DROP ROLE IF EXISTS command_center;

COMMIT;
```

Then unset the Command Center control-plane secret only after fallback is confirmed:

```bash
supabase secrets unset READ_KEY_QEP --project-ref gsvhuzpysxaegoecwjmf
```

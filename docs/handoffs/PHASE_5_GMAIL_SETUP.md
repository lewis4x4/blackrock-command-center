# Phase 5 Gmail setup — operator playbook

Do this after Slice 1 is deployed.

## 1. Cloud Console project

1. Sign in as `brian.lewis@blackrockai.co`.
2. Create/select project: `BlackRock AI Command Center`.
3. Enable APIs:
   - Gmail API
   - Cloud Pub/Sub API

## 2. OAuth credentials

1. APIs & Services → Credentials → Create credentials → OAuth client ID.
2. Application type: Web application.
3. Authorized redirect URI:

```text
https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-oauth-callback
```

4. Set Supabase secrets:

```bash
supabase secrets set GMAIL_OAUTH_CLIENT_ID='<client id>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set GMAIL_OAUTH_CLIENT_SECRET='<client secret>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_OAUTH_STATE_SECRET="$(openssl rand -base64 32)" --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_MAGIC_LINK_SECRET="$(openssl rand -base64 32)" --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_PUBLIC_DECISION_BASE_URL='https://blackrockai-command-center.netlify.app' --project-ref gsvhuzpysxaegoecwjmf
```

Optional, for the OAuth callback to store the refresh token automatically:

```bash
supabase secrets set SUPABASE_ACCESS_TOKEN='<Supabase personal access token>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set SUPABASE_PROJECT_REF='gsvhuzpysxaegoecwjmf' --project-ref gsvhuzpysxaegoecwjmf
```

If `SUPABASE_ACCESS_TOKEN` is not set, the callback page will show the exact `supabase secrets set GMAIL_OAUTH_REFRESH_TOKEN=...` command.

## 3. Grant Gmail consent

1. Visit:

```text
https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-oauth-start
```

2. Copy/open the `consent_url` it returns.
3. Approve Gmail scopes as `brian.lewis@blackrockai.co`.
4. Confirm `GMAIL_OAUTH_REFRESH_TOKEN` is stored.

## 4. Pub/Sub push

1. Create topic: `cc-gmail-inbound`.
2. Create a push subscription.
3. Endpoint:

```text
https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-inbound?token=<random verification token>
```

4. Set the same token:

```bash
supabase secrets set GMAIL_PUBSUB_VERIFICATION_TOKEN='<random verification token>' --project-ref gsvhuzpysxaegoecwjmf
```

5. Grant Gmail API’s publishing service account permission to publish to the topic.

## 5. Gmail watch

Configure Gmail `users.watch` for `brian.lewis@blackrockai.co` with the Pub/Sub topic and inbox label filter. Slice 1 includes the inbound handler/cursor; extraction is Slice 2.

## 6. Smoke test

1. In Apps → QEP → Decision recipients, replace placeholder `rylee@qep.com` / `ryan@qep.com` if needed.
2. Temporarily add Brian’s own email as a QEP decision recipient.
3. Open a client-owned QEP decision.
4. Click `Route to client`.
5. Wait for the Mac Studio rewrite preview.
6. Select only Brian’s test recipient and send.
7. Open the Gmail message from `Brian Lewis <brian.lewis@blackrockai.co>`.
8. Click one option.
9. On the confirm page, press `Confirm answer`.
10. Verify the decision is answered and a work order is queued or gated.

Then remove the test recipient and route the real QEP decision to Rylee + Ryan.

## Notes

- Confirm page uses the Netlify app path `/c/<token>?s=<send_id>&o=<option_id>` and calls public Supabase confirm-data/submit functions. If Cloudflare Access protects the Netlify app, add a public bypass for `/c/*` before sending real links.
- Free-text reply extraction is intentionally not in Slice 1. Inbound replies are stored as `state='replied'` only.
- Do not auto-CC Brian; Gmail sender/reply-to is already Brian.

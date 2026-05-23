# Telegram notifications setup

Outbound Telegram notifications are optional. If either `TELEGRAM_BOT_TOKEN` or `TELEGRAM_OPERATOR_CHAT_ID` is unset, `cc-telegram-notify` returns HTTP 200 with `{ "ok": true, "skipped": "telegram_disabled" }` and callers continue normally.

## 1. Create the bot

1. Open Telegram and start a chat with `@BotFather`.
2. Send `/newbot`.
3. Choose a display name and username for the bot.
4. Copy the bot token that BotFather returns. This is `TELEGRAM_BOT_TOKEN`.
5. Start a direct chat with the new bot and send any message, such as `hello`.

## 2. Get Brian's chat ID

1. Open Telegram and start a chat with `@userinfobot`.
2. Copy the numeric `Id` it returns. This is `TELEGRAM_OPERATOR_CHAT_ID`.
3. Keep this as Brian's single operator chat for F3. Group routing, quiet hours, inline keyboards, and inbound Telegram commands are out of scope for v1.

## 3. Set Supabase Edge Function env vars

The runner does not hold the Telegram bot token. Set these on the control-plane Supabase project that runs the edge functions. The notifier accepts only service-role calls or the existing server-only `CC_WRITE_TOKEN`; it does not accept the public/read token.

### Supabase CLI

```bash
supabase secrets set \
  TELEGRAM_BOT_TOKEN='<bot-token-from-BotFather>' \
  TELEGRAM_OPERATOR_CHAT_ID='<numeric-chat-id>'
```

If you are not already linked to the control-plane project, run the command from this repo after linking the project with `supabase link --project-ref gsvhuzpysxaegoecwjmf`.

### Supabase Dashboard

1. Open the control-plane project in Supabase.
2. Go to **Project Settings → Edge Functions → Secrets**.
3. Add `TELEGRAM_BOT_TOKEN`.
4. Add `TELEGRAM_OPERATOR_CHAT_ID`.
5. Redeploy or restart edge functions if the dashboard prompts you to do so.

## 4. Ensure the pg_net trigger auth token is in Vault

Migration `037_telegram_notify_on_gate.sql` reads `CC_WRITE_TOKEN` from Supabase Vault when pg_net calls `cc-telegram-notify`. If this Vault secret is not already present, add it with the same value used by the Edge Function secret:

```sql
select vault.create_secret('<existing-cc-write-token>', 'CC_WRITE_TOKEN');
```

## 5. Deploy the function and migration

```bash
supabase functions deploy cc-telegram-notify
supabase db push
```

Migration `037_telegram_notify_on_gate.sql` installs pg_net trigger hooks for:

- `work_order_gated` — high severity; pings when a gated work order appears.
- `handoff_created` — only critical severity pings; lower severities are silent.

The runner calls the same edge function for `work_order_pr_opened` after it opens a PR.

## 6. Verify manually

Use the smoke-test curl examples at the top of `supabase/functions/cc-telegram-notify/index.ts`. They require `x-cc-write-token: $CC_WRITE_TOKEN`, not the public/read token.

Expected results:

- With env vars unset: HTTP 200 and `{ "ok": true, "skipped": "telegram_disabled" }`.
- With env vars set and a valid chat: HTTP 200 and `{ "ok": true, "telegram_message_id": <number> }`.
- If Telegram returns a 4xx/5xx: HTTP 200 with `{ "ok": false, "error": ... }`; a `cc_audit_events` row is written with `event_type = 'telegram_notify_failed'`.

## 7. Troubleshooting

- **No message arrives:** confirm Brian started a chat with the bot; Telegram bots cannot initiate a first DM.
- **`chat not found`:** re-check `TELEGRAM_OPERATOR_CHAT_ID`; it should be numeric for the direct chat.
- **`telegram_disabled`:** one or both env vars are unset in Supabase Edge Function secrets.
- **Failures do not block work orders:** this is expected. Telegram is a best-effort side channel; audit rows capture failures for follow-up.
- **pg_net trigger returns 401:** confirm the `CC_WRITE_TOKEN` Vault secret exists and matches the Edge Function `CC_WRITE_TOKEN` secret.

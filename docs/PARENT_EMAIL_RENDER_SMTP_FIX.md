# Parent email delivery on Render Free

Production diagnosis (27 November 2026): two failed test deliveries at
03:42 and 03:44 UTC reached `parent_email_notification_service` and raised
`EmailTransportRetryable`. Render Dashboard confirms the Free instance,
`EMAIL_PROVIDER=auto`, SMTP credentials configured, and no Resend key.
Render Free blocks SMTP ports 25/465/587; switching Gmail between 465 and
587 does not resolve it.

## Prepared fix

The backend can now use `EMAIL_PROVIDER=vercel_relay`. It posts the existing
MIME message over HTTPS to the small Python function
`frontend/api/parent-email-relay.py`. Vercel opens the TLS connection to Gmail
on port 465. Python standard library only; no npm dependency was added.
Existing Supabase verification, ownership, delivery records, preferences,
quiet hours, weekly limits and workers remain in the backend.

The relay requires an HMAC-SHA256 signature over `timestamp + '.' + MIME`;
requests expire after 60 seconds. It accepts one recipient, restricts the
sender to the configured mailbox, refuses Cc/Bcc/Resent headers, caps messages
at 256 KiB, verifies TLS and never logs credentials, recipients or SMTP errors.
Backend accepts success only after HTTP 200 with `status=SENT`; redirects and
HTML responses never count as delivery. The function awaits SMTP completion.
HMAC is authentication, not durable replay deduplication; existing delivery
claims remain on Render. As with the existing SMTP provider, a lost response
after Gmail accepts a message can leave delivery outcome ambiguous.

## Configuration after review and deployment approval

Vercel **Production**, server-only environment variables:

- `EMAIL_RELAY_SECRET`: fresh random secret, at least 32 characters.
- `SMTP_USERNAME`, `SMTP_APP_PASSWORD`, `SMTP_FROM_EMAIL`: existing Gmail
  sending credentials, entered directly in the hosting Dashboard.

Render:

- `EMAIL_PROVIDER=vercel_relay`
- `EMAIL_RELAY_URL=https://viread-frontend.vercel.app/api/parent-email-relay`
- `EMAIL_RELAY_SECRET`: the same secret as Vercel.
- Keep `EMAIL_FROM_ADDRESS` set to that same Gmail sender (display name allowed).

Deploy Vercel first. Verify an unsigned POST returns 401 and the Python
function appears in the deployment's functions list. Then deploy/configure
Render and send a test from an account whose verified email is a real mailbox
you control. A provider acceptance response does not prove inbox receipt;
confirm inbox/spam manually. Do not test by sending to placeholder addresses.

No deployment, credential copying, paid service, account creation or production
database migration is included in this local patch. Rollback: restore the
previous provider; existing SMTP/Resend implementations remain available.

Sources:

- https://render.com/docs/free
- https://vercel.com/kb/guide/serverless-functions-and-smtp
- https://vercel.com/docs/functions/runtimes/python/api-directory

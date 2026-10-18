# Social login setup: Google and Facebook

The login page now supports Google and Facebook through the existing Supabase Auth client. OAuth accounts use the same `auth.users` identity and `public.profiles` role policy as email/password accounts. No `email` column is added to `public.profiles`; Supabase Auth remains the source of truth for email addresses.

## 1. Apply the database migration

Apply `supabase/migrations/20261018100000_require_email_for_auth_users.sql` to the same Supabase project used by ReadAlong. For a linked Supabase CLI project, use the team's normal migration workflow (for example, `supabase db push`); otherwise review and run the migration in the Supabase SQL Editor.

The existing profile trigger rejects creation of a new Auth user without an email and uses provider display-name metadata when available. It does not rewrite existing accounts or profile roles.

## 2. Configure Supabase Auth

In **Supabase Dashboard → Authentication → URL Configuration**, add each app callback URL to the redirect allow list:

- Local: `http://localhost:3000/auth/callback`
- Production: `https://YOUR-APP-DOMAIN/auth/callback`

Replace the production example with the real HTTPS domain. Keep the Supabase project's Site URL set to the production app URL.

In **Authentication → Sign In / Providers**, enable Google and Facebook and store their OAuth Client ID and Client Secret in Supabase. Never put provider secrets in `NEXT_PUBLIC_*` variables or frontend source.

## 3. Google provider

Create a Web OAuth Client in Google Cloud Console. Add the Supabase provider callback URI shown in the Supabase provider panel to the Google OAuth client's authorized redirect URIs. Configure the OAuth consent screen for the app's deployment state, then copy the client ID and secret into the Supabase Google provider settings.

## 4. Facebook provider (email is required)

In Meta for Developers:

1. Configure Facebook Login for the app.
2. Add the exact Supabase callback URI from **Supabase → Authentication → Sign In / Providers → Facebook** to Facebook Login's valid OAuth redirect URIs.
3. Enable the `email` permission and `public_profile` in the Facebook login use case, and complete Meta review/publishing requirements for the app's audience.
4. Add the Facebook App ID and App Secret to Supabase's Facebook provider settings.

Facebook only returns email when the account has an email address that Facebook can share and the app has the required email permission. ReadAlong requests the email scope and checks the returned Supabase Auth user. If email is missing, the callback signs out the session and sends the user back to login with an actionable message. The database trigger also prevents a new Auth account without email.

## 5. Verify

- Google sign-in creates/uses a Supabase Auth user and a `profiles` row, then routes by `profiles.role`.
- Facebook sign-in with email follows the same flow.
- Facebook without a returned email is rejected and cannot access protected pages.
- Parent accounts route to `/dashboard`; admin accounts route to `/admin/books`.
- Email/password login and password recovery continue to use their existing flows.

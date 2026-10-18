# Supabase Phone Authentication Setup

This project uses Supabase Auth for both email/password and phone/password authentication. Phone signup requires a real SMS provider and phone confirmation enabled; the application does not generate or validate OTPs itself.

## Supabase Dashboard checklist

1. Open **Authentication → Sign In / Providers** (the section name may vary by Dashboard version) and enable **Phone**.
2. Require phone confirmation for newly registered phone accounts. The app deliberately rejects a phone-signup response that unexpectedly contains a session before OTP verification, which often indicates phone confirmation is disabled.
3. Configure an SMS provider supported by your Supabase project, such as Twilio, and provide credentials only in the Supabase Dashboard/secret configuration.
4. Review OTP expiration, SMS rate limits, CAPTCHA and abuse protection before production rollout.
5. Configure the project Site URL and allowed redirect URLs, including `/login?auth_callback=signup`, the password reset route, and `/auth/callback` for OAuth.

## User flows

- Email only: Supabase email/password signup and the existing email-confirmation callback.
- Phone only: Supabase phone/password signup → real SMS OTP → `verifyOtp({ phone, token, type: "sms" })`.
- Email and phone: phone is the initial Auth identity. After SMS confirmation, the app requests email linking on that same authenticated user; Supabase sends its own email-change confirmation. An email that has not been confirmed must not be represented as confirmed by the app.
- Login: Supabase `signInWithPassword` receives either `email` or `phone`, never both.
- Phone password recovery: an SMS OTP is requested with `shouldCreateUser: false`; password change is allowed only after Supabase verifies the OTP for the same normalized phone number.

## Database compatibility

Apply migration `20261018120000_allow_phone_only_auth_users.sql` to Supabase after the earlier migration that required an email. It removes the email-only guard from the Auth user trigger while preserving creation of `public.profiles` with the same Auth user ID, `parent` role and display name. Review the migration before applying it to production. The application profile is keyed by the Supabase Auth user ID and stores application profile/role information. Contact identifiers remain authoritative in Supabase Auth. Do not add a fake email for phone-only users, do not manually write to `auth.users`, and do not store OTPs in the application database.

## Verification limits

Unit tests using a mocked Supabase client do not prove SMS delivery or live OTP confirmation. A live test requires a properly configured Supabase project and SMS provider. Never copy provider secrets or service-role keys into frontend variables or Git.

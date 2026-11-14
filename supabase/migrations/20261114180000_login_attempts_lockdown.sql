-- Close the direct write path to login_attempts. Attempts are now recorded only through
-- record_login_attempt() (20261114160000), which validates the email and rate-caps per email.
-- Apply only after the client that calls record_login_attempt() is deployed.
drop policy "anon can record login attempts" on public.login_attempts;
revoke insert on public.login_attempts from anon, authenticated;

-- DEV APP Customer: tighten function privileges (defence in depth).
-- Postgres grants EXECUTE on new functions to PUBLIC, so the earlier "revoke ... from anon" did not take effect.
-- Every workflow function already rejects callers without a DEV APP role; this also stops anonymous callers
-- from invoking them at all. Only the published-layout reader stays open to anon (the customer app needs it).

revoke execute on function
  public.customer_app_apply(uuid),
  public.customer_app_review(uuid, boolean, text),
  public.customer_app_deploy(uuid, text),
  public.customer_app_rollback(uuid, text),
  public.customer_app_staff(),
  public.customer_app_set_role(uuid, text),
  public.customer_app_my_role(),
  public.customer_app_role(),
  public.customer_app_can(text),
  public.customer_app_current_email(),
  public.customer_app_validate(jsonb)
from public, anon;

grant execute on function
  public.customer_app_apply(uuid),
  public.customer_app_review(uuid, boolean, text),
  public.customer_app_deploy(uuid, text),
  public.customer_app_rollback(uuid, text),
  public.customer_app_staff(),
  public.customer_app_set_role(uuid, text),
  public.customer_app_my_role(),
  public.customer_app_role(),
  public.customer_app_can(text),
  public.customer_app_current_email(),
  public.customer_app_validate(jsonb)
to authenticated;

grant execute on function public.get_published_customer_layout(text) to anon, authenticated;

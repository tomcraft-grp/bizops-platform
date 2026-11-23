-- The PromptPay QR at checkout (pay first).
--
-- Why: the shop asks for the transfer slip WITH the order (shop_settings.require_payment_slip), but the only function that makes a payment QR
-- (finance_request_payment) needs an invoice, and the invoice is created by the order. So a customer could never see a QR before ordering, and after ordering
-- there was nothing left to pay. This function closes that gap: the QR for the cart the customer is about to order.
--
-- What it does: prices the cart with the SAME function that prices the order (shop_quote_internal) and puts that total into the shop's own QR with the SAME
-- function the invoice QR uses (finance_qr_with_amount). The caller sends only SKU + quantity; it can never choose the amount or the receiving account.
--
-- What it does not do: it writes nothing (STABLE), it reserves nothing, it is not a payment request and it settles nothing. The slip sent with the order is
-- checked by staff exactly as before. No table, policy or existing function changes. Rollback: supabase/rollbacks/20261123100000_checkout_qr_down.sql.

create or replace function public.shop_checkout_qr(p_items jsonb, p_fulfilment text default 'delivery')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q jsonb; acct public.finance_payment_accounts; v_total numeric;
begin
  perform public.shop_require_user();
  if not (select s.shop_open from public.shop_settings s where s.id) then raise exception 'SHOP_CLOSED'; end if;
  q := public.shop_quote_internal(p_items, p_fulfilment);
  if not (q ->> 'ok')::boolean then raise exception 'CART_INVALID' using detail = (q -> 'problems')::text; end if;
  select * into acct from public.finance_payment_accounts where is_default and active;
  if not found then raise exception 'NO_PAYMENT_ACCOUNT'; end if;
  v_total := (q ->> 'total')::numeric;
  return jsonb_build_object('amount', v_total, 'qr_payload', public.finance_qr_with_amount(acct.qr_payload, v_total),
    'account_label', acct.label, 'merchant_name', acct.merchant_name);
end $$;
revoke execute on function public.shop_checkout_qr(jsonb, text) from public, anon;
grant execute on function public.shop_checkout_qr(jsonb, text) to authenticated;

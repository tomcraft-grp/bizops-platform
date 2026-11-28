-- Rollback of 20261128140000_line_card_map.sql: line_card_data returns what it returned before (no "delivery" key).
CREATE OR REPLACE FUNCTION public.line_card_data(p_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.shop_orders; e public.finance_payment_evidence; s public.line_settings; n int; q jsonb; v_bank text; v_method text;
begin
  select * into o from public.shop_orders where id = p_order;
  if not found then return null; end if;
  select * into s from public.line_settings where id;
  select * into e from public.finance_payment_evidence where invoice_id = o.invoice_id and source = 'customer_slip' and status <> 'rejected'
    order by created_at desc, id desc limit 1;
  select count(*) into n from public.shop_order_items where order_id = o.id;
  v_method := case when o.payment_pref = 'wallet' then 'wallet' when o.payment_pref = 'qr' then 'qr' when o.payment_pref like 'bank:%' or e.id is not null then 'transfer' else 'unpaid' end;
  v_bank := coalesce((select b.code from public.finance_bank_accounts b where b.id = e.bank_account_id), case when o.payment_pref like 'bank:%' then substr(o.payment_pref, 6) end);
  q := public.line_quick_check(o.id);
  return jsonb_build_object(
    'order_id', o.id, 'order_no', o.order_no, 'customer_name', o.contact_name, 'phone', o.contact_phone, 'created_at', o.created_at,
    'item_count', (select coalesce(sum(qty), 0) from public.shop_order_items where order_id = o.id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', it.name, 'qty', it.qty, 'price', it.unit_price,
               'image', (select public.shop_image_url(c.image_paths[1]) from public.shop_sku_content c where c.sku_code = it.sku_code)) order by it.line_no)
             from (select * from public.shop_order_items where order_id = o.id order by line_no limit 3) it), '[]'::jsonb),
    'more_count', greatest(n - 3, 0),
    'total', o.total, 'fulfilment', o.fulfilment, 'order_type', o.order_type, 'pickup_at', o.pickup_at,
    'payment', jsonb_build_object('method', v_method, 'bank', v_bank, 'has_slip', e.id is not null, 'transfer_at', e.claimed_transfer_at, 'evidence_id', e.id),
    'status', o.status, 'quick', jsonb_build_object('ok', (q ->> 'ok')::boolean, 'why', q ->> 'why'), 'app_url', s.app_url);
end $function$;

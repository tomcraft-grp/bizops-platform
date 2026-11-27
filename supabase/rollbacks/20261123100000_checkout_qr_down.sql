-- Rolls back 20261123100000_checkout_qr.sql: the function goes away, nothing else changes. It stores nothing, so there is nothing to guard or to lose.
-- An app that still asks for it shows "the QR could not be loaded" with the other payment methods available.
drop function if exists public.shop_checkout_qr(jsonb, text);

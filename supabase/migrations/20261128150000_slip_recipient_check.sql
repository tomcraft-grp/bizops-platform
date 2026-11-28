-- The receiver of a payment slip becomes a critical check, verification gets three outcomes, and staff feedback is recorded and measured.
-- Builds on 20261120100000_slip_review.sql, 20261124100000_slip_check_customer.sql and 20261124110000_own_slip_reader.sql. Guide: docs/slip-recipient-check.md.
--
-- What changes, and what does not:
--   * NOTHING here confirms, posts or rejects a payment. "verified" is a verdict on what the picture shows; a person still checks the bank record (Confirm, then Post), exactly as before.
--   * The receiver is critical: a receiver that is clearly not the shop is "rejected" whatever the confidence; one that cannot be read, or only nearly matches, is "review_required".
--   * The own reader no longer finds the shop's name ANYWHERE in the text (a name in the sender's line or in a memo passed). It takes the receiver from its place on the slip.
--   * Authorized recipients are the names of the shop's active accounts (finance_bank_accounts, the default finance_payment_accounts) plus spellings a manager approved
--     (finance_slip_name_variants). Learning PROPOSES spellings from staff corrections on slips the bank confirmed; it never adds one by itself.
--   * Existing analyses are not rewritten (the table is append-only). New columns are empty for them; reports compute their outcome from their stored reasons.
-- Rollback: supabase/rollbacks/20261128150000_slip_recipient_check_down.sql.

-- ================================================================================================= 1 names: tidy, compare, distance
-- 1a how a name is written down before it is compared: NFC, sara am that OCR splits into two characters, no zero-width marks, one space, lower case
create or replace function public.finance_name_tidy(p text)
returns text language sql immutable set search_path = public as $$
  select lower(btrim(regexp_replace(regexp_replace(regexp_replace(normalize(coalesce(p, ''), NFC),
           E'ํา', E'ำ', 'g'), E'[​-‏﻿]', '', 'g'), E'[\\s ]+', ' ', 'g')))
$$;

-- 1b one leading title (Thai and English), with or without a space after it
create or replace function public.finance_name_untitle(p text)
returns text language sql immutable set search_path = public as $$
  select btrim(regexp_replace(public.finance_name_tidy(p), '^(นางสาว|นาง|นาย|น\.\s*ส\.?|นส\.|ด\.\s*ช\.?|ด\.\s*ญ\.?|คุณ|(mrs|mr|ms|miss|dr)(\.\s*|\s+))\s*', ''))
$$;

-- 1c the comparable key: no spaces, dots, dashes, quotes or mask characters
create or replace function public.finance_name_key(p text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(coalesce(p, ''), '[\s.,''"_*•·×:;()\-]+', '', 'g')
$$;

-- 1d the distance between two keys, weighted for what OCR does to Thai: a tone or vowel mark lost or added costs 0.5, a letter read as a look-alike costs 0.5, anything else 1
create or replace function public.finance_name_dist(a text, b text)
returns numeric language plpgsql immutable set search_path = public as $$
declare
  x text[] := regexp_split_to_array(coalesce(a, ''), ''); y text[] := regexp_split_to_array(coalesce(b, ''), '');
  n int := coalesce(array_length(x, 1), 0); m int := coalesce(array_length(y, 1), 0);
  prev numeric[]; cur numeric[]; i int; j int; c numeric;
  -- pairs of Thai letters that the reader confuses (both orders)
  look text[] := array['รธ', 'ลส', 'ดค', 'บป', 'ขช', 'ภถ', 'พฟ', 'ผฝ', 'ผพ', 'ฝฟ', 'ทฑ', 'ณฌ', 'ซช', 'ฎฏ', 'ศส', 'ฐร', 'มน', 'อฮ', 'วร', 'ยข'];
begin
  if a = b then return 0; end if;
  if n = 0 then return m; end if; if m = 0 then return n; end if;
  if n > 80 or m > 80 then return greatest(n, m); end if;
  prev := array[0]::numeric[];
  for j in 1..m loop prev := prev || (prev[j] + case when y[j] ~ E'[ัิ-ฺ็-๎]' then 0.5 else 1 end); end loop;
  for i in 1..n loop
    cur := array[prev[1] + case when x[i] ~ E'[ัิ-ฺ็-๎]' then 0.5 else 1 end]::numeric[];
    for j in 1..m loop
      c := case when x[i] = y[j] then 0 when (x[i] || y[j]) = any (look) or (y[j] || x[i]) = any (look) then 0.5
                when x[i] ~ E'[ัิ-ฺ็-๎]' and y[j] ~ E'[ัิ-ฺ็-๎]' then 0.5 else 1 end;
      cur := cur || least(prev[j + 1] + case when x[i] ~ E'[ัิ-ฺ็-๎]' then 0.5 else 1 end,
                          cur[j] + case when y[j] ~ E'[ัิ-ฺ็-๎]' then 0.5 else 1 end,
                          prev[j] + c);
    end loop;
    prev := cur;
  end loop;
  return prev[m + 1];
end $$;

-- 1e the parts of a name as read: first name key, the rest, whether the rest is masked by the bank ("อ.", "อ***", "อยู่xxx", "TE"), and the visible start of a masked surname
create or replace function public.finance_name_parts(p text)
returns jsonb language plpgsql immutable set search_path = public as $$
declare v text := public.finance_name_untitle(p); t text[]; rest text; masked boolean; pre text;
begin
  if v = '' then return jsonb_build_object('key', '', 'first', '', 'rest', '', 'masked', false, 'prefix', '', 'script', 'none'); end if;
  t := regexp_split_to_array(v, ' ');
  rest := btrim(array_to_string(t[2:], ' '));
  masked := rest <> '' and (rest ~ '^[^\s0-9]{0,8}[x×*•·.]+$' or length(public.finance_name_key(rest)) between 1 and 2);
  pre := case when masked then public.finance_name_key(regexp_replace(rest, '[x×*•·.]+$', '')) else '' end;
  return jsonb_build_object('key', public.finance_name_key(v), 'first', public.finance_name_key(t[1]), 'rest', public.finance_name_key(rest), 'masked', masked, 'prefix', pre,
    'script', case when v ~ '[ก-๛]' then 'thai' when v ~ '[a-z]' then 'latin' else 'none' end);
end $$;

-- ================================================================================================= 2 who may be paid: accounts and approved spellings
-- 2a spellings a manager approved for the holder of one of the shop's accounts: the English spelling a bank prints, another legal spelling, or what the reader keeps reading
--    (an OCR variant). Rows are never deleted; a retired one stops counting. Written only by the functions of section 6.
create table if not exists public.finance_slip_name_variants (
  id uuid primary key default gen_random_uuid(),
  holder_name text not null constraint finance_slip_name_variants_holder_chk check (length(holder_name) between 3 and 120),
  variant text not null constraint finance_slip_name_variants_variant_chk check (length(variant) between 3 and 120),
  variant_key text not null,
  kind text not null constraint finance_slip_name_variants_kind_chk check (kind in ('spelling', 'english', 'ocr')),
  source text not null default 'manager' constraint finance_slip_name_variants_source_chk check (source in ('manager', 'learned')),
  status text not null default 'active' constraint finance_slip_name_variants_status_chk check (status in ('active', 'retired')),
  impact jsonb not null default '{}'::jsonb,                                                          -- what the past readings said about this spelling when it was approved
  note text constraint finance_slip_name_variants_note_chk check (note is null or length(note) <= 300),
  created_by uuid, created_at timestamptz not null default now(),
  retired_by uuid, retired_at timestamptz,
  retire_reason text constraint finance_slip_name_variants_retire_chk check (retire_reason is null or length(retire_reason) <= 300)
);
create unique index if not exists finance_slip_name_variants_active_key on public.finance_slip_name_variants (variant_key) where status = 'active';

create or replace function public.finance_guard_name_variant()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'A recipient spelling is never deleted: retire it'; end if;
  if old.status = 'retired' then raise exception 'A retired recipient spelling is never changed'; end if;
  if (new.holder_name, new.variant, new.variant_key, new.kind, new.source, new.impact, new.created_by, new.created_at) is distinct from
     (old.holder_name, old.variant, old.variant_key, old.kind, old.source, old.impact, old.created_by, old.created_at) then
    raise exception 'Only the status of a recipient spelling can change'; end if;
  return new;
end $$;
drop trigger if exists finance_slip_name_variants_guard on public.finance_slip_name_variants;
create trigger finance_slip_name_variants_guard before update or delete on public.finance_slip_name_variants for each row execute function public.finance_guard_name_variant();

alter table public.finance_slip_name_variants enable row level security;
drop policy if exists "finance name variants: staff" on public.finance_slip_name_variants;
create policy "finance name variants: staff" on public.finance_slip_name_variants for select to authenticated using (public.finance_can('view'));
revoke all on public.finance_slip_name_variants from anon, authenticated;
grant select on public.finance_slip_name_variants to authenticated;

-- 2b every name a slip may show as its receiver, with the holder it belongs to and the account digits (bank accounts and the default payment account; the alternative name
--    of the payment account; approved spellings whose holder still has an active account)
create or replace function public.finance_slip_holders()
returns table (holder text, name text, digits text, src text) language sql stable security definer set search_path = public as $$
  with acc as (
    select b.account_name as holder, b.account_name as name, b.account_no as digits, 'account'::text as src from public.finance_bank_accounts b where b.active and nullif(btrim(b.account_name), '') is not null
    union all
    select a.merchant_name, a.merchant_name,
           case when a.target_type = 'phone' and a.target like '0066%' then '0' || substr(a.target, 5) else nullif(regexp_replace(a.target, '[^0-9]', '', 'g'), '') end, 'account'
      from public.finance_payment_accounts a where a.is_default and a.active and nullif(btrim(a.merchant_name), '') is not null
  )
  select * from acc
  union all
  select a.merchant_name, a.slip_name_alt, null, 'alt' from public.finance_payment_accounts a
   where a.is_default and a.active and a.slip_name_alt is not null and nullif(btrim(a.merchant_name), '') is not null
  union all
  select v.holder_name, v.variant, null, v.kind from public.finance_slip_name_variants v
   where v.status = 'active' and exists (select 1 from acc where public.finance_name_key(public.finance_name_untitle(acc.holder)) = public.finance_name_key(public.finance_name_untitle(v.holder_name)))
$$;
revoke execute on function public.finance_slip_holders() from public, anon, authenticated;

-- ================================================================================================= 3 the receiver: one candidate, then all of them
-- 3a one name (and the account digits printed next to it) against every holder. verdict:
--   match    the name is one of ours: the same after tidying (spaces, titles, sara am), a surname the bank masked or cut whose visible start agrees, or an approved spelling;
--            or the visible digits are ours (an ordered subsequence of one of our accounts, as before)
--   partial  only our first name is there, nothing after it
--   near     one or two letters away from one of our names (the reader may have misread it, or it is someone else): a person decides
--   conflict the name is clearly someone else's but the visible digits look like one of our accounts: a person decides
--   other    a name of the same script that is none of ours, or digits that are none of ours
--   none     nothing that can be compared
create or replace function public.finance_recipient_match(p_name text, p_digits text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c jsonb := public.finance_name_parts(p_name); h record; n jsonb; v_best int := 0; v_verdict text := 'none'; v_method text; v_holder text; v_dist numeric; d numeric;
  v_digits text := left(regexp_replace(coalesce(p_digits, ''), '[^0-9]', '', 'g'), 20); v_dig text := 'none'; v_cmp boolean := false; k text := c ->> 'key';
begin
  for h in select * from public.finance_slip_holders() loop
    -- the digits, exactly the rule of 20261120100000 (3 or more visible digits, in order, within one of our accounts)
    if length(v_digits) >= 3 and h.digits is not null and v_dig <> 'match' then
      v_dig := case when length(v_digits) <= length(h.digits) and h.digits ~ regexp_replace(v_digits, '(.)', '\1[0-9]*', 'g') then 'match' else 'other' end;
      if v_dig = 'match' then v_holder := coalesce(v_holder, h.holder); end if;
    end if;
    if length(k) < 3 or h.name is null then continue; end if;
    n := public.finance_name_parts(h.name);
    if (c ->> 'script') <> (n ->> 'script') then continue; end if;                            -- a Latin name is never compared with a Thai one
    v_cmp := true;
    if k = n ->> 'key' then d := 0; if v_best < 4 then v_best := 4; v_verdict := 'match'; v_method := case when h.src = 'account' then 'exact' else 'variant' end; v_holder := h.holder; v_dist := 0; end if;
    elsif ((c ->> 'masked')::boolean and c ->> 'first' = n ->> 'first' and length(c ->> 'prefix') >= 1 and position(c ->> 'prefix' in n ->> 'rest') = 1)
       or (length(k) > length(n ->> 'first') and length(n ->> 'rest') > 0 and position(k in n ->> 'key') = 1) then
      if v_best < 3 then v_best := 3; v_verdict := 'match'; v_method := case when h.src = 'account' then 'masked' else 'variant_masked' end; v_holder := h.holder; v_dist := 0; end if;
    elsif k = n ->> 'first' and (c ->> 'rest') = '' then
      if v_best < 2 then v_best := 2; v_verdict := 'partial'; v_method := 'first_name'; v_holder := h.holder; v_dist := null; end if;
    else
      d := case when (c ->> 'masked')::boolean
                then public.finance_name_dist(c ->> 'first', n ->> 'first') + public.finance_name_dist(c ->> 'prefix', left(n ->> 'rest', length(c ->> 'prefix')))
                else public.finance_name_dist(k, n ->> 'key') end;
      if d <= 2 and v_best < 2 then v_best := 2; v_verdict := 'near'; v_method := 'distance'; v_holder := h.holder; v_dist := d;
      elsif d <= 2 and v_verdict = 'near' and d < v_dist then v_holder := h.holder; v_dist := d; end if;
    end if;
  end loop;
  if v_verdict = 'none' and v_cmp and length(k) >= 4 then v_verdict := 'other'; end if;
  -- either the name or the digits is enough (as before), with one exception: a name that is clearly someone else's beside digits that look like ours is a CONFLICT for a person
  -- (a few visible digits of a masked number match many accounts; the name is the stronger evidence). Digits that are not ours never outweigh a name that is ours.
  return jsonb_build_object('verdict', case when v_verdict = 'other' and v_dig = 'match' then 'conflict' when v_verdict = 'match' or v_dig = 'match' then 'match'
                                            when v_verdict in ('partial', 'near') then v_verdict when v_verdict = 'other' or v_dig = 'other' then 'other' else 'none' end,
    'name_verdict', v_verdict, 'digits_verdict', v_dig,
    'method', case when v_verdict = 'other' and v_dig = 'match' then 'conflict' when v_verdict = 'match' then v_method when v_dig = 'match' then 'account' else v_method end,
    'holder', case when v_verdict in ('match', 'partial', 'near') or v_dig = 'match' then v_holder end, 'distance', v_dist);
end $$;
revoke execute on function public.finance_recipient_match(text, text) from public, anon, authenticated;

-- 3b the receiver of a slip from its text, by its PLACE on the slip, never by searching the whole text (the sender's name, a memo or a note must not count):
--    1. after a receiver label AT THE START of a line (ไปยัง, ถึง, ผู้รับ, To, ...; a label word inside a name or a memo is not a label): the rest of that line, or the next line
--       when the label stands alone;
--    2. without a label: Thai slips print the sender first and the receiver second, so with exactly two lines that start with a title, the second one.
--    The name ends at the first character no name has (OCR prints the QR beside it as "-= เล", "[ต]", digits); a short stray word after a full name is dropped.
--    The account digits are the masked number on the same line or the line after it. The text holds the reader's passes separated by a form feed (chr 12); one candidate per pass.
create or replace function public.finance_recipient_candidates(p_text text)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  pass text; lines text[]; ln text; i int; nm text; acct text; how text; out jsonb := '[]'::jsonb; titled int[]; k int; v_lab text; t text[];
  -- (the RE is greedy in PostgreSQL: the longest label wins, "ผู้รับเงิน" before "ผู้รับ")
  lab text := '^([^ก-๛a-z]*((โอน(เงิน)?|ชื่อ(บัญชี)?)\s*)?(ไปยัง|ไปที่|ถึง|ผู้รับเงิน|ผู้รับโอน|ชื่อผู้รับ|ผู้รับ|บัญชีปลายทาง|ปลายทาง|โอนให้|โอนเข้า|เข้าบัญชี|to\M|receiver|recipient|payee|beneficiary))';
  acc_re text := '([x×*•0-9][x×*•0-9 -]{4,}[0-9][x×*•0-9-]*)';
begin
  foreach pass in array string_to_array(left(coalesce(p_text, ''), 12000), chr(12)) loop
    select coalesce(array_agg(t.l order by t.o), '{}') into lines
      from (select public.finance_name_tidy(x) as l, o from unnest(string_to_array(pass, chr(10))) with ordinality as u(x, o)) t where t.l <> '';
    nm := null; acct := null; how := null; k := null;
    for i in 1..coalesce(array_length(lines, 1), 0) loop
      ln := lines[i];
      if ln ~* '^(จาก|ผู้โอน|from|sender)' or ln !~* lab then continue; end if;
      v_lab := substring(ln from lab);                                                                   -- (the first group: everything up to the end of the label)
      nm := btrim(substr(ln, length(v_lab) + 1), ' :：-');
      if nm !~ '[ก-ฮa-z].*[ก-ฮa-z]' or nm ~ '^[x×*•0-9]' then
        acct := substring(nm from acc_re); nm := case when i < array_length(lines, 1) then lines[i + 1] else null end; k := i + 1;
      else k := i; end if;
      how := 'label';
      exit;
    end loop;
    if how is null then
      select coalesce(array_agg(o order by o), '{}') into titled from unnest(lines) with ordinality as u(x, o)
       where x ~* '^(นางสาว|นาง|นาย|น\.\s*ส\.?|ด\.\s*ช\.?|ด\.\s*ญ\.?|คุณ|(mrs|mr|ms|miss)(\.|\s))';
      if coalesce(array_length(titled, 1), 0) = 2 then nm := lines[titled[2]]; k := titled[2]; how := 'order'; end if;
    end if;
    -- a line of the slip's own fields is never a name ("จำนวนเงิน", "ค่าธรรมเนียม", "เลขที่รายการ", ...): taking it, or the reference number on it, would call a slip "someone else's"
    if nm ~* '^(จำนวน|ยอด|ค่าธรรมเนียม|เลขที่|เลขบัญชี|รหัส|วันที่|เวลา|บันทึก|หมายเหตุ|โอนเงิน|สแกน|ธนาคาร|พร้อมเพย์|amount|fee|ref|transaction|date|time|memo|note|bank|promptpay|scan)' then nm := null; end if;
    if nm is not null or acct is not null then
      -- the account digits: in the name's line, or one of the next two lines when it holds only a masked number (perhaps after "เลขบัญชี" or a bank's name, which the KBank layout
      -- prints between the name and the number)
      acct := coalesce(acct, substring(nm from acc_re),
        (select substring(l from acc_re) from unnest(lines[k + 1 : k + 2]) with ordinality as u(l, o)
          where substring(l from acc_re) is not null
            and length(regexp_replace(regexp_replace(l, '^(เลขที่บัญชี|เลขบัญชี|บัญชี|account( no\.?)?|a/c( no\.?)?|พร้อมเพย์|promptpay|e-?wallet)\s*[:：]?', ''), '[x×*•0-9 .-]', '', 'g')) <= 4
          order by o limit 1));
      nm := btrim(regexp_replace(nm, '(\s+([x×*•]{2,}|[x×*•]*[0-9])|\s*(ธนาคาร|ธ\.|bank\M|\()).*$', '', 'i'));
      nm := btrim(substring(nm from '^[ก-ฺเ-๎a-z.*•×· ]*'));                                         -- up to the first character no name has
      t := regexp_split_to_array(nm, ' ');
      while coalesce(array_length(t, 1), 0) - case when t[1] ~ '^(นางสาว|นาง|นาย|น\.ส\.?|ด\.[ชญ]\.?|คุณ|mrs\.?|mr\.?|ms\.?|miss)$' then 1 else 0 end > 2
            and t[array_length(t, 1)] ~ '^[^x×*•·.]{1,2}$' loop
        t := t[1 : array_length(t, 1) - 1];                                                             -- a stray short word after first name and surname
      end loop;
      nm := array_to_string(t, ' ');
      if nm !~ '[ก-ฮa-z].*[ก-ฮa-z]' then nm := null; end if;
      out := out || jsonb_build_object('name', left(nm, 80), 'account_hint', left(btrim(acct), 40), 'how', how);
    end if;
  end loop;
  return out;
end $$;
revoke execute on function public.finance_recipient_candidates(text) from public, anon, authenticated;

-- 3c all candidates of one slip together. p_min_agree: how many candidates must say "other" before the receiver is called NOT ours (the AI reader reads one name: 1;
--    the own reader reads the picture three times: 2, so one bad pass of OCR cannot reject a slip). status:
--   match      at least one candidate is ours and none is clearly someone else
--   mismatch   enough candidates are clearly someone else and none is ours                -> RECEIVER_MISMATCH (critical)
--   uncertain  ours and not ours at once, only near, only a first name, or one "other" too few -> RECEIVER_UNCERTAIN (a person decides)
--   unclear    nothing could be read                                                          -> RECEIVER_UNCLEAR (a person decides)
create or replace function public.finance_recipient_check(p_candidates jsonb, p_min_agree integer default 1)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c jsonb; r jsonb; v_all jsonb := '[]'::jsonb; n_match int := 0; n_other int := 0; n_soft int := 0; v_holder text; v_method text; v_status text;
begin
  if jsonb_typeof(p_candidates) = 'array' then
    for c in select x from jsonb_array_elements(p_candidates) with ordinality as e(x, o) where jsonb_typeof(x) = 'object' order by o limit 6 loop
      r := public.finance_recipient_match(left(c ->> 'name', 120), left(c ->> 'account_hint', 40));
      v_all := v_all || (jsonb_build_object('name', left(c ->> 'name', 80), 'account_hint', left(c ->> 'account_hint', 40), 'how', left(c ->> 'how', 10)) || r);
      if r ->> 'verdict' = 'match' then n_match := n_match + 1; v_holder := coalesce(v_holder, r ->> 'holder'); v_method := coalesce(v_method, r ->> 'method');
      elsif r ->> 'verdict' = 'other' then n_other := n_other + 1;
      elsif r ->> 'verdict' in ('near', 'partial', 'conflict') then n_soft := n_soft + 1; v_holder := coalesce(v_holder, r ->> 'holder'); end if;
    end loop;
  end if;
  v_status := case when n_match > 0 and n_other = 0 then 'match'
                   when n_match = 0 and n_other >= greatest(coalesce(p_min_agree, 1), 1) and n_soft = 0 then 'mismatch'
                   when n_match + n_other + n_soft > 0 then 'uncertain' else 'unclear' end;
  return jsonb_build_object('status', v_status, 'holder', case when v_status in ('match', 'uncertain') then v_holder end, 'method', case when v_status = 'match' then v_method end,
    'confidence', case v_status when 'match' then case when n_match >= 2 or p_min_agree <= 1 then 0.95 else 0.8 end when 'mismatch' then 0.9 when 'uncertain' then 0.5 else 0 end,
    'agree', jsonb_build_object('match', n_match, 'other', n_other, 'soft', n_soft), 'candidates', v_all, 'version', 'recipient-v1');
end $$;
revoke execute on function public.finance_recipient_check(jsonb, integer) from public, anon, authenticated;

-- ================================================================================================= 4 the classifier and the three outcomes
-- 4a the stored attempt keeps its outcome, the receiver check and the version of the rules
alter table public.finance_slip_analysis
  add column if not exists decision text constraint finance_slip_analysis_decision_chk check (decision is null or decision in ('verified', 'review_required', 'rejected')),
  add column if not exists recipient jsonb,
  add column if not exists rules_version text constraint finance_slip_analysis_rules_version_chk check (rules_version is null or length(rules_version) <= 40);

-- 4b the classifier of 20261120100000 (with the file rules of 20261124100000), unchanged except the receiver part (rule 3, marked) and that it also returns "recipient".
--    The receiver is now critical: unclear or uncertain -> manual_review (it was only a note before, so an unread receiver could still be "match").
create or replace function public.finance_classify_slip(p_evidence uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_signals jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  e public.finance_payment_evidence; inv public.finance_invoices; s public.finance_settings;
  v_exp numeric; v_order_at timestamptz; v_from timestamptz; v_to timestamptz; v_expected jsonb; v_reasons jsonb := '[]'::jsonb; v_min numeric;
  v_is_slip boolean; v_amount numeric; v_ts text; v_at timestamptz; v_time_known boolean;
  v_ref text; v_qref text; v_refs text[]; v_status text; sig jsonb;
  h record; v_dup_an text[] := '{}'; v_dup_rc text[] := '{}'; v_dup_ev text[] := '{}'; v_dup_wd text[] := '{}'; v_soft uuid[] := '{}'; v_ev uuid;
  v_rcv jsonb; v_cands jsonb;
  d_t date; d_from date; d_to date;
  f_manual boolean := false; f_dup boolean := false; f_susp boolean := false; f_amount boolean := false; f_date boolean := false; f_time boolean := false; f_conf boolean := false; f_rcv boolean := false;
begin
  select * into e from public.finance_payment_evidence where id = p_evidence;
  if not found then raise exception 'NOT_FOUND: slip not found'; end if;
  select * into inv from public.finance_invoices where id = e.invoice_id;
  select * into s from public.finance_settings where id;

  -- what the order expects: the payment request this slip was made for, else what is still outstanding (posted receipts only)
  if e.request_id is not null then select r.amount into v_exp from public.finance_payment_requests r where r.id = e.request_id; end if;
  if v_exp is null then
    select greatest(inv.amount - coalesce(sum(a.amount), 0), 0) into v_exp from public.finance_allocations a join public.finance_receipts r on r.id = a.receipt_id
      where a.invoice_id = inv.id and a.active and r.status = 'posted';
  end if;
  select o.created_at into v_order_at from public.shop_orders o where o.invoice_id = inv.id;
  v_order_at := coalesce(v_order_at, inv.created_at);
  v_from := v_order_at - make_interval(mins => s.slip_window_before_min);
  v_to := e.created_at + make_interval(mins => s.slip_future_tolerance_min);
  v_expected := jsonb_build_object('amount', v_exp, 'order_created_at', v_order_at, 'window_from', v_from, 'window_to', v_to,
    'receivers', (select coalesce(jsonb_agg(jsonb_build_object('label', r.label, 'bank', r.bank, 'name', r.account_name,
                                            'account_no_masked_digits', case when r.digits is null then null else 'xxxxxx' || right(r.digits, 4) end) order by r.label), '[]'::jsonb)
                    from public.finance_slip_receivers() r));

  -- rule 1, part 1: nothing usable. Nothing else is judged: the values of a picture that is not a slip mean nothing.
  if jsonb_typeof(p_extracted) = 'object' and jsonb_typeof(p_extracted -> 'is_slip') = 'boolean' then v_is_slip := (p_extracted ->> 'is_slip')::boolean; end if;
  if v_is_slip is null then
    return jsonb_build_object('result', 'manual_review', 'expected', v_expected, 'recipient', null, 'reasons', jsonb_build_array(
      public.finance_slip_reason('UNREADABLE', 'warn', 'image', null, null, 'The reader gave no usable answer; a person has to look at the slip.')));
  elsif not v_is_slip then
    return jsonb_build_object('result', 'manual_review', 'expected', v_expected, 'recipient', null, 'reasons', jsonb_build_array(
      public.finance_slip_reason('NOT_A_SLIP', 'high', 'image', null, null, 'The reader says this picture is not a transfer slip.')));
  end if;

  -- what was read (a value of the wrong type counts as missing; the date is read as Bangkok time when it carries no offset)
  if jsonb_typeof(p_extracted -> 'amount') = 'number' then v_amount := round((p_extracted ->> 'amount')::numeric, 2); if v_amount <= 0 then v_amount := null; end if; end if;   -- read to the satang
  if jsonb_typeof(p_extracted -> 'time_known') = 'boolean' then v_time_known := (p_extracted ->> 'time_known')::boolean; end if;
  v_ts := nullif(btrim(p_extracted ->> 'transfer_at'), '');
  if v_ts ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
    begin
      if v_ts ~ '[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?\s*([zZ]|[+-][0-9]{2}(:?[0-9]{2})?)$' then v_at := v_ts::timestamptz;
      else v_at := v_ts::timestamp at time zone 'Asia/Bangkok'; end if;
    exception when others then v_at := null;
    end;
  end if;

  -- rule 1, part 2: a missing amount or date
  if v_amount is null then
    f_manual := true;
    v_reasons := v_reasons || public.finance_slip_reason('AMOUNT_MISSING', 'warn', 'amount', to_jsonb(v_exp), to_jsonb(left(p_extracted ->> 'amount', 300)), 'The amount could not be read from the slip.');
  end if;
  if v_at is null then
    f_manual := true;
    v_reasons := v_reasons || public.finance_slip_reason('DATE_MISSING', 'warn', 'transfer_at', null, to_jsonb(left(p_extracted ->> 'transfer_at', 300)), 'The transfer date could not be read from the slip.');
  end if;

  -- rule 2: the bank reference (printed on the slip and in its QR) was already seen: another finished analysis, a receipt, another slip, a wallet deposit.
  v_ref := public.finance_slip_ref(p_extracted ->> 'trans_ref');
  v_qref := public.finance_slip_ref(p_qr ->> 'trans_ref');
  v_refs := array(select distinct q.r from unnest(array[v_ref, v_qref]) as q(r) where length(q.r) >= 4);        -- a shorter one counts as absent
  if coalesce(array_length(v_refs, 1), 0) > 0 then
    for h in
      select q.r as ref, 'analysis'::text as src, a.evidence_id as ev from unnest(v_refs) as q(r) join public.finance_slip_analysis a
        on a.status = 'done' and a.evidence_id <> e.id and (public.finance_slip_ref(a.extracted ->> 'trans_ref') = q.r or public.finance_slip_ref(a.qr ->> 'trans_ref') = q.r)
      union all
      select q.r, 'receipt', c.evidence_id from unnest(v_refs) as q(r) join public.finance_receipts c
        on c.evidence_id is distinct from e.id and c.bank_trans_ref is not null and public.finance_slip_ref(c.bank_trans_ref) = q.r
      union all
      select q.r, 'evidence', x.id from unnest(v_refs) as q(r) join public.finance_payment_evidence x
        on x.id <> e.id and ((x.bank_trans_ref is not null and public.finance_slip_ref(x.bank_trans_ref) = q.r) or (x.confirmed_bank_ref is not null and public.finance_slip_ref(x.confirmed_bank_ref) = q.r))
      union all
      select q.r, 'deposit', null::uuid from unnest(v_refs) as q(r) join public.finance_wallet_deposits d on d.bank_trans_ref is not null and public.finance_slip_ref(d.bank_trans_ref) = q.r
    loop
      if h.src in ('analysis', 'evidence') and exists (select 1 from public.finance_payment_evidence p
           where p.id = h.ev and p.invoice_id = e.invoice_id and p.customer_id = e.customer_id and p.status in ('rejected', 'more_evidence')
             and not exists (select 1 from public.finance_receipts c where c.evidence_id = p.id)) then
        v_soft := array_append(v_soft, h.ev);
      elsif h.src = 'analysis' then v_dup_an := array_append(v_dup_an, h.ref);
      elsif h.src = 'receipt' then v_dup_rc := array_append(v_dup_rc, h.ref);
      elsif h.src = 'evidence' then v_dup_ev := array_append(v_dup_ev, h.ref);
      else v_dup_wd := array_append(v_dup_wd, h.ref);
      end if;
    end loop;
    if cardinality(v_dup_an) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_an) as u), ', '), 300)), 'This bank reference was already read on another slip.');
    end if;
    if cardinality(v_dup_rc) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_rc) as u), ', '), 300)), 'This bank reference is already on a receipt.');
    end if;
    if cardinality(v_dup_ev) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_ev) as u), ', '), 300)), 'This bank reference is already on another payment slip.');
    end if;
    if cardinality(v_dup_wd) > 0 then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_REFERENCE', 'high', 'trans_ref', null,
        to_jsonb(left(array_to_string(array(select distinct u from unnest(v_dup_wd) as u), ', '), 300)), 'This bank reference is already on a wallet deposit.');
    end if;
    for v_ev in select distinct u from unnest(v_soft) as u loop
      v_reasons := v_reasons || public.finance_slip_reason('RESUBMITTED_TRANSFER', 'info', 'trans_ref', null, to_jsonb(v_ev::text),
        'This transfer was already sent on an earlier slip of this order that was sent back or rejected: the customer resent it.');
    end loop;
  end if;

  -- rule 3: signs of tampering, a QR that disagrees with the slip, a receiver that is not ours, a transfer that did not succeed
  if jsonb_typeof(p_signals) = 'array' then
    for sig in select j.value from jsonb_array_elements(p_signals) as j where j.value ->> 'severity' = 'high' loop
      f_susp := true;
      v_reasons := v_reasons || public.finance_slip_reason('TAMPER_SIGNAL', 'high', 'image', null, to_jsonb(left(coalesce(sig ->> 'code', 'unknown'), 300)),
        left(coalesce(nullif(btrim(sig ->> 'detail'), ''), 'The reader found a sign that the picture was edited.'), 300));
    end loop;
  end if;
  if coalesce(p_qr ->> 'file_sha256', '') ~ '^[0-9a-f]{64}$' then
    if (p_qr ->> 'file_sha256') <> lower(coalesce(e.file_sha256, '')) then
      f_susp := true;
      v_reasons := v_reasons || public.finance_slip_reason('FILE_HASH_MISMATCH', 'high', 'image', null, null, 'The stored file is not the file the app declared.');
    end if;
    if exists (select 1 from public.finance_slip_analysis x join public.finance_payment_evidence pe on pe.id = x.evidence_id
                where x.status = 'done' and x.evidence_id <> e.id and x.qr ->> 'file_sha256' = p_qr ->> 'file_sha256'
                  and not (pe.invoice_id = e.invoice_id and pe.customer_id = e.customer_id and pe.status in ('rejected', 'more_evidence')
                           and not exists (select 1 from public.finance_receipts c where c.evidence_id = pe.id))) then
      f_dup := true;
      v_reasons := v_reasons || public.finance_slip_reason('DUPLICATE_FILE', 'high', 'image', null, null, 'The same file was already sent as another payment slip.');
    end if;
  end if;
  if jsonb_typeof(p_qr -> 'crc_ok') = 'boolean' and not (p_qr ->> 'crc_ok')::boolean then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('QR_BAD_CRC', 'high', 'qr', to_jsonb(true), to_jsonb(false), 'The checksum of the QR code on the slip is wrong.');
  end if;
  if length(v_ref) >= 4 and length(v_qref) >= 4 and v_ref <> v_qref then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('QR_REF_MISMATCH', 'high', 'trans_ref', to_jsonb(left(v_ref, 300)), to_jsonb(left(v_qref, 300)), 'The reference in the QR code is not the reference printed on the slip.');
  end if;
  -- >>> receiver (20261128150000): critical. The own reader gives the candidates the DATABASE found in the text (receiver_candidates, several passes); the AI reader gives the one
  --     receiver it read. finance_recipient_check compares them with the holders of the shop's accounts and the approved spellings.
  v_cands := case when jsonb_typeof(p_extracted -> 'receiver_candidates') = 'array' then p_extracted -> 'receiver_candidates'
                  else jsonb_build_array(jsonb_build_object('name', p_extracted -> 'receiver' ->> 'name', 'account_hint', p_extracted -> 'receiver' ->> 'account_hint', 'how', 'reader')) end;
  v_rcv := public.finance_recipient_check(v_cands, case when jsonb_typeof(p_extracted -> 'receiver_candidates') = 'array' then 2 else 1 end);
  if v_rcv ->> 'status' = 'mismatch' then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('RECEIVER_MISMATCH', 'high', 'receiver', (select jsonb_agg(r.label order by r.label) from public.finance_slip_receivers() r),
      jsonb_build_object('name', left(v_rcv #>> '{candidates,0,name}', 300), 'account_hint', left(v_rcv #>> '{candidates,0,account_hint}', 300)), 'The slip shows a receiver that is not one of the shop''s accounts.');
  elsif v_rcv ->> 'status' = 'uncertain' then
    f_rcv := true;
    v_reasons := v_reasons || public.finance_slip_reason('RECEIVER_UNCERTAIN', 'warn', 'receiver', to_jsonb(v_rcv ->> 'holder'),
      jsonb_build_object('name', left(v_rcv #>> '{candidates,0,name}', 300), 'agree', v_rcv -> 'agree'), 'The receiver is close to one of the shop''s names but not certainly the same; a person has to compare it.');
  elsif v_rcv ->> 'status' = 'unclear' then
    f_rcv := true;
    v_reasons := v_reasons || public.finance_slip_reason('RECEIVER_UNCLEAR', 'warn', 'receiver', null, null, 'The receiver could not be read well enough to compare with the shop''s accounts.');
  end if;
  -- <<< receiver
  v_status := nullif(btrim(p_extracted ->> 'status_text'), '');
  if v_status is not null and v_status ~* 'ไม่สำเร็จ|ล้มเหลว|ไม่ผ่าน|ยกเลิก|fail|unsuccess|reject|cancel|pending' then
    f_susp := true;
    v_reasons := v_reasons || public.finance_slip_reason('STATUS_NOT_SUCCESS', 'high', 'status_text', null, to_jsonb(left(v_status, 300)), 'The slip does not say that the transfer succeeded.');
  end if;

  -- rule 4: the amount, exact to the satang
  if v_amount is not null and v_amount <> v_exp then
    f_amount := true;
    v_reasons := v_reasons || public.finance_slip_reason(case when v_amount < v_exp then 'AMOUNT_UNDER' else 'AMOUNT_OVER' end, 'high', 'amount', to_jsonb(v_exp), to_jsonb(v_amount),
      case when v_amount < v_exp then 'The slip shows less than the order expects.' else 'The slip shows more than the order expects.' end);
  end if;

  -- rule 5: the Bangkok calendar day first (date_mismatch); then the time of day (time_anomaly), which is also what an unknown time is
  if v_at is not null then
    d_t := (v_at at time zone 'Asia/Bangkok')::date;
    d_from := (v_from at time zone 'Asia/Bangkok')::date;
    d_to := (v_to at time zone 'Asia/Bangkok')::date;
    if d_t < d_from or d_t > d_to then
      f_date := true;
      v_reasons := v_reasons || public.finance_slip_reason('DATE_OUT_OF_RANGE', 'high', 'transfer_at', jsonb_build_object('from', d_from, 'to', d_to), to_jsonb(d_t),
        'The transfer is on a different day from the order.');
    elsif v_time_known is not true then
      f_time := true;
      v_reasons := v_reasons || public.finance_slip_reason('TIME_MISSING', 'warn', 'time', jsonb_build_object('from', v_from, 'to', v_to), null, 'The slip shows no time of day.');
    elsif v_at < v_from or v_at > v_to then
      f_time := true;
      v_reasons := v_reasons || public.finance_slip_reason('TIME_OUT_OF_RANGE', 'warn', 'time', jsonb_build_object('from', v_from, 'to', v_to), to_jsonb(v_at),
        'The transfer time is outside the allowed window around the order.');
    end if;
  end if;

  -- rule 6: how sure the reader is (overall, and about the amount)
  v_min := s.ai_min_confidence;
  if p_confidence is null or p_confidence < v_min then
    f_conf := true;
    v_reasons := v_reasons || public.finance_slip_reason('LOW_CONFIDENCE', 'warn', 'overall_confidence', to_jsonb(v_min), to_jsonb(p_confidence), 'The reader is not sure enough about this slip.');
  end if;
  if jsonb_typeof(p_extracted #> '{field_confidence,amount}') = 'number' and (p_extracted #>> '{field_confidence,amount}')::numeric < v_min then
    f_conf := true;
    v_reasons := v_reasons || public.finance_slip_reason('LOW_CONFIDENCE', 'warn', 'amount', to_jsonb(v_min), p_extracted #> '{field_confidence,amount}', 'The reader is not sure enough about the amount.');
  end if;

  return jsonb_build_object('expected', v_expected, 'reasons', v_reasons, 'recipient', v_rcv, 'result', case
    when f_manual then 'manual_review'
    when f_dup then 'duplicate_suspected'
    when f_susp then 'suspicious_slip'
    when f_amount then 'amount_mismatch'
    when f_date then 'date_mismatch'
    when f_time then 'time_anomaly'
    when f_conf or f_rcv then 'manual_review'
    else 'match' end);
end $$;

-- 4c the outcome of one reading. Pure: the result, the reasons and how sure the reader was of the amount and the date.
--   rejected         a critical rule failed: the receiver is not ours, the reference or the file was already used, the file or the slip's QR is not genuine, the slip says the
--                    transfer failed, or (read with certainty, 0.9 or more) the amount or the day is not the order's. No confidence can outweigh any of these.
--   verified         the classifier says match, the receiver is ours and nothing else is in doubt. STILL NOT PROOF OF PAYMENT: a person checks the bank before Confirm.
--   review_required  everything else: something could not be read, is only nearly right, or is unusual
create or replace function public.finance_slip_decision(p_result text, p_reasons jsonb, p_extracted jsonb default null)
returns jsonb language plpgsql immutable set search_path = public as $$
declare v_codes text[]; v_crit text[]; v_warn boolean; ca numeric; cd numeric;
begin
  if jsonb_typeof(p_reasons) = 'array' then
    v_codes := array(select r ->> 'code' from jsonb_array_elements(p_reasons) r);
    v_warn := exists (select 1 from jsonb_array_elements(p_reasons) r where r ->> 'severity' in ('warn', 'high'));
  else v_codes := '{}'; v_warn := false; end if;
  ca := case when jsonb_typeof(p_extracted #> '{field_confidence,amount}') = 'number' then (p_extracted #>> '{field_confidence,amount}')::numeric end;
  cd := case when jsonb_typeof(p_extracted #> '{field_confidence,date}') = 'number' then (p_extracted #>> '{field_confidence,date}')::numeric end;
  v_crit := array(select c from unnest(v_codes) c where c in ('RECEIVER_MISMATCH', 'DUPLICATE_REFERENCE', 'DUPLICATE_FILE', 'FILE_HASH_MISMATCH', 'QR_BAD_CRC', 'STATUS_NOT_SUCCESS', 'TAMPER_SIGNAL')
                 or (c in ('AMOUNT_UNDER', 'AMOUNT_OVER') and coalesce(ca, 1) >= 0.9) or (c = 'DATE_OUT_OF_RANGE' and coalesce(cd, 1) >= 0.9));
  return jsonb_build_object('decision', case when cardinality(v_crit) > 0 then 'rejected' when p_result = 'match' and not v_warn then 'verified' else 'review_required' end,
    'critical', to_jsonb(array(select distinct c from unnest(v_crit) c order by c)));
end $$;

-- 4d the AI reader's completion (as in 20261120100000) also keeps the outcome, the receiver check and the rules version. A reader cannot hand in receiver candidates of its own.
create or replace function public.finance_analysis_complete(p_analysis uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_signals jsonb, p_engine text, p_prompt_version text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.finance_slip_analysis; v jsonb; v_conf numeric := round(p_confidence, 3); v_x jsonb := case when jsonb_typeof(p_extracted) = 'object' then p_extracted - 'receiver_candidates' else p_extracted end; v_d jsonb;
begin
  select * into a from public.finance_slip_analysis where id = p_analysis for update;
  if not found then raise exception 'NOT_FOUND: analysis not found'; end if;
  if a.status in ('done', 'failed') then raise exception 'ALREADY_DONE: this analysis is already finished'; end if;
  if v_conf is not null and v_conf not between 0 and 1 then raise exception 'INVALID_CONFIDENCE: the confidence must be between 0 and 1'; end if;
  v := public.finance_classify_slip(a.evidence_id, v_x, p_qr, p_confidence, coalesce(p_signals, '[]'::jsonb));   -- judged as reported; only the stored copy is rounded
  v_d := public.finance_slip_decision(v ->> 'result', v -> 'reasons', v_x);
  update public.finance_slip_analysis set status = 'done', engine = nullif(btrim(p_engine), ''), prompt_version = nullif(btrim(p_prompt_version), ''),
    extracted = v_x, qr = p_qr, expected = v -> 'expected', overall_confidence = v_conf, signals = coalesce(p_signals, '[]'::jsonb),
    result = v ->> 'result', reasons = v -> 'reasons', error = null, finished_at = now(),
    decision = v_d ->> 'decision', recipient = v -> 'recipient', rules_version = 'rules-2026-11-28' where id = a.id;
  perform public.finance_log('evidence', a.evidence_id, 'evidence.analysis', jsonb_build_object('result', v ->> 'result', 'decision', v_d ->> 'decision', 'confidence', v_conf));
  return jsonb_build_object('result', v ->> 'result', 'decision', v_d ->> 'decision', 'reasons', v -> 'reasons');
end $$;

-- 4e the own reader (as in 20261124110000): the receiver is found by the DATABASE in the text by its place on the slip (finance_recipient_candidates), one candidate per pass;
--    what the browser says about the receiver is ignored. The confidence is no longer lowered when the receiver is not found: the receiver rule itself sends it to a person.
--    The text that was read is still not stored; only the receiver candidates (a name of at most 80 characters and the masked account) are kept, for the audit trail.
create or replace function public.finance_store_reading(p_evidence uuid, p_extracted jsonb, p_qr jsonb, p_confidence numeric, p_text text, p_engine text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.finance_payment_evidence; s public.finance_settings; a public.finance_slip_analysis; v jsonb; v_n integer; v_x jsonb; v_c jsonb; v_d jsonb;
begin
  perform public.finance_require('verify', 'read a payment slip');
  select * into s from public.finance_settings where id;
  if not coalesce(s.own_reader_enabled, false) then raise exception 'READER_OFF: the slip reader is switched off'; end if;
  if coalesce(p_engine, '') !~ '^browser-ocr/[0-9a-z.]{1,12}$' or jsonb_typeof(p_extracted) is distinct from 'object' or jsonb_typeof(p_qr) is distinct from 'object'
     or length(p_extracted::text) > 6000 or length(p_qr::text) > 1000 or length(coalesce(p_text, '')) > 12000 or p_confidence is null or p_confidence not between 0 and 1 then
    raise exception 'INVALID_READING' using errcode = '22023'; end if;
  select * into e from public.finance_payment_evidence where id = p_evidence for update;                      -- serialises the attempt numbers of one slip
  if not found then raise exception 'NOT_FOUND: slip not found'; end if;
  if e.file_path is null then raise exception 'NOTHING_TO_DO: this payment has no slip image'; end if;
  if e.status not in ('submitted', 'confirmed') then raise exception 'NOTHING_TO_DO: this slip is already %', e.status; end if;
  select * into a from public.finance_slip_analysis where evidence_id = e.id order by attempt desc limit 1;
  if found and a.status in ('queued', 'running') and a.created_at > now() - interval '5 minutes' then raise exception 'ALREADY_QUEUED: an analysis of this slip is already waiting or running'; end if;
  select count(*) into v_n from public.finance_slip_analysis where evidence_id = e.id;
  if v_n >= 5 then raise exception 'TOO_MANY_ATTEMPTS: this slip has already been analysed % times', v_n; end if;

  v_c := public.finance_recipient_candidates(p_text);
  v_x := (p_extracted - 'receiver_candidates') || jsonb_build_object('sender', jsonb_build_object('name', null, 'bank', null, 'account_hint', null),
    'receiver', jsonb_build_object('name', (select x ->> 'name' from jsonb_array_elements(v_c) x where x ->> 'name' is not null limit 1), 'bank', null,
                                   'account_hint', (select x ->> 'account_hint' from jsonb_array_elements(v_c) x where x ->> 'account_hint' is not null limit 1)),
    'receiver_candidates', v_c);
  v := public.finance_classify_slip(e.id, v_x, p_qr, p_confidence, '[]'::jsonb);
  v_d := public.finance_slip_decision(v ->> 'result', v -> 'reasons', v_x);
  insert into public.finance_slip_analysis (evidence_id, attempt, status, engine, prompt_version, extracted, qr, expected, overall_confidence, signals, result, reasons, requested_by, started_at, finished_at,
                                            decision, recipient, rules_version)
    values (e.id, coalesce(a.attempt, 0) + 1, 'done', p_engine, 'own-v2', v_x, p_qr, v -> 'expected', round(p_confidence, 3), '[]'::jsonb, v ->> 'result', v -> 'reasons', auth.uid(), now(), now(),
            v_d ->> 'decision', v -> 'recipient', 'rules-2026-11-28');
  perform public.finance_log('evidence', e.id, 'evidence.analysis', jsonb_build_object('result', v ->> 'result', 'decision', v_d ->> 'decision', 'confidence', round(p_confidence, 3), 'engine', p_engine));
  return jsonb_build_object('result', v ->> 'result', 'decision', v_d ->> 'decision', 'receiver_found', v -> 'recipient' ->> 'status' = 'match', 'recipient', v -> 'recipient' ->> 'status');
end $$;

-- 4f what the customer's phone needs for its own check before ordering (as in 20261124120000) plus the names a slip may show as receiver: the same names the payment card
--    already shows them. Approved OCR variants are not given out.
create or replace function public.finance_own_reader()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.finance_settings;
begin
  if auth.uid() is null then raise exception 'Please sign in' using errcode = '42501'; end if;
  select * into s from public.finance_settings where id;
  return jsonb_build_object('enabled', coalesce(s.own_reader_enabled, false), 'can_read', coalesce(public.finance_can('verify'), false), 'can_manage', coalesce(public.finance_can('manage'), false),
    'checkout', coalesce(s.checkout_check_enabled, false), 'before_min', coalesce(s.slip_window_before_min, 120), 'after_min', coalesce(s.slip_future_tolerance_min, 10),
    'recipients', case when coalesce(s.checkout_check_enabled, false) or public.finance_can('view')
                       then (select coalesce(jsonb_agg(distinct h.name), '[]'::jsonb) from public.finance_slip_holders() h where h.src in ('account', 'alt', 'spelling', 'english')) else '[]'::jsonb end);
end $$;

-- ================================================================================================= 5 feedback from staff
-- 5a one judgement of one reading by a person: was the outcome right, and who really was the receiver? Append-only; the newest judgement of an attempt counts.
create table if not exists public.finance_slip_feedback (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.finance_slip_analysis (id) on delete restrict,
  evidence_id uuid not null references public.finance_payment_evidence (id) on delete restrict,
  verdict text not null constraint finance_slip_feedback_verdict_chk check (verdict in ('correct', 'wrong')),
  correct_decision text constraint finance_slip_feedback_decision_chk check (correct_decision is null or correct_decision in ('verified', 'review_required', 'rejected')),
  recipient_truth text constraint finance_slip_feedback_truth_chk check (recipient_truth is null or length(recipient_truth) between 3 and 120),   -- a holder name, or OTHER
  printed_name text constraint finance_slip_feedback_printed_chk check (printed_name is null or length(printed_name) between 3 and 120),          -- the receiver as the slip prints it
  note text constraint finance_slip_feedback_note_chk check (note is null or length(note) <= 300),
  created_by uuid not null, created_at timestamptz not null default now()
);
create index if not exists finance_slip_feedback_analysis_idx on public.finance_slip_feedback (analysis_id, created_at desc);
create or replace function public.finance_guard_slip_feedback()
returns trigger language plpgsql set search_path = public as $$
begin raise exception 'Feedback on a slip reading is never changed or deleted: add a new one'; end $$;
drop trigger if exists finance_slip_feedback_guard on public.finance_slip_feedback;
create trigger finance_slip_feedback_guard before update or delete on public.finance_slip_feedback for each row execute function public.finance_guard_slip_feedback();
alter table public.finance_slip_feedback enable row level security;
drop policy if exists "finance slip feedback: staff" on public.finance_slip_feedback;
create policy "finance slip feedback: staff" on public.finance_slip_feedback for select to authenticated using (public.finance_can('view'));
revoke all on public.finance_slip_feedback from anon, authenticated;
grant select on public.finance_slip_feedback to authenticated;

-- 5b a verifier records it
create or replace function public.finance_slip_feedback_add(p_analysis uuid, p_verdict text, p_correct_decision text default null, p_recipient_truth text default null,
                                                            p_printed_name text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.finance_slip_analysis; v_truth text := nullif(btrim(p_recipient_truth), ''); v_printed text := nullif(btrim(regexp_replace(coalesce(p_printed_name, ''), '[[:cntrl:]]', ' ', 'g')), '');
        v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]]', ' ', 'g')), ''); f public.finance_slip_feedback; v_dec text;
begin
  perform public.finance_require('verify', 'give feedback on a slip reading');
  select * into a from public.finance_slip_analysis where id = p_analysis;
  if not found then raise exception 'NOT_FOUND: analysis not found'; end if;
  if a.status <> 'done' then raise exception 'NOTHING_TO_DO: only a finished reading can be judged'; end if;
  if p_verdict is null or p_verdict not in ('correct', 'wrong') then raise exception 'INVALID_FEEDBACK' using errcode = '22023'; end if;
  if p_correct_decision is not null and p_correct_decision not in ('verified', 'review_required', 'rejected') then raise exception 'INVALID_FEEDBACK' using errcode = '22023'; end if;
  if v_truth is not null and v_truth <> 'OTHER'
     and not exists (select 1 from public.finance_slip_holders() h where h.src = 'account' and public.finance_name_key(public.finance_name_untitle(h.holder)) = public.finance_name_key(public.finance_name_untitle(v_truth))) then
    raise exception 'INVALID_RECIPIENT: not one of the shop''s account holders' using errcode = '22023'; end if;
  if v_printed is not null and (length(v_printed) > 120 or length(public.finance_name_key(public.finance_name_untitle(v_printed))) < 3) then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 300 then raise exception 'INVALID_FEEDBACK' using errcode = '22023'; end if;
  if p_verdict = 'wrong' and p_correct_decision is null and v_truth is null and v_printed is null then raise exception 'FEEDBACK_INCOMPLETE: say what was wrong' using errcode = '22023'; end if;
  v_dec := coalesce(a.decision, public.finance_slip_decision(a.result, a.reasons, a.extracted) ->> 'decision');
  if p_verdict = 'wrong' and p_correct_decision = v_dec and v_truth is null and v_printed is null then raise exception 'FEEDBACK_INCOMPLETE: the outcome given is the one already there' using errcode = '22023'; end if;
  insert into public.finance_slip_feedback (analysis_id, evidence_id, verdict, correct_decision, recipient_truth, printed_name, note, created_by)
    values (a.id, a.evidence_id, p_verdict, case when p_verdict = 'correct' then v_dec else p_correct_decision end, v_truth, v_printed, v_note, auth.uid()) returning * into f;
  perform public.finance_log('evidence', a.evidence_id, 'evidence.feedback', jsonb_build_object('analysis', a.id, 'verdict', p_verdict, 'decision', f.correct_decision, 'recipient', v_truth));
  return to_jsonb(f);
end $$;

-- ================================================================================================= 6 recipients: what a manager sees and approves
-- 6a the holders with their accounts and every approved spelling
create or replace function public.finance_slip_recipients()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.finance_require('view', 'see the shop''s recipients');
  return jsonb_build_object(
    'holders', (select coalesce(jsonb_agg(jsonb_build_object('holder', x.holder, 'accounts', x.n) order by x.holder), '[]'::jsonb)
                  from (select h.holder, count(*) as n from public.finance_slip_holders() h where h.src = 'account' group by h.holder) x),
    'names', (select coalesce(jsonb_agg(jsonb_build_object('holder', h.holder, 'name', h.name, 'src', h.src) order by h.holder, h.src, h.name), '[]'::jsonb) from public.finance_slip_holders() h),
    'variants', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'holder', v.holder_name, 'variant', v.variant, 'kind', v.kind, 'source', v.source, 'status', v.status, 'note', v.note,
                                                            'created_at', v.created_at, 'created_by', (select p.email from public.profiles p where p.id = v.created_by), 'retired_at', v.retired_at,
                                                            'retire_reason', v.retire_reason, 'impact', v.impact) order by v.status, v.created_at desc), '[]'::jsonb)
                   from public.finance_slip_name_variants v));
end $$;

-- 6b what the past readings say about a spelling, by what finally happened to each payment (posted after the bank check / rejected by staff / not decided)
create or replace function public.finance_slip_variant_impact(p_holder text, p_variant text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare k text := public.finance_name_key(public.finance_name_untitle(p_variant)); r jsonb;
begin
  perform public.finance_require('view', 'see the slip readings');
  select jsonb_build_object('readings', count(*), 'evidence', count(distinct a.evidence_id),
           'posted', count(distinct a.evidence_id) filter (where e.status = 'verified'), 'rejected', count(distinct a.evidence_id) filter (where e.status = 'rejected'),
           'open', count(distinct a.evidence_id) filter (where e.status not in ('verified', 'rejected')),
           'would_change', count(*) filter (where coalesce(a.recipient ->> 'status', '') <> 'match'),
           'distance', public.finance_name_dist(k, public.finance_name_key(public.finance_name_untitle(p_holder))))
    into r
    from public.finance_slip_analysis a join public.finance_payment_evidence e on e.id = a.evidence_id
   where a.status = 'done' and exists (select 1 from jsonb_array_elements(coalesce(a.recipient -> 'candidates', a.extracted -> 'receiver_candidates', '[]'::jsonb)) c
                                         where public.finance_name_key(public.finance_name_untitle(c ->> 'name')) = k)
      or a.status = 'done' and public.finance_name_key(public.finance_name_untitle(a.extracted -> 'receiver' ->> 'name')) = k;
  return r;
end $$;

-- 6c a manager approves a spelling. Refused: a holder without an active account, a spelling that is a holder already, an OCR variant more than three letters from the holder,
--    an English spelling with Thai letters, and any spelling read on a slip that staff REJECTED (it might be the very name a forger uses).
create or replace function public.finance_slip_variant_add(p_holder text, p_variant text, p_kind text, p_note text default null, p_source text default 'manager')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_holder text; v_var text := nullif(btrim(regexp_replace(coalesce(p_variant, ''), '[[:cntrl:]]', ' ', 'g')), ''); k text; imp jsonb; r public.finance_slip_name_variants;
        v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]]', ' ', 'g')), '');
begin
  perform public.finance_require('manage', 'approve a recipient spelling');
  select h.holder into v_holder from public.finance_slip_holders() h
   where h.src = 'account' and public.finance_name_key(public.finance_name_untitle(h.holder)) = public.finance_name_key(public.finance_name_untitle(p_holder)) limit 1;
  if v_holder is null then raise exception 'INVALID_RECIPIENT: not one of the shop''s account holders' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('spelling', 'english', 'ocr') or coalesce(p_source, '') not in ('manager', 'learned') then raise exception 'INVALID_VARIANT' using errcode = '22023'; end if;
  k := public.finance_name_key(public.finance_name_untitle(v_var));
  if v_var is null or length(v_var) > 120 or length(k) < 4 then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 300 then raise exception 'INVALID_VARIANT' using errcode = '22023'; end if;
  if exists (select 1 from public.finance_slip_holders() h where public.finance_name_key(public.finance_name_untitle(h.name)) = k) then raise exception 'VARIANT_EXISTS' using errcode = '23505'; end if;
  if p_kind = 'english' and v_var ~ '[ก-๛]' then raise exception 'INVALID_VARIANT: an English spelling has no Thai letters' using errcode = '22023'; end if;
  if p_kind in ('spelling', 'ocr') and v_var !~ '[ก-๛]' then raise exception 'INVALID_VARIANT: a Thai spelling needs Thai letters' using errcode = '22023'; end if;
  if p_kind = 'ocr' and public.finance_name_dist(k, public.finance_name_key(public.finance_name_untitle(v_holder))) > 3 then
    raise exception 'VARIANT_TOO_FAR: an OCR variant must be within three letters of the name' using errcode = '22023'; end if;
  imp := public.finance_slip_variant_impact(v_holder, v_var);
  if coalesce((imp ->> 'rejected')::int, 0) > 0 then raise exception 'VARIANT_SEEN_ON_REJECTED: this spelling was read on a slip that staff rejected' using errcode = '22023'; end if;
  insert into public.finance_slip_name_variants (holder_name, variant, variant_key, kind, source, impact, note, created_by)
    values (v_holder, v_var, k, p_kind, p_source, imp, v_note, auth.uid()) returning * into r;
  perform public.finance_log('settings', r.id, 'recipient.variant_add', jsonb_build_object('holder', v_holder, 'variant', v_var, 'kind', p_kind, 'source', p_source, 'impact', imp));
  return to_jsonb(r);
end $$;

-- 6d a manager retires one (it stops counting from the next reading; the readings it decided keep what they said)
create or replace function public.finance_slip_variant_retire(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.finance_slip_name_variants; v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), '');
begin
  perform public.finance_require('manage', 'retire a recipient spelling');
  if v_reason is null or length(v_reason) not between 3 and 300 then raise exception 'INVALID_REASON' using errcode = '22023'; end if;
  update public.finance_slip_name_variants set status = 'retired', retired_by = auth.uid(), retired_at = now(), retire_reason = v_reason where id = p_id and status = 'active' returning * into r;
  if not found then raise exception 'NOT_FOUND: no active spelling with this id'; end if;
  perform public.finance_log('settings', r.id, 'recipient.variant_retire', jsonb_build_object('holder', r.holder_name, 'variant', r.variant, 'reason', v_reason));
  return to_jsonb(r);
end $$;

-- ================================================================================================= 7 how good is it: measured only against what people established
-- Truth comes from people, never from an earlier reading: a payment POSTED after the bank check was genuine and paid to us; one REJECTED by staff was not acceptable;
-- a staff judgement (finance_slip_feedback, the newest per reading) says whether an outcome and a receiver were right. An approval by the reader itself is never truth.
create or replace function public.finance_slip_learning(p_days integer default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 90), 1), 730)); v_out jsonb;
begin
  perform public.finance_require('view', 'see how the slip check performs');
  with an as (
    select a.*, e.status as ev_status, coalesce(e.verified_amount, e.confirmed_amount) as truth_amount, coalesce(e.transfer_at, e.confirmed_transfer_at) as truth_at,
           coalesce(a.decision, public.finance_slip_decision(a.result, a.reasons, a.extracted) ->> 'decision') as dec,
           coalesce(a.recipient ->> 'status', case when a.reasons @> '[{"code": "RECEIVER_MISMATCH"}]' then 'mismatch' when a.reasons @> '[{"code": "RECEIVER_UNCERTAIN"}]' then 'uncertain'
                                                   when a.reasons @> '[{"code": "RECEIVER_UNCLEAR"}]' then 'unclear' else 'match' end) as rcv,
           row_number() over (partition by a.evidence_id order by a.attempt desc) as rn
      from public.finance_slip_analysis a join public.finance_payment_evidence e on e.id = a.evidence_id
     where a.status = 'done' and a.created_at >= v_from
  ), latest as (select * from an where rn = 1),
  fb as (select distinct on (f.analysis_id) f.* from public.finance_slip_feedback f join an on an.id = f.analysis_id order by f.analysis_id, f.created_at desc),
  wk as (select date_trunc('week', created_at at time zone 'Asia/Bangkok')::date as w, count(*) as n, count(*) filter (where dec = 'verified') as v,
                count(*) filter (where dec = 'review_required') as q, count(*) filter (where dec = 'rejected') as x from an group by 1),
  cal as (select case when overall_confidence >= 0.9 then '0.90-1.00' when overall_confidence >= 0.8 then '0.80-0.89' when overall_confidence >= 0.5 then '0.50-0.79' else '0.00-0.49' end as b,
                 count(*) as n, count(*) filter (where (extracted ->> 'amount') is not null and round((extracted ->> 'amount')::numeric, 2) = truth_amount) as right_amount,
                 count(*) filter (where (extracted ->> 'amount') is not null and round((extracted ->> 'amount')::numeric, 2) <> truth_amount) as wrong_amount
            from latest where ev_status = 'verified' and truth_amount is not null and jsonb_typeof(extracted -> 'amount') in ('number', 'null') group by 1),
  corr as (select public.finance_name_key(public.finance_name_untitle(c ->> 'name')) as k, min(c ->> 'name') as read, fb.recipient_truth as holder,
                  count(distinct an.evidence_id) as slips, count(distinct an.evidence_id) filter (where an.ev_status = 'verified') as posted,
                  count(distinct an.evidence_id) filter (where an.ev_status = 'rejected') as rejected
             from fb join an on an.id = fb.analysis_id, jsonb_array_elements(coalesce(an.recipient -> 'candidates', '[]'::jsonb)) c
            where fb.recipient_truth is not null and fb.recipient_truth <> 'OTHER' and coalesce(c ->> 'verdict', '') <> 'match' and c ->> 'name' is not null
            group by 1, 3)
  select jsonb_build_object(
    'from', v_from, 'days', least(greatest(coalesce(p_days, 90), 1), 730), 'rules_version', 'rules-2026-11-28',
    'readings', (select count(*) from an), 'slips', (select count(*) from latest),
    'decisions', jsonb_build_object('verified', (select count(*) from latest where dec = 'verified'), 'review_required', (select count(*) from latest where dec = 'review_required'),
                                    'rejected', (select count(*) from latest where dec = 'rejected')),
    'recipient', jsonb_build_object('match', (select count(*) from latest where rcv = 'match'), 'mismatch', (select count(*) from latest where rcv = 'mismatch'),
                                    'uncertain', (select count(*) from latest where rcv = 'uncertain'), 'unclear', (select count(*) from latest where rcv = 'unclear')),
    'unreadable', (select count(*) from latest where reasons @> '[{"code": "NOT_A_SLIP"}]' or reasons @> '[{"code": "UNREADABLE"}]' or reasons @> '[{"code": "AMOUNT_MISSING"}]' or reasons @> '[{"code": "DATE_MISSING"}]'),
    'feedback', jsonb_build_object('correct', (select count(*) from fb where verdict = 'correct'), 'wrong', (select count(*) from fb where verdict = 'wrong'),
                                   'recipient_corrected', (select count(*) from fb where verdict = 'wrong' and (recipient_truth is not null or printed_name is not null))),
    -- the outcome of the newest reading of each slip against what staff finally did
    'outcomes', jsonb_build_object(
       'verified_posted', (select count(*) from latest where dec = 'verified' and ev_status = 'verified'), 'verified_rejected', (select count(*) from latest where dec = 'verified' and ev_status = 'rejected'),
       'review_posted', (select count(*) from latest where dec = 'review_required' and ev_status = 'verified'), 'review_rejected', (select count(*) from latest where dec = 'review_required' and ev_status = 'rejected'),
       'rejected_posted', (select count(*) from latest where dec = 'rejected' and ev_status = 'verified'), 'rejected_rejected', (select count(*) from latest where dec = 'rejected' and ev_status = 'rejected'),
       'open', (select count(*) from latest where ev_status not in ('verified', 'rejected'))),
    'amount_on_posted', jsonb_build_object(
       'right', (select count(*) from latest where ev_status = 'verified' and truth_amount is not null and jsonb_typeof(extracted -> 'amount') = 'number' and round((extracted ->> 'amount')::numeric, 2) = truth_amount),
       'wrong', (select count(*) from latest where ev_status = 'verified' and truth_amount is not null and jsonb_typeof(extracted -> 'amount') = 'number' and round((extracted ->> 'amount')::numeric, 2) <> truth_amount),
       'blank', (select count(*) from latest where ev_status = 'verified' and truth_amount is not null and jsonb_typeof(extracted -> 'amount') is distinct from 'number')),
    'date_on_posted', jsonb_build_object(
       'right', (select count(*) from latest where ev_status = 'verified' and truth_at is not null and left(extracted ->> 'transfer_at', 10) = to_char(truth_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD')),
       'wrong', (select count(*) from latest where ev_status = 'verified' and truth_at is not null and extracted ->> 'transfer_at' is not null and left(extracted ->> 'transfer_at', 10) <> to_char(truth_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD')),
       'blank', (select count(*) from latest where ev_status = 'verified' and truth_at is not null and extracted ->> 'transfer_at' is null)),
    'calibration', (select coalesce(jsonb_agg(jsonb_build_object('band', b, 'n', n, 'right', right_amount, 'wrong', wrong_amount) order by b desc), '[]'::jsonb) from cal),
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object('week', w, 'n', n, 'verified', v, 'review_required', q, 'rejected', x) order by w desc), '[]'::jsonb) from (select * from wk order by w desc limit 12) z),
    'reasons', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'n', n) order by n desc, code), '[]'::jsonb)
                  from (select r ->> 'code' as code, count(*) as n from latest, jsonb_array_elements(reasons) r group by 1) y),
    -- what staff corrected the receiver from: a spelling is PROPOSED only when people corrected it on two or more different slips, at least two of them posted after the bank check,
    -- none rejected, close to the holder (three letters or less) and not already approved. A manager still has to approve it (finance_slip_variant_add).
    'corrections', (select coalesce(jsonb_agg(jsonb_build_object('read', read, 'holder', holder, 'slips', slips, 'posted', posted, 'rejected', rejected,
                                                                 'distance', public.finance_name_dist(k, public.finance_name_key(public.finance_name_untitle(holder))),
                                                                 'proposed', slips >= 2 and posted >= 2 and rejected = 0 and length(k) >= 4
                                                                             and public.finance_name_dist(k, public.finance_name_key(public.finance_name_untitle(holder))) <= 3
                                                                             and not exists (select 1 from public.finance_slip_holders() h where public.finance_name_key(public.finance_name_untitle(h.name)) = k))
                                               order by slips desc, read), '[]'::jsonb) from corr)
  ) into v_out;
  return v_out;
end $$;

-- ================================================================================================= 8 who may call what
-- the name helpers, the receiver check and the outcome are internal like the classifier (the API cannot call them, not even with the service key)
revoke execute on function public.finance_name_tidy(text), public.finance_name_untitle(text), public.finance_name_key(text), public.finance_name_dist(text, text),
  public.finance_name_parts(text), public.finance_slip_decision(text, jsonb, jsonb), public.finance_guard_name_variant(), public.finance_guard_slip_feedback() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public.finance_name_tidy(text), public.finance_name_untitle(text), public.finance_name_key(text), public.finance_name_dist(text, text),
      public.finance_name_parts(text), public.finance_slip_decision(text, jsonb, jsonb), public.finance_guard_name_variant(), public.finance_guard_slip_feedback(),
      public.finance_slip_holders(), public.finance_recipient_match(text, text), public.finance_recipient_candidates(text), public.finance_recipient_check(jsonb, integer) from service_role;
  end if;
end $$;
revoke execute on function public.finance_slip_feedback_add(uuid, text, text, text, text, text), public.finance_slip_recipients(), public.finance_slip_variant_impact(text, text),
  public.finance_slip_variant_add(text, text, text, text, text), public.finance_slip_variant_retire(uuid, text), public.finance_slip_learning(integer) from public, anon;
grant execute on function public.finance_slip_feedback_add(uuid, text, text, text, text, text), public.finance_slip_recipients(), public.finance_slip_variant_impact(text, text),
  public.finance_slip_variant_add(text, text, text, text, text), public.finance_slip_variant_retire(uuid, text), public.finance_slip_learning(integer) to authenticated;
revoke execute on function public.finance_classify_slip(uuid, jsonb, jsonb, numeric, jsonb), public.finance_analysis_complete(uuid, jsonb, jsonb, numeric, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.finance_own_reader(), public.finance_store_reading(uuid, jsonb, jsonb, numeric, text, text) from public, anon;
grant execute on function public.finance_own_reader(), public.finance_store_reading(uuid, jsonb, jsonb, numeric, text, text) to authenticated;

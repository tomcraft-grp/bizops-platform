// "Pull SKUs from central database": loads the real SKU master (Supabase public.sku_master, staff-only by RLS)
// and creates/updates the products in this device's catalogue so POS can sell them. Prices and costs never live
// in the (public) code; they are fetched at run time by a signed-in staff member.
import { useState } from 'react';
import { CloudDownload } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { importSkuMaster, SkuMasterRow } from '../domain/master';
import { act, toast, useLang } from '../domain/store';
import { t } from '../lib/i18n';
import { Button, useConfirm } from './kit';

export function PullSkuButton() {
  const lang = useLang();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const pull = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.from('sku_registry')
        .select('sku_code, legacy_sku_code, sku_category, source_code, domain, brand, name_full, product_type, pack_qty, unit_en, unit_th, barcode, status, cost_price, retail_price, selling_price, friend_price, wholesale_price, ecommerce_price, needs_review, review_notes')
        .eq('origin', 'import').order('sku_seq');
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as SkuMasterRow[];
      if (!rows.length) { toast('error', t(lang, 'No SKUs found in the central database (are you signed in as staff?)')); return; }
      const review = rows.filter((r) => r.needs_review).length;
      const ok = await confirm({
        title: t(lang, 'Pull {n} SKUs into this device?', { n: rows.length }),
        body: t(lang, 'Products are created or updated by SKU code on this device (a product pulled earlier under its old code is found by that legacy code and re-coded, not duplicated; products with other codes are kept). {r} SKUs are marked "needs review"; SKUs without a price are imported as inactive.', { r: review }),
        confirmLabel: t(lang, 'Pull SKUs'),
      });
      if (!ok.ok) return;
      const r = act((d, c) => importSkuMaster(d, c, rows));
      toast(r.failed.length ? 'error' : 'success', t(lang, '{c} created, {u} updated ({r} re-coded), {i} inactive, {f} failed', { c: r.created, u: r.updated, r: r.recoded, i: r.inactive, f: r.failed.length }));
      if (r.failed.length) console.warn('SKU import failures', r.failed);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return <Button onClick={pull} loading={busy} disabled={busy}><CloudDownload size={15} />{' '}{t(lang, 'Pull SKUs from central database')}</Button>;
}

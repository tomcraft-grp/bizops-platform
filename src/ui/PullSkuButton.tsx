// "Re-sync everything": fetches every SKU of the central registry again (the automatic sync, src/domain/skuSync.ts, only fetches what changed since the last time).
// The registry's name, price, cost, barcode, brand and active status replace what this device has; stock, recipes, levels, images and stations are never touched.
// Prices and costs are fetched at run time by a signed-in staff member; they never live in the (public) code.
import { CloudDownload } from 'lucide-react';
import { syncSkus, useSkuSync } from '../domain/skuSync';
import { toast, useLang } from '../domain/store';
import { t } from '../lib/i18n';
import { Button, useConfirm } from './kit';

export function PullSkuButton() {
  const lang = useLang();
  const confirm = useConfirm();
  const { state } = useSkuSync();
  const busy = state === 'syncing';

  const resync = async () => {
    const ok = await confirm({
      title: t(lang, 'Re-sync everything?'),
      body: t(lang, 'Every SKU is fetched again from the central database. Its name, price, cost, barcode, brand and active status replace what this device has. Stock, recipes, reorder levels, images and prep stations are not touched.'),
      confirmLabel: t(lang, 'Re-sync everything'),
    });
    if (!ok.ok) return;
    const r = await syncSkus({ full: true });
    if (!r.ok) { toast('error', t(lang, r.error ?? 'The SKU service returned an error.')); return; }
    if (!r.fetched) { toast('error', t(lang, 'No SKUs found in the central database (are you signed in as staff?)')); return; }
    toast(r.failed.length ? 'error' : 'success', t(lang, '{c} created, {u} updated ({r} re-coded), {i} inactive, {f} failed', { c: r.created, u: r.updated, r: r.recoded, i: r.inactive, f: r.failed.length }));
  };

  return <Button onClick={resync} loading={busy} disabled={busy}><CloudDownload size={15} />{' '}{t(lang, 'Re-sync everything')}</Button>;
}

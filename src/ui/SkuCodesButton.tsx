// "Assign standard SKU codes": gives the products on THIS device that still carry an old-style code (typed by hand or pulled
// before the automatic system) their FG-/RM-/WIP- code. Products that came from the central registry are matched by their
// legacy code (no new number is used); the rest get a new number from the database. The old code is kept as the legacy code.
import { useState } from 'react';
import { Hash } from 'lucide-react';
import { act, toast, useDB, useLang, useStore } from '../domain/store';
import { applySkuCodes } from '../domain/master';
import { isStandardSku, skuCategoryOf, skuCategoryOfCode } from '../domain/sku';
import { fetchLegacyMap, newClientRef, reserveSku } from '../lib/skuApi';
import { t } from '../lib/i18n';
import { Button, useConfirm } from './kit';

export function SkuCodesButton() {
  const lang = useLang();
  const db = useDB();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const pending = db.products.filter((p) => !isStandardSku(p.sku));
  if (!pending.length) return null;

  const assign = async () => {
    const ok = await confirm({
      title: t(lang, 'Assign standard SKU codes to {n} products?', { n: pending.length }),
      body: 'Each product gets an automatic code (FG-, RM- or WIP- plus a number) from the central database. Its old code is kept as the legacy code and stays searchable. Stock, orders and history are not affected. Needs an internet connection.',
      confirmLabel: 'Assign codes',
    });
    if (!ok.ok) return;
    setBusy(true);
    let matched = 0, issued = 0;
    const failed: string[] = [];
    try {
      const map = new Map((await fetchLegacyMap()).map((r) => [String(r.legacy_sku_code).toLowerCase(), r.sku_code]));
      for (const p of useStore.getState().db.products.filter((x) => !isStandardSku(x.sku))) {
        try {
          let code = map.get(p.sku.toLowerCase());
          if (code && skuCategoryOfCode(code) !== skuCategoryOf(p.kind)) code = undefined; // product type differs from the registry's: issue a fresh code
          const fresh = !code;
          if (!code) code = (await reserveSku(skuCategoryOf(p.kind), p.name, newClientRef())).code;
          const sku = code;
          act((d, c) => applySkuCodes(d, c, [{ productId: p.id, sku }]));
          if (fresh) issued++; else matched++;
        } catch (e) {
          failed.push(`${p.name}: ${(e as Error).message}`);
          if (/cannot reach the central database/i.test((e as Error).message)) break; // offline: stop instead of failing every product
        }
      }
    } catch (e) {
      failed.push((e as Error).message);
    } finally {
      setBusy(false);
    }
    toast(failed.length ? 'error' : 'success', t(lang, '{m} matched to existing codes, {i} new codes issued, {f} failed', { m: matched, i: issued, f: failed.length }));
    if (failed.length) console.warn('SKU code assignment failures', failed);
  };

  return <Button onClick={assign} disabled={busy}><Hash size={15} />{' '}{busy ? t(lang, 'Assigning…') : t(lang, 'Assign standard SKU codes ({n})', { n: pending.length })}</Button>;
}

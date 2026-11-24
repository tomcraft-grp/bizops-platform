// Products page: the pictures customers see in the online shop (one SKU), and the one-click transfer of pictures that are only in this browser.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudUpload, Star, Trash2 } from 'lucide-react';
import { toast, useDB, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { Badge, Banner, Button, Tx } from '../ui/kit';
import type { AdminProduct } from './api';
import { addShopPictures, MAX_PICTURES, picturesOnlyHere, setShopPictures, shopPictures, type Waiting } from './productPictures';

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `version` changes when a picture was added elsewhere on the page: look again. */
export function ShopPictures({ sku, version, canEdit }: { sku: string; version: number; canEdit: boolean }) {
  const [p, setP] = useState<AdminProduct | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);                  // a slow answer never replaces a newer one
  const load = useCallback(() => {
    const id = ++seq.current;
    return shopPictures(sku).then((x) => { if (id === seq.current) { setP(x); setErr(null); } }).catch((e) => { if (id === seq.current) { setP(null); setErr(why(e)); } });
  }, [sku]);
  useEffect(() => { void load(); }, [load, version]);
  const save = async (change: (paths: string[]) => string[]) => {
    setBusy(true);
    try { const now = await shopPictures(sku); await setShopPictures(sku, change(now?.image_paths ?? [])); await load(); } catch (e) { toast('error', why(e)); } finally { setBusy(false); }
  };
  if (p === undefined) return <div className="spinner" />;
  return (
    <div className="col gap-8" data-testid="shop-pictures">
      <div className="row between"><b><Tx>Pictures in the online shop</Tx></b>{p && <Badge tone={p.image_paths.length ? 'good' : 'warn'}>{p.image_paths.length}/{MAX_PICTURES}</Badge>}</div>
      {err ? <Banner tone="bad">{err}</Banner> : !p ? <Banner tone="warn"><Tx>This SKU is not in the online shop, so customers do not see its pictures.</Tx></Banner> : <>
        {!p.on_sale && <Banner tone="warn"><Tx>Customers do not see this product now (it is inactive, has no price or is hidden). The pictures are kept and appear when it is shown.</Tx></Banner>}
        {p.image_paths.length === 0 ? <div className="muted"><Tx>No picture in the online shop yet: customers see a grey box.</Tx></div> : (
          <div className="row wrap" style={{ gap: 10 }}>
            {p.image_paths.map((path, i) => (
              <div key={path} className="col gap-4" style={{ width: 104 }}>
                <img src={p.image_urls[i]} alt={p.name} width={104} height={104} style={{ objectFit: 'cover', borderRadius: 8, border: i === 0 ? '2px solid var(--brand)' : '1px solid var(--border)' }} />
                {i === 0 ? <Badge tone="info"><Star size={11} /> <Tx>main</Tx></Badge> : canEdit && <Button size="sm" disabled={busy} onClick={() => void save((x) => [path, ...x.filter((y) => y !== path)])}><Tx>Make main</Tx></Button>}
                {canEdit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save((x) => x.filter((y) => y !== path))}><Trash2 size={13} /> <Tx>Remove from the shop</Tx></Button>}
              </div>))}
          </div>)}
      </>}
    </div>
  );
}

/** "12 products have pictures only in this browser" with the button that sends them to the shop. Nothing is shown when there is nothing to send (or the shop cannot be asked). */
export function PicturesOnlyHere() {
  const db = useDB();
  const lang = useLang();
  const [list, setList] = useState<Waiting[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; failed: string[]; total: number; running: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const sig = db.products.filter((p) => p.mediaIds.length > 0).map((p) => `${p.sku}:${p.mediaIds.length}`).join(',');
  useEffect(() => { let on = true; picturesOnlyHere(db).then((x) => { if (on) setList(x); }).catch(() => { if (on) setList(null); }); return () => { on = false; }; }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    const rows = list ?? []; const failed: string[] = []; let done = 0;
    setProgress({ done, failed, total: rows.length, running: true });
    for (const w of rows) {
      try { const r = await addShopPictures(w.product.sku, await w.files()); if (r.added) done++; else failed.push(`${w.product.sku}: ${tl(lang, 'no picture could be read')}`); } catch (e) { failed.push(`${w.product.sku}: ${why(e)}`); }
      if (alive.current) setProgress({ done, failed: [...failed], total: rows.length, running: true });
    }
    if (!alive.current) return;
    setProgress({ done, failed, total: rows.length, running: false });
    if (done) toast('success', tl(lang, '{n} products now have their pictures in the online shop', { n: done }));
    picturesOnlyHere(db).then((x) => { if (alive.current) setList(x); }).catch(() => undefined);
  };
  if (!list?.length && !progress) return null;
  return (
    <div className="banner warn mb16" role="status" data-testid="pictures-only-here">
      <div className="grow">
        {list && list.length > 0 && <div>{tl(lang, '{n} products have pictures only in this browser. Customers do not see them yet.', { n: list.length })}</div>}
        {progress && <div className="sub">{tl(lang, 'Sent {d} of {t}', { d: progress.done, t: progress.total })}{progress.failed.length > 0 && <> · {progress.failed.slice(0, 5).join(' · ')}</>}</div>}
      </div>
      {list && list.length > 0 && <Button size="sm" variant="primary" loading={!!progress?.running} disabled={!!progress?.running} onClick={() => void send()}><CloudUpload size={14} /> <Tx>Send them to the online shop</Tx></Button>}
    </div>
  );
}

// Product pictures in the online shop, for staff: which ones customers see (X takes one out, the file stays stored and can be shown again), and the card that sends the pictures of this
// browser to the shop by itself after a short countdown in which each can be taken out with X.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, CloudUpload, Eye, Star, X } from 'lucide-react';
import { act, toast, useDB, useLang, useStore } from '../domain/store';
import { t as tl } from '../lib/i18n';
import type { MediaFile } from '../domain/types';
import { Badge, Banner, Button, Tx } from '../ui/kit';
import { MediaImg } from '../ui/shared';
import {
  isShopSku, type LocalState, localState, makeMain, MAX_PICTURES, notDisplayed, onPicturesChanged, picturesWaiting, removeFromShop, sendPictures, type ShopState, shopState, showInShop, type Waiting,
} from './productPictures';

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const networkTrouble = (e: string) => (typeof navigator !== 'undefined' && navigator.onLine === false) || /fetch|network|timed? ?out|load failed|50[234]/i.test(e);
const setShopHidden = (id: string, hidden: boolean) => act((d) => { const m = d.media.find((x) => x.id === id); if (m) { if (hidden) m.shopHidden = true; else delete m.shopHidden; } });
const stillWanted = (m: MediaFile) => { const now = useStore.getState().db.media.find((x) => x.id === m.id); return !!now && !now.shopHidden; };

export interface ShopPics {
  state: ShopState | null | undefined;      // undefined = loading, null = not in the shop's list
  err: string | null;                       // the shop could not be read
  failed: string | null;                    // the last change was refused; stays until the next one
  busy: string | null;                      // the picture being changed
  reload: () => void;
  run: (key: string, fn: () => Promise<unknown>, quick?: (s: ShopState) => ShopState) => Promise<void>;
}
/** The shop's pictures of one SKU (null = not a shop product: nothing is asked). */
export function useShopPictures(sku: string | null): ShopPics {
  const lang = useLang();
  const [state, setState] = useState<ShopState | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);                    // a slow answer never replaces a newer one
  const reload = useCallback(() => {
    if (!sku) return;
    const id = ++seq.current;
    shopState(sku).then((x) => { if (id === seq.current) { setState(x); setErr(null); } }).catch((e) => { if (id === seq.current) { setState((s) => s ?? null); setErr(why(e)); } });
  }, [sku]);
  useEffect(() => { reload(); return sku ? onPicturesChanged((s) => { if (s === sku) reload(); }) : undefined; }, [reload, sku]);
  const run: ShopPics['run'] = async (key, fn, quick) => {
    if (busy) return;
    setBusy(key); setFailed(null);
    try { await fn(); if (quick) setState((s) => (s ? quick(s) : s)); reload(); }
    catch (e) { setFailed(why(e) === 'TOO_MANY' ? tl(lang, 'The online shop shows at most {n} pictures for a product. Take one out first.', { n: MAX_PICTURES }) : why(e)); reload(); }
    finally { setBusy(null); }
  };
  return { state, err, failed, busy, reload, run };
}
const without = (s: ShopState, path: string): ShopState => {
  const i = s.product.image_paths.indexOf(path);
  return i < 0 ? s : { ...s, product: { ...s.product, image_paths: s.product.image_paths.filter((_, j) => j !== i), image_urls: s.product.image_urls.filter((_, j) => j !== i) } };
};

/** A picture with its X in the corner. */
function Tile({ img, x, xLabel, disabled, dim, main, children, testid }: { img: ReactNode; x?: () => void; xLabel?: string; disabled?: boolean; dim?: boolean; main?: boolean; children?: ReactNode; testid?: string }) {
  return (
    <div className="pic-tile" data-testid={testid}>
      <div className={`pic-frame${dim ? ' dim' : ''}${main ? ' main' : ''}`}>
        {img}
        {x && <button type="button" className="pic-x" onClick={x} disabled={disabled} aria-label={xLabel} title={xLabel}><X size={15} strokeWidth={2.5} /></button>}
      </div>
      {children}
    </div>
  );
}

/** Products page, Images tab: what customers see, and what is stored but not displayed. */
export function ShopPictures({ sku, pics, canEdit }: { sku: string; pics: ShopPics; canEdit: boolean }) {
  const lang = useLang();
  const { state: s, err, failed, busy, run } = pics;
  if (s === undefined) return <div className="spinner" />;
  const off = s ? notDisplayed(s) : [];
  return (
    <div className="col gap-8" data-testid="shop-pictures">
      <div className="row between"><b><Tx>Pictures in the online shop</Tx></b>{s && <Badge tone={s.product.image_paths.length ? 'good' : 'warn'}>{s.product.image_paths.length}/{MAX_PICTURES}</Badge>}</div>
      {failed && <Banner tone="bad">{tl(lang, 'Not changed: {e}', { e: failed })}</Banner>}
      {err && <Banner tone="bad"><div className="grow">{err}</div><Button size="sm" onClick={pics.reload}><Tx>Retry</Tx></Button></Banner>}
      {!s ? !err && <Banner tone="warn"><Tx>This SKU is not in the online shop, so customers do not see its pictures.</Tx></Banner> : <>
        {!s.product.on_sale && <Banner tone="warn"><Tx>Customers do not see this product now (it is inactive, has no price or is hidden). The pictures are kept and appear when it is shown.</Tx></Banner>}
        {s.product.image_paths.length === 0 ? <div className="muted"><Tx>No picture in the online shop yet: customers see a grey box.</Tx></div> : (
          <div className="pic-grid" data-testid="shop-displayed">
            {s.product.image_paths.map((path, i) => (
              <Tile key={path} testid="shop-pic" main={i === 0} disabled={!!busy} img={<img src={s.product.image_urls[i]} alt={`${s.product.name} ${i + 1}`} />}
                x={canEdit ? () => void run(path, () => removeFromShop(sku, path), (st) => without(st, path)) : undefined} xLabel={tl(lang, 'Remove from the shop')}>
                {busy === path ? <span className="muted"><Tx>Saving…</Tx></span> : i === 0 ? <Badge tone="info"><Star size={11} /> <Tx>main</Tx></Badge>
                  : canEdit && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(path, () => makeMain(sku, path))}><Tx>Make main</Tx></Button>}
              </Tile>))}
          </div>)}
        {s.product.image_paths.length > 0 && canEdit && <div className="muted" style={{ fontSize: 12 }}><Tx>X takes a picture off the customer pages. The file is kept, so it can be shown again.</Tx></div>}
        {off.length > 0 && (
          <div className="col gap-8" data-testid="shop-not-displayed">
            <div className="muted" style={{ fontWeight: 600 }}>{tl(lang, 'Stored, not shown to customers')} ({off.length})</div>
            <div className="pic-grid">
              {off.map((x) => (
                <Tile key={x.path} dim testid="shop-pic-off" img={<img src={x.url} alt="" loading="lazy" />}>
                  {canEdit && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(x.path, () => showInShop(sku, x.path))}><Eye size={13} /> <Tx>{busy === x.path ? 'Saving…' : 'Show again'}</Tx></Button>}
                </Tile>))}
            </div>
          </div>)}
      </>}
    </div>
  );
}

const LOCAL_TEXT: Record<LocalState, { label: string; tone: 'good' | 'warn' | 'info' | '' }> = {
  shown: { label: 'Shown in the online shop', tone: 'good' }, removed: { label: 'Not shown in the online shop', tone: '' }, waiting: { label: 'Waiting to be sent', tone: 'warn' },
  earlier: { label: 'Sent earlier', tone: 'info' }, full: { label: 'The shop already has 6 pictures', tone: '' },
};
/** Under a picture of this browser: where it stands in the shop, and X / "Show again" when the shop does not have it yet. */
export function LocalShopStatus({ m, pics, canEdit }: { m: MediaFile; pics: ShopPics; canEdit: boolean }) {
  if (!pics.state) return null;
  const k = localState(m, pics.state);
  return (
    <div className="row gap-6 wrap mt8" data-testid="local-shop-status">
      <Badge tone={LOCAL_TEXT[k].tone}><Tx>{LOCAL_TEXT[k].label}</Tx></Badge>
      {canEdit && k === 'waiting' && <Button size="sm" variant="ghost" onClick={() => setShopHidden(m.id, true)}><X size={13} /> <Tx>Do not send</Tx></Button>}
      {canEdit && k === 'removed' && m.shopHidden && <Button size="sm" variant="ghost" onClick={() => setShopHidden(m.id, false)}><Eye size={13} /> <Tx>Show again</Tx></Button>}
    </div>
  );
}

const COUNTDOWN = 10;
const RETRY_AFTER = [5_000, 20_000];
const PAUSED = 'shop.pictures.paused';
const readPaused = () => { try { return sessionStorage.getItem(PAUSED) === '1'; } catch { return false; } };
const savePaused = (v: boolean) => { try { if (v) sessionStorage.setItem(PAUSED, '1'); else sessionStorage.removeItem(PAUSED); } catch { /* ignore */ } };
type Phase = 'idle' | 'countdown' | 'paused' | 'sending' | 'done' | 'failed';

/**
 * Sends the pictures of this browser to the online shop by itself. Mounted once in the Shell for ADMIN / SUPER_ADMIN. Nothing is shown, and the server is not asked, when there is nothing to send.
 * The countdown stands still while the pointer or the focus is on the card and while the tab is hidden, so nothing is published unseen.
 */
export function AutoPictures() {
  const db = useDB();
  const lang = useLang();
  const [list, setList] = useState<Waiting[]>([]);
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [left, setLeft] = useState(COUNTDOWN);
  const [over, setOver] = useState(false);          // a mouse on the card (a finger has no "leave")
  const [focus, setFocus] = useState(false);
  const hold = over || focus;
  const [progress, setProgress] = useState<{ done: number; total: number; pictures: number; failed: string[] }>({ done: 0, total: 0, pictures: 0, failed: [] });
  const phaseRef = useRef<Phase>('idle');
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const tries = useRef(0);
  const alive = useRef(true);
  const checkNo = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);

  const check = useCallback(async () => {
    if (phaseRef.current === 'sending') return;
    const no = ++checkNo.current;
    let w: Waiting[];
    try { w = await picturesWaiting(useStore.getState().db); } catch { return; }             // the shop cannot be asked now: asked again when something changes or the connection is back
    if (!alive.current || no !== checkNo.current || (phaseRef.current as Phase) === 'sending') return;
    setList(w);
    if (!w.length) { if (phaseRef.current !== 'done' && phaseRef.current !== 'failed') setPhase('idle'); return; }
    if (phaseRef.current === 'idle' || phaseRef.current === 'done') { setLeft(COUNTDOWN); setPhase(readPaused() ? 'paused' : 'countdown'); }
  }, []);
  const sig = db.products.filter((p) => p.mediaIds.length > 0 && isShopSku(p.sku)).map((p) => `${p.sku}:${p.mediaIds.map((id) => id + (db.media.find((m) => m.id === id)?.shopHidden ? '-' : '')).join('+')}`).join(',');
  useEffect(() => { const h = setTimeout(() => void check(), 400); return () => clearTimeout(h); }, [sig, check]);
  useEffect(() => {
    const online = () => { if (phaseRef.current === 'failed') setPhase('idle'); void check(); };
    window.addEventListener('online', online);
    const off = onPicturesChanged(() => void check());
    return () => { window.removeEventListener('online', online); off(); };
  }, [check]);

  const send = useCallback(async (rows: Waiting[]) => {
    if (phaseRef.current === 'sending' || !rows.length) return;
    clearTimeout(timer.current);
    setPhase('sending'); savePaused(false);
    let done = 0, pictures = 0; const failed: string[] = []; let net = false;
    setProgress({ done, total: rows.length, pictures, failed });
    for (const w of rows) {
      try {
        const r = await sendPictures(w.product.sku, w.media, stillWanted);
        pictures += r.added; done++;
        if (r.unreadable) failed.push(`${w.product.sku}: ${tl(lang, 'no picture could be read')}`);
      } catch (e) { const m = why(e); if (networkTrouble(m)) net = true; failed.push(`${w.product.sku}: ${m}`); }
      if (alive.current) setProgress({ done, total: rows.length, pictures, failed: [...failed] });
    }
    if (!alive.current) return;
    if (failed.length) {
      setPhase('failed');
      if (net && tries.current < RETRY_AFTER.length) {                                          // the connection: try again by itself; a refusal is not repeated
        const wait = RETRY_AFTER[tries.current++];
        timer.current = setTimeout(() => { void picturesWaiting(useStore.getState().db).then((x) => { if (alive.current && phaseRef.current === 'failed') { setList(x); if (x.length) void send(x); else setPhase('idle'); } }).catch(() => undefined); }, wait);
      }
      return;
    }
    tries.current = 0; setList([]); setPhase('done');
    timer.current = setTimeout(() => { if (phaseRef.current === 'done') setPhase('idle'); }, 6000);
    void check();
  }, [lang, check]);

  useEffect(() => {
    if (phase !== 'countdown' || hold) return;
    const h = setInterval(() => { if (document.visibilityState === 'visible') setLeft((n) => Math.max(0, n - 1)); }, 1000);
    return () => clearInterval(h);
  }, [phase, hold]);
  useEffect(() => { if (phase === 'countdown' && left === 0) void send(list); }, [phase, left, list, send]);

  const drop = (m: MediaFile) => {
    setShopHidden(m.id, true);
    const next = list.map((w) => ({ ...w, media: w.media.filter((x) => x.id !== m.id) })).filter((w) => w.media.length);
    setList(next); setLeft(COUNTDOWN); setFocus(false);        // the focused X is gone with its picture
    if (!next.length) { setPhase('idle'); toast('info', tl(lang, 'Nothing will be sent. The pictures stay in this browser.')); }
  };
  useEffect(() => { if (phase === 'idle') { setOver(false); setFocus(false); } }, [phase]);
  if (phase === 'idle') return null;
  const pictures = list.reduce((n, w) => n + w.media.length, 0);
  const asking = phase === 'countdown' || phase === 'paused';
  return (
    <section className="pic-auto" role="region" aria-label={tl(lang, 'Product pictures for the online shop')} data-testid="auto-pictures" data-phase={phase}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOver(true); }} onPointerLeave={() => setOver(false)}
      onFocus={(e) => { if (e.target.matches(':focus-visible')) setFocus(true); }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocus(false); }}>
      {asking && <>
        <div className="pic-auto-h"><CloudUpload size={17} /><b>{tl(lang, '{n} product pictures for the online shop', { n: pictures })}</b></div>
        <div className="muted" aria-live="off">{phase === 'paused' ? tl(lang, 'Paused. Nothing is sent until you press Send now.') : hold ? tl(lang, 'Waiting for you. Press X on a picture customers must not see.') : tl(lang, 'Customers see them in {s} seconds. Press X on a picture they must not see.', { s: left })}</div>
        <div className="pic-auto-list">
          {list.map((w) => w.media.map((m) => (
            <Tile key={m.id} testid="auto-pic" img={<MediaImg m={m} size={72} />} x={() => drop(m)} xLabel={`${tl(lang, 'Do not send')}: ${w.product.sku} ${m.name}`}><span className="pic-sku" title={w.product.name}>{w.product.sku}</span></Tile>)))}
        </div>
        <div className="row gap-6 wrap">
          <Button size="sm" variant="primary" onClick={() => void send(list)}><Tx>Send now</Tx></Button>
          {phase === 'countdown' ? <Button size="sm" onClick={() => { savePaused(true); setPhase('paused'); }}><Tx>Hold for now</Tx></Button>
            : <Button size="sm" onClick={() => { savePaused(false); setLeft(COUNTDOWN); setPhase('countdown'); }}><Tx>Continue automatically</Tx></Button>}
        </div>
      </>}
      {phase === 'sending' && <div role="status" className="pic-auto-h"><span className="spinner sm" /><b>{tl(lang, 'Sending pictures to the online shop… {d} of {t} products', { d: progress.done, t: progress.total })}</b></div>}
      {phase === 'done' && <div role="status" className="pic-auto-h good"><CheckCircle2 size={17} /><b>{tl(lang, '{n} pictures are now in the online shop', { n: progress.pictures })}</b></div>}
      {phase === 'failed' && <>
        <div role="alert" className="pic-auto-h bad"><b>{tl(lang, 'Some pictures were not sent')}</b></div>
        <div className="muted" style={{ overflowWrap: 'anywhere' }}>{progress.failed.slice(0, 4).join(' · ')}</div>
        <div className="row gap-6"><Button size="sm" variant="primary" onClick={() => { tries.current = 0; void picturesWaiting(useStore.getState().db).then((x) => { setList(x); if (x.length) void send(x); else setPhase('idle'); }).catch((e) => setProgress((p) => ({ ...p, failed: [why(e)] }))); }}><Tx>Retry</Tx></Button>
          <Button size="sm" onClick={() => setPhase('idle')}><Tx>Close</Tx></Button></div>
      </>}
    </section>
  );
}

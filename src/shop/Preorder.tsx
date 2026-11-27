// Preorder (scheduled pickup) in the customer app: the day / time picker used at checkout and when changing a time, the quick instructions, the confirmation body,
// and the schedule panel of the order page (progress, updates, change, ask the shop, cancel). Every rule (what is bookable, what may still change) is the database's;
// this file only shows it. All times are shown in shop time (Asia/Bangkok).
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, MessageSquare, Pencil } from 'lucide-react';
import { toast } from '../domain/store';
import { cx } from '../lib/util';
import { Banner } from '../ui/kit';
import { PreorderDay, PreorderOptions, PreorderSlot, PreorderSlots, shop, ShopError, ShopOrder } from './api';
import { baht, shopDateTime } from './format';
import { K, ShopLang, useShopLang, useT } from './i18n';
import { addPhrase, bkkDayKey, changeOpen, dayParts, dayState, firstBookableDay, groupSlots, hasPhrase, leadWords, pickupLabel, pickupLong, KNOWN_NOTICES } from './preorderView';
import { ErrorBox, errText, Fold, ProductImage } from './ui';

// ---------------------------------------------------------------- data
/** The preorder calendar (days, lead time, note), or null while it loads / when the shop offers no preorder. */
export function usePreorderOptions(on: boolean) {
  const [st, setSt] = useState<{ options: PreorderOptions | null; loading: boolean; error: unknown }>({ options: null, loading: on, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) { setSt({ options: null, loading: false, error: null }); return; }
    let live = true;
    setSt((s) => ({ ...s, loading: true, error: null }));
    shop.preorderOptions().then((options) => { if (live) setSt({ options, loading: false, error: null }); }).catch((error) => { if (live) setSt((s) => ({ ...s, loading: false, error })); });
    return () => { live = false; };
  }, [on, tick]);
  return { ...st, reload: useCallback(() => setTick((x) => x + 1), []) };
}

/** The times of one day for a basket of `units` units. A late answer never overwrites a newer one. */
function useSlots(day: string | null, units: number, tick: number) {
  const [st, setSt] = useState<{ data: PreorderSlots | null; loading: boolean; error: unknown }>({ data: null, loading: false, error: null });
  const req = useRef(0);
  useEffect(() => {
    if (!day) { setSt({ data: null, loading: false, error: null }); return; }
    const id = ++req.current;
    setSt((s) => ({ ...s, loading: true, error: null }));
    shop.preorderSlots(day, units)
      .then((data) => { if (id === req.current) setSt({ data, loading: false, error: null }); })
      .catch((error) => { if (id === req.current) setSt({ data: null, loading: false, error }); });
  }, [day, units, tick]);
  return st;
}

// ---------------------------------------------------------------- the picker
const dayLabel = (d: PreorderDay, today: string, lang: ShopLang, t: ReturnType<typeof useT>) => {
  const p = dayParts(d.day, lang);
  const tomorrow = bkkDayKey(new Date(new Date(`${today}T12:00:00+07:00`).getTime() + 86_400_000));
  return { top: d.day === today ? t('po.today') : d.day === tomorrow ? t('po.tomorrow') : p.weekday, bottom: p.date };
};

/**
 * Choose a day, then a time. `value` is the start of the chosen slot (ISO) or ''. `units` is what the basket weighs (the capacity of a slot is counted in orders and units).
 * `onChange` also fires with '' when the chosen time is no longer offered (it filled up, or its time passed), so the screen never keeps a stale choice.
 */
export function PickupPicker({ units, value, onChange, reloadKey = 0 }: { units: number; value: string; onChange: (at: string) => void; reloadKey?: number }) {
  const t = useT();
  const lang = useShopLang();
  const { options, loading, error, reload } = usePreorderOptions(true);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const day = pickedDay ?? (value ? bkkDayKey(value) : null) ?? firstBookableDay(options?.days);
  const [tick, setTick] = useState(0);
  const slots = useSlots(options?.enabled ? day : null, units, tick + reloadKey);
  // a chosen time that the server no longer offers is dropped
  useEffect(() => {
    if (!value || !slots.data || slots.data.day !== bkkDayKey(value)) return;
    const s = slots.data.slots.find((x) => x.at === value || new Date(x.at).getTime() === new Date(value).getTime());
    if (!s || s.state !== 'ok') onChange('');
  }, [slots.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosenRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { chosenRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' }); }, [options]);

  if (loading && !options) return <div className="sp-note" aria-busy="true">{t('po.loading')}</div>;
  if (error && !options) return <ErrorBox message={`${t('po.loadError')} · ${errText(t, error)}`} onRetry={reload} />;
  if (!options?.enabled) return <Banner tone="warn">{t('po.unavailable')}</Banner>;
  const today = bkkDayKey(options.now ?? new Date());
  const lead = leadWords(options.lead_minutes ?? 0);
  const days = options.days ?? [];
  const pick = (d: PreorderDay) => { setPickedDay(d.day); if (value && bkkDayKey(value) !== d.day) onChange(''); };
  return (
    <div className="sp-po" data-testid="pickup-picker">
      <div className="sp-note">{t('po.leadNote', { lead: t(lead.key, lead.vars), days: options.max_advance_days ?? 14 })}</div>
      {options.note && <div className="sp-note"><b>{options.note}</b></div>}
      <div role="radiogroup" aria-label={t('po.day')} className="sp-days">
        {days.map((d) => {
          const st = dayState(d); const l = dayLabel(d, today, lang, t); const on = d.day === day;
          return (
            <button key={d.day} type="button" role="radio" aria-checked={on} ref={on ? chosenRef : undefined} disabled={st !== 'ok'} data-day={d.day} data-state={st}
              className={cx('sp-day', on && 'on', st !== 'ok' && 'off')} onClick={() => pick(d)}>
              <span>{l.top}</span><b>{l.bottom}</b>{st !== 'ok' && <small>{t(st === 'closed' ? 'po.closedDay' : 'po.fullDay')}</small>}
            </button>
          );
        })}
      </div>
      {day && <Slots data={slots.data} loading={slots.loading} error={slots.error} value={value} onChange={onChange} onRetry={() => setTick((x) => x + 1)} />}
      {value && <div className="sp-po-chosen" role="status" data-testid="pickup-chosen"><Check size={16} aria-hidden /> {t('po.chosen', { when: pickupLong(value, lang) })}</div>}
    </div>
  );
}

function Slots({ data, loading, error, value, onChange, onRetry }: { data: PreorderSlots | null; loading: boolean; error: unknown; value: string; onChange: (at: string) => void; onRetry: () => void }) {
  const t = useT();
  if (error && !data) return <ErrorBox message={`${t('po.loadError')} · ${errText(t, error)}`} onRetry={onRetry} />;
  if (!data) return <div className="sp-note" aria-busy="true">{t('po.loading')}</div>;
  if (data.closed) return <div className="sp-note bad">{t('po.closedMsg', { reason: data.reason ? `: ${data.reason}` : '' })}</div>;
  const groups = groupSlots(data.slots);
  const none = !data.slots.some((s) => s.state === 'ok');
  return (
    <div aria-busy={loading} className="sp-slotsbox">
      {data.open && data.close && <div className="sp-note">{t('po.opening', { open: data.open, close: data.close })}</div>}
      {none && <div className="sp-note bad">{t('po.noSlots')}</div>}
      {groups.map((g) => (
        <div key={g.key} className="sp-slotgroup">
          <h4>{t(`po.g.${g.key}` as K)}</h4>
          <div className="sp-slots" role="radiogroup" aria-label={t('po.time')}>
            {g.slots.map((s) => <SlotButton key={s.at} s={s} on={new Date(s.at).getTime() === new Date(value || 0).getTime()} onPick={() => onChange(s.at)} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function SlotButton({ s, on, onPick }: { s: PreorderSlot; on: boolean; onPick: () => void }) {
  const t = useT();
  const off = s.state !== 'ok';
  return (
    <button type="button" role="radio" aria-checked={on} disabled={off} data-slot={s.time} data-state={s.state} className={cx('sp-slot', on && 'on', off && 'off')} onClick={onPick}
      aria-label={off ? `${s.time} · ${t(`po.slot.${s.state}` as K)}` : s.time}>
      <b>{s.time}</b>{off && <small>{t(`po.slot.${s.state}` as K)}</small>}
    </button>
  );
}

/** The quick instructions under the note box: one tap adds the sentence. */
export function QuickPhrases({ note, onChange, max = 300 }: { note: string; onChange: (n: string) => void; max?: number }) {
  const t = useT();
  const phrases: K[] = ['po.ph.ready', 'po.ph.separate', 'po.ph.call'];
  return (
    <div className="sp-phrases" data-testid="quick-phrases">
      <small className="muted">{t('po.phrases')}</small>
      <div className="sp-chips wrap">
        {phrases.map((k) => { const text = t(k); const on = hasPhrase(note, text); return <button key={k} type="button" aria-pressed={on} className={cx(on && 'on')} onClick={() => onChange(on ? note.replace(text, '').replace(/\s{2,}/g, ' ').trim() : addPhrase(note, text, max))}>{on ? '✓ ' : '+ '}{text}</button>; })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the confirmation
/** The body of the confirmation sheet: everything the customer is about to commit to, on one screen. */
export function PreorderSummary({ lines, pickupAt, note, method, total }: {
  lines: { sku_code: string; name?: string; qty: number; unit_price?: number; line_total?: number; image_url?: string | null }[]; pickupAt: string; note: string; method: string; total: number;
}) {
  const t = useT();
  const lang = useShopLang();
  return (
    <div className="sp-po-sum" data-testid="preorder-summary">
      <dl>
        <div><dt>{t('po.cf.type')}</dt><dd>{t('po.mode')}</dd></div>
        <div><dt>{t('po.cf.when')}</dt><dd data-testid="summary-when"><b>{pickupLong(pickupAt, lang)}</b></dd></div>
        <div><dt>{t('po.cf.pay')}</dt><dd>{method}</dd></div>
        <div><dt>{t('po.cf.note')}</dt><dd>{note.trim() || t('po.cf.none')}</dd></div>
      </dl>
      <h4>{t('po.cf.items')}</h4>
      <ul className="sp-mini">{lines.map((l) => <li key={l.sku_code}><ProductImage src={l.image_url} alt="" /><span className="grow">{l.name ?? l.sku_code}<small> {l.unit_price != null ? `${baht(l.unit_price)} × ` : '× '}{l.qty}</small></span>{l.line_total != null && <b>{baht(l.line_total)}</b>}</li>)}</ul>
      <div className="row between sp-total"><b>{t('po.cf.total')}</b><b>{baht(total)}</b></div>
      <div className="sp-note">{t('po.cf.hint')}</div>
    </div>
  );
}

// ---------------------------------------------------------------- the order page
/** The schedule section of a preorder's page: when, how far along, what the shop told me, and what I can still do. */
export function PreorderPanel({ o, onChanged, open, onToggle }: { o: ShopOrder; onChanged: (o: ShopOrder) => void; open: boolean; onToggle: () => void }) {
  const t = useT();
  const lang = useShopLang();
  const [mode, setMode] = useState<null | 'change' | 'ask'>(null);
  if (o.order_type !== 'preorder' || !o.pickup_at) return null;
  const active = !['cancelled', 'returned', 'completed'].includes(o.status);
  const change = o.change;
  const canChange = active && changeOpen(change);
  const prep = o.prep;
  const notices = (o.notices ?? []).slice().reverse();
  return (
    <>
      <Fold id="schedule" open={open} onToggle={onToggle} title={t('po.od.schedule')} summary={<span data-testid="pickup-summary"><b>{pickupLabel(o.pickup_at, lang)}</b></span>}>
        <div className="sp-po-when"><CalendarClock size={18} aria-hidden /><div><b data-testid="pickup-long">{pickupLong(o.pickup_at, lang)}</b></div></div>
        {o.status === 'ready' && <Banner tone="info">{t('po.od.ready')}</Banner>}
        {prep && prep.total > 0 && ['confirmed', 'preparing', 'packed', 'ready'].includes(o.status) && (
          <div className="sp-po-prep" data-testid="prep-progress">
            <div className="row between"><span>{prep.checked >= prep.total ? t('po.od.prepDone') : t('po.od.prep', { a: prep.checked, b: prep.total })}</span></div>
            <progress max={prep.total} value={prep.checked} aria-label={t('po.od.prep', { a: prep.checked, b: prep.total })} />
          </div>
        )}
        {active && change && (canChange
          ? <div className="sp-note">{t('po.od.deadline', { when: shopDateTime(change.deadline, lang) })} · {t('po.od.left', { n: change.reschedules_left })}</div>
          : <div className="sp-note">{t('po.od.locked')}</div>)}
        <div className="sp-note">{t('po.od.items')}</div>
        {active && (
          <div className="sp-po-actions">
            {canChange && <button type="button" className="btn block" data-testid="po-change" onClick={() => setMode('change')}><Pencil size={15} /> {t('po.od.change')}</button>}
            <button type="button" className="btn block" data-testid="po-ask" onClick={() => setMode('ask')}><MessageSquare size={15} /> {t('po.od.request')}</button>
          </div>
        )}
      </Fold>
      {notices.length > 0 && (
        <section className="sp-sec" data-testid="po-updates"><h3>{t('po.od.updates')}</h3>
          <ul className="sp-updates">{notices.map((n, i) => (
            <li key={i}><small className="muted">{shopDateTime(n.at, lang)}</small><span>{noticeText(t, n)}</span></li>))}</ul>
        </section>
      )}
      {mode === 'change' && <ChangeSheet o={o} onClose={() => setMode(null)} onSaved={(r) => { setMode(null); onChanged(r); }} />}
      {mode === 'ask' && <AskSheet o={o} onClose={() => setMode(null)} />}
    </>
  );
}

function noticeText(t: ReturnType<typeof useT>, n: { kind: string; data: Record<string, unknown>; text_th: string | null }): string {
  if (!(KNOWN_NOTICES as readonly string[]).includes(n.kind)) return n.text_th ?? n.kind;
  const base = t(`po.n.${n.kind}` as K);
  const reason = typeof n.data?.reason === 'string' && n.data.reason ? ` · ${t('po.n.reason', { reason: n.data.reason })}` : '';
  return base + reason;
}

function ChangeSheet({ o, onClose, onSaved }: { o: ShopOrder; onClose: () => void; onSaved: (o: ShopOrder) => void }) {
  const t = useT();
  const [at, setAt] = useState(o.pickup_at ?? '');
  const [note, setNote] = useState(o.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const units = o.items.reduce((s, i) => s + i.qty, 0);
  const moved = !!at && new Date(at).getTime() !== new Date(o.pickup_at ?? 0).getTime();
  const noteChanged = note.trim() !== (o.note ?? '').trim();
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await shop.changePreorder(o.id, { ...(moved ? { pickup_at: at } : {}), ...(noteChanged ? { note } : {}) });
      toast('success', t('po.od.changed')); onSaved(r);
    } catch (e) {
      setErr(errText(t, e));
      if (e instanceof ShopError && /^(SLOT_|DAY_UNITS)/.test(e.code)) { setAt(o.pickup_at ?? ''); setReloadKey((k) => k + 1); }
    } finally { setBusy(false); }
  };
  return (
    <div className="sp-sheet" role="dialog" aria-modal="true" aria-label={t('po.od.changeTitle')} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sp-sheet-card sp-sheet-tall">
        <h3>{t('po.od.changeTitle')}</h3>
        <div className="sp-sheet-body">
          <PickupPicker units={units} value={at} onChange={setAt} reloadKey={reloadKey} />
          <label className="sp-form-l">{t('co.note')}<textarea value={note} rows={3} maxLength={300} data-testid="po-note" onChange={(e) => setNote(e.target.value)} /></label>
          <QuickPhrases note={note} onChange={setNote} />
          {err && <Banner tone="bad">{err}</Banner>}
        </div>
        <div className="sp-sheet-btns">
          <button type="button" className="btn lg" onClick={onClose} disabled={busy}>{t('common.close')}</button>
          <button type="button" className="btn lg primary" data-testid="po-save" onClick={save} disabled={busy || (!moved && !noteChanged) || !at}>{busy ? '…' : t('po.od.changeSave')}</button>
        </div>
      </div>
    </div>
  );
}

function AskSheet({ o, onClose }: { o: ShopOrder; onClose: () => void }) {
  const t = useT();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setErr(null);
    try { await shop.requestPreorderChange(o.id, msg.trim()); toast('success', t('po.od.requestSent')); onClose(); }
    catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  return (
    <div className="sp-sheet" role="dialog" aria-modal="true" aria-label={t('po.od.request')} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sp-sheet-card">
        <h3>{t('po.od.request')}</h3>
        <div className="sp-sheet-body">
          <p className="sp-note">{t('po.od.requestHint')}</p>
          <label className="sp-form-l">{t('po.od.requestLabel')}<textarea value={msg} rows={4} maxLength={300} data-testid="po-msg" onChange={(e) => setMsg(e.target.value)} /></label>
          {err && <Banner tone="bad">{err}</Banner>}
        </div>
        <div className="sp-sheet-btns">
          <button type="button" className="btn lg" onClick={onClose} disabled={busy}>{t('common.close')}</button>
          <button type="button" className="btn lg primary" data-testid="po-send" onClick={send} disabled={busy || msg.trim().length < 3}>{busy ? '…' : t('po.od.requestSend')}</button>
        </div>
      </div>
    </div>
  );
}


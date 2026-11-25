import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { roleLabel, findAcct } from '../domain/accounting';
import { toast, useDB, useLang, useStore } from '../domain/store';
import type { Ctx } from '../domain/core';
import type { DB, ID, Journal, ProductionOrder } from '../domain/types';
import { Badge, Banner, ErrText, NumInput, useConfirm, useHas, useRun } from '../ui/kit';
import { money, qtyFmt } from '../lib/util';
import { t as tl } from '../lib/i18n';
import { STATUS, dryRun, effectOf, missingRoles, newKey, type Effect } from './forms';

export type Go = (q: Record<string, string>) => void;
/** What a person may do here. Costs, values and margins are shown only with finance:cost. */
export function useMay() {
  return { create: useHas('production:create'), edit: useHas('production:edit'), approve: useHas('production:approve'), cost: useHas('finance:cost') };
}
export function useT() {
  const lang = useLang();
  return useCallback((s: string, vars?: Record<string, string | number>) => tl(lang, s, vars), [lang]);
}
export const prodOf = (db: DB, id: ID) => db.products.find((p) => p.id === id);
export const nameOf = (db: DB, id: ID) => prodOf(db, id)?.name ?? id;
export const unitOf = (db: DB, id: ID) => prodOf(db, id)?.unit ?? '';
export const whName = (db: DB, id?: ID) => db.warehouses.find((w) => w.id === id)?.name ?? id ?? '';
export const userName = (db: DB, id?: ID) => db.users.find((u) => u.id === id)?.name ?? '';
export const journalOf = (db: DB, id?: ID): Journal | undefined => (id ? db.journals.find((j) => j.id === id) : undefined);

/** One key for as long as this form is open. A form closes when it has succeeded, so the next one gets a new key and a second tap on the same one posts nothing more. */
export const useKey = () => useState(newKey)[0];
/** A number field that may be empty (NaN inside the form, never shown as 0). */
export function Num({ value, onChange, ...p }: Omit<React.ComponentProps<typeof NumInput>, 'value'> & { value: number }) {
  return <NumInput {...p} min={0} value={Number.isFinite(value) ? value : ''} onChange={onChange} />;
}
export function OrderBadge({ s }: { s: ProductionOrder['status'] }) { return <Badge tone={STATUS[s].tone} dot>{STATUS[s].label}</Badge>; }
/** An amount, or "Unknown": a missing cost is never 0. */
export function Cost({ v, bold }: { v: number | null | undefined; bold?: boolean }) {
  const T = useT();
  if (v == null || !Number.isFinite(v)) return <span className="badge warn" title={T('The cost is not known')}>{T('Unknown cost')}</span>;
  return bold ? <b>{money(v)}</b> : <>{money(v)}</>;
}
export function NoData() { const T = useT(); return <span className="muted">{T('No data')}</span>; }
/** Names what has no cost: "Labour cost" and "Overhead cost" are names the engine uses, the rest are products. */
export function Missing({ list }: { list: string[] }) {
  const T = useT();
  if (!list.length) return null;
  return <Banner tone="warn"><><b>{T('Cost not known:')}</b> {list.map((m) => T(m)).join(', ')}. {T('The total stays unknown until it is recorded. It is not counted as 0.')}</></Banner>;
}
export function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <div className="mfg-err" role="alert">{list.map((m) => <div key={m}><ErrText>{m}</ErrText></div>)}</div>;
}
export function Qty({ n, unit }: { n: number; unit: string }) { return <span className="num" style={{ whiteSpace: 'nowrap' }}>{qtyFmt(n)} {unit}</span>; }

export function RoleBanner() {
  const db = useDB(), T = useT(), canSee = useHas('accounting:view');
  const roles = missingRoles(db);
  if (!roles.length) return null;
  return (
    <div className="mb16" data-testid="role-banner"><Banner tone="bad"><><b>{T('Production cannot post yet.')}</b> {T('These posting roles have no usable account:')} {roles.map((r) => T(roleLabel(r))).join(', ')}.{' '}
      {canSee ? <Link to="/accounting/setup">{T('Open accounting setup')}</Link> : T('Please ask the accountant to complete the transaction mapping.')}</></Banner></div>
  );
}

/** One journal entry: account, debit, credit. */
export function Entries({ lines }: { lines: { account: string; debit: number; credit: number }[] }) {
  const db = useDB(), T = useT(), lang = useLang(), { cost } = useMay();
  const name = (code: string) => { const a = findAcct(db, code); return a ? (lang === 'th' ? a.nameTh || a.name : a.name) : code; };
  return (
    <div className="mfg-je" role="list">{lines.map((l, i) => (
      <div key={i} role="listitem" className={l.debit > 0 ? 'mfg-dr' : 'mfg-cr'}><span>{l.debit > 0 ? T('Debit') : T('Credit')}</span><span><span className="mono">{l.account}</span> {name(l.account)}</span>{cost && <b className="num">{money(l.debit || l.credit)}</b>}</div>
    ))}</div>
  );
}
function EffectView({ effect, words, unknown, warn, facts }: { effect: Effect; words: string[]; unknown: boolean; warn?: string; facts?: string[] }) {
  const db = useDB(), T = useT(), { cost } = useMay();
  const e = effectOf(effect);
  return (
    <div className="col" data-testid="posting-effect">
      {warn && <div data-testid="posting-warn"><Banner tone="warn">{warn}</Banner></div>}
      {unknown && <Banner tone="warn"><><b>{T('The cost is not known')}.</b> {e.unknown.length ? T('These items leave stock without a cost: {list}. The finished goods will look cheaper than they are, and the profit will look higher.', { list: e.unknown.map((id) => nameOf(db, id)).join(', ') }) : T('There is no cost left in this order for these goods. Usually the materials still have to be issued: go back and use “Record production”. If you continue, the goods enter stock without a cost and their profit looks higher than it is.')}</></Banner>}
      {words.map((w) => <div key={w}>{T(w)}</div>)}
      {facts?.map((w) => <div key={w} data-testid="posting-fact"><b>{w}</b></div>)}
      <div>
        <b>{T('Stock movement')}</b>
        {e.stock.length ? e.stock.map((m, i) => (
          <div key={i} className="row between" style={{ gap: 8 }}><span>{nameOf(db, m.productId)} <span className="muted">· {whName(db, m.warehouseId)}</span></span><b className={m.qty > 0 ? 'good' : 'bad'} style={{ whiteSpace: 'nowrap' }}>{m.qty > 0 ? '+' : '−'}{qtyFmt(Math.abs(m.qty))} {unitOf(db, m.productId)}</b></div>
        )) : <div className="muted">{T('No stock movement')}</div>}
      </div>
      <div><b>{T('Journal entry')}</b>{e.entries.length ? <Entries lines={e.entries} /> : <div className="muted">{T('No journal entry')}</div>}</div>
      {!cost && <div className="muted">{T('Amounts are hidden for your role.')}</div>}
    </div>
  );
}
interface PostOpts<R> {
  title: string; words: string[]; ok: string; confirmLabel?: string; danger?: boolean; reason?: boolean | string;
  /** a warning on top (already in the language of the screen) */ warn?: string; /** plain sentences about what the posting does, read from the copy it was tried on */ facts?: (next: DB) => string[];
  exec: (d: DB, c: Ctx, x: { allowUnknown: boolean; reason: string }) => R; onOk?: (r: R) => void;
}
/**
 * Posts after one confirmation that states the real effect: the engine is run on a throw-away copy first, so what is shown is what will be posted.
 * A refusal because a cost is not known can be confirmed by the person; any other refusal is shown as it is and nothing is asked.
 */
export function usePost() {
  const run = useRun(), confirm = useConfirm(), busy = useRef(false);
  return async function postIt<R>(o: PostOpts<R>): Promise<void> {
    if (busy.current) return; // the same button pressed again while the question is open
    const db = useStore.getState().db, test = (allowUnknown: boolean) => dryRun(db, (d, c) => o.exec(d, c, { allowUnknown, reason: '-' }));
    let r = test(false);
    const unknown = r.error?.code === 'UNKNOWN_COST' || r.error?.code === 'NO_COST';
    if (unknown) r = test(true);
    if (!r.effect) { toast('error', r.error?.message || 'Something went wrong'); return; }
    busy.current = true;
    try {
      const x = await confirm({ title: o.title, body: <EffectView effect={r.effect} words={o.words} unknown={unknown} warn={o.warn} facts={o.facts?.(r.next!)} />, confirmLabel: unknown ? 'Post without a cost' : o.confirmLabel ?? 'Post', danger: o.danger || unknown, reason: o.reason });
      if (x.ok) run((d, c) => o.exec(d, c, { allowUnknown: unknown, reason: x.reason }), { ok: o.ok, onOk: o.onOk });
    } finally { busy.current = false; }
  };
}
/** Label and value pairs that wrap instead of overflowing. */
export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="mfg-facts">{items.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

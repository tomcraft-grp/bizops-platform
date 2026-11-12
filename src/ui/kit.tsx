import { Children, cloneElement, createContext, isValidElement, ReactElement, ReactNode, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, Info, Search, X, XCircle } from 'lucide-react';
import type { ChannelCode, DB, OrderStatus } from '../domain/types';
import { CHANNELS, STATUS_LABEL } from '../domain/meta';
import { Ctx, can, hasPerm, userPerms, currentUser } from '../domain/core';
import { act, toast, useDB, useStore } from '../domain/store';
import { cx, money } from '../lib/util';
import { reconciliationMatrix } from '../domain/setup';

// ---------- action runner (transaction + toast)
export function useRun() {
  return useCallback(<T,>(fn: (d: DB, ctx: Ctx) => T, opts?: { ok?: string; perm?: string; onOk?: (r: T) => void; onErr?: (e: Error) => void }): T | undefined => {
    try {
      const r = act(fn, { perm: opts?.perm });
      if (opts?.ok) toast('success', opts.ok);
      opts?.onOk?.(r);
      return r;
    } catch (e) {
      toast('error', (e as Error).message || 'Something went wrong');
      opts?.onErr?.(e as Error);
      return undefined;
    }
  }, []);
}
export function useCan() {
  const db = useDB();
  return useCallback((perm: string) => can(db, perm), [db]);
}
export const useUser = () => { const db = useDB(); return currentUser(db); };
export const useHas = (perm: string) => { const db = useDB(); return hasPerm(userPerms(db, currentUser(db)), perm); };
export const useScope = () => useStore((s) => s.ui.branchScope);

// ---------- basic bits
type Tone = 'good' | 'warn' | 'bad' | 'info' | 'serious' | '';
export function Badge({ tone = '', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={cx('badge', tone)}>{dot && <i className="dot" />}{children}</span>;
}
export function Button({ variant, size, icon, loading, className, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost' | 'soft'; size?: 'sm' | 'lg'; icon?: boolean; loading?: boolean }) {
  return <button type="button" {...p} className={cx('btn', variant, size, icon && 'icon', className)}>{children}</button>;
}
export function Card({ title, sub, actions, children, className, flush, footer }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; flush?: boolean; footer?: ReactNode }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <div className="card-h">
          <div><h2>{title}</h2>{sub && <div className="sub">{sub}</div>}</div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={cx('card-b', flush && 'flush')}>{children}</div>
      {footer && <div className="card-f">{footer}</div>}
    </section>
  );
}
export function Kpi({ label, value, sub, icon, delta, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode; delta?: number | null; tone?: 'good' | 'bad' }) {
  return (
    <div className="card kpi">
      <div className="lbl">{icon && <span className="kpi-ico">{icon}</span>}{label}</div>
      <div className={cx('val', tone)}>{value}</div>
      <div className="sub">
        {delta != null && isFinite(delta) && <span className={cx('delta', delta >= 0 ? 'up' : 'down')}>{delta >= 0 ? <ArrowUp size={12} style={{ verticalAlign: -1 }} /> : <ArrowDown size={12} style={{ verticalAlign: -1 }} />}{Math.abs(delta * 100).toFixed(1)}%</span>}
        {sub}
      </div>
    </div>
  );
}
export function PageHead({ title, desc, actions, crumb }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode; crumb?: string }) {
  return (
    <div className="page-head">
      <div>{crumb && <div className="crumb">{crumb}</div>}<h1>{title}</h1>{desc && <p>{desc}</p>}</div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}
export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="ico">{icon ?? <Search size={22} />}</div><b>{title}</b>{hint && <div className="muted" style={{ maxWidth: 380 }}>{hint}</div>}{action}</div>;
}
export function Banner({ tone = 'info', children, icon }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode; icon?: ReactNode }) {
  const I = tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'good' ? CheckCircle2 : Info;
  return <div className={cx('banner', tone === 'info' ? '' : tone)}>{icon ?? <I size={16} />}<div>{children}</div></div>;
}
const rgb = (hex: string): [number, number, number] => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lumOf = ([r, g, b]: [number, number, number]) => { const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
/** Returns a background/foreground pair that meets WCAG AA (4.5:1): near-black text if it passes, else white on a darkened colour */
export function readablePair(bg: string): { bg: string; fg: string } {
  if (!bg.startsWith('#')) return { bg, fg: '#ffffff' };
  const c = rgb(bg);
  if (contrast(lumOf(c), lumOf([17, 17, 17])) >= 4.5) return { bg, fg: '#111111' };
  for (let f = 1; f > 0.2; f -= 0.04) {
    const d = c.map((v) => Math.round(v * f)) as [number, number, number];
    if (contrast(lumOf(d), 1) >= 4.5) return { bg: '#' + d.map((v) => v.toString(16).padStart(2, '0')).join(''), fg: '#ffffff' };
  }
  return { bg: '#000000', fg: '#ffffff' };
}
export const Avatar = ({ name, color, size = 28 }: { name: string; color: string; size?: number }) => {
  const p = readablePair(color);
  return (
    <span className="avatar" aria-hidden="true" style={{ background: p.bg, color: p.fg, width: size, height: size, fontSize: size * 0.42 }}>{name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase()}</span>
  );
};
export const Money = ({ v, bold, tone }: { v: number; bold?: boolean; tone?: boolean }) => (
  <span className={cx('num', bold && 'b', tone && (v < 0 ? 'bad' : v > 0 ? 'good' : ''))} style={bold ? { fontWeight: 650 } : undefined}>{money(v)}</span>
);
export const ChannelChip = ({ c }: { c: ChannelCode }) => <span className="chip"><i className="ch-dot" style={{ background: CHANNELS[c].color }} />{CHANNELS[c].short}</span>;
export function StatusBadge({ status }: { status: OrderStatus }) {
  const tone: Tone = status === 'completed' ? 'good' : status === 'cancelled' ? 'bad' : status === 'returned' ? 'serious' : status === 'new' ? 'info' : 'warn';
  return <Badge tone={tone} dot>{STATUS_LABEL[status]}</Badge>;
}
export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) { return <div className="skeleton" style={{ height: h, width: w }} />; }

// ---------- forms
export function Field({ label, hint, children, full }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; full?: boolean }) {
  const id = useId();
  const child = isValidElement(children) && label && !(children.props as Record<string, unknown>)['aria-label'] && !(children.props as Record<string, unknown>)['aria-labelledby'] ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-labelledby': id }) : children;
  return <div className={cx('field', full && 'full')}>{label && <label id={id}>{label}</label>}{child}{hint && <span className="hint">{hint}</span>}</div>;
}
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement> & { sm?: boolean }) => { const { sm, className, ...r } = p; return <input {...r} className={cx('input', sm && 'sm', className)} />; };
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement> & { sm?: boolean }) => {
  const { sm, className, ...r } = p;
  const first = Children.toArray(p.children).find((c) => isValidElement(c)) as ReactElement<{ children?: ReactNode }> | undefined;
  const fallback = typeof first?.props.children === 'string' ? first.props.children : undefined; // e.g. “All channels”
  return <select aria-label={r['aria-label'] ?? (r['aria-labelledby'] ? undefined : fallback)} {...r} className={cx('select', sm && 'sm', className)} />;
};
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx('textarea', p.className)} />;
export function NumInput({ value, onChange, min, max, step, ...p }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | ''; onChange: (n: number) => void }) {
  return <input {...p} type="number" inputMode="decimal" className={cx('input', p.className)} min={min} max={max} step={step ?? 'any'} value={value} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />;
}
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <div className="input-icon"><Search /><input className="input" value={value} placeholder={placeholder ?? 'Search…'} onChange={(e) => onChange(e.target.value)} /></div>;
}
export function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { v: T; label: ReactNode }[] }) {
  return <div className="seg" role="tablist">{options.map((o) => <button key={o.v} className={cx(value === o.v && 'on')} onClick={() => onChange(o.v)} role="tab" aria-selected={value === o.v}>{o.label}</button>)}</div>;
}
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { v: T; label: ReactNode; count?: number | string }[] }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.v} className={cx(value === t.v && 'on')} onClick={() => onChange(t.v)} role="tab">{t.label}{t.count != null && t.count !== '' && <span className="count">{t.count}</span>}</button>)}</div>;
}
export const Check = ({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) => (
  <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{children}</label>
);

// ---------- overlays
function useEsc(fn: () => void) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && fn(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [fn]);
}
export function Modal({ title, onClose, children, footer, size, desc }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'lg' | 'xl'; desc?: ReactNode }) {
  useEsc(onClose);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', size)} role="dialog" aria-modal="true">
        <div className="modal-h"><div><h2>{title}</h2>{desc && <div className="muted" style={{ marginTop: 2 }}>{desc}</div>}</div><Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Close"><X size={18} /></Button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>, document.body);
}
export function Drawer({ title, onClose, children, footer, sub }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; sub?: ReactNode }) {
  useEsc(onClose);
  return createPortal(
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="modal-h"><div><h2>{title}</h2>{sub && <div className="muted">{sub}</div>}</div><Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Close"><X size={18} /></Button></div>
        <div className="modal-b" style={{ flex: 1 }}>{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </aside>
    </div>, document.body);
}

interface ConfirmOpts { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; reason?: boolean | string; typeToConfirm?: string }
type Resolver = (v: { ok: boolean; reason: string }) => void;
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<{ ok: boolean; reason: string }>>(async () => ({ ok: false, reason: '' }));
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<{ o: ConfirmOpts; res: Resolver } | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const ask = useCallback((o: ConfirmOpts) => new Promise<{ ok: boolean; reason: string }>((res) => { setReason(''); setTyped(''); setSt({ o, res }); }), []);
  const done = (ok: boolean) => { st?.res({ ok, reason }); setSt(null); };
  const needReason = !!st?.o.reason;
  const blocked = (needReason && !reason.trim()) || (!!st?.o.typeToConfirm && typed !== st.o.typeToConfirm);
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {st && (
        <Modal size="sm" title={st.o.title} onClose={() => done(false)} footer={<><Button onClick={() => done(false)}>Cancel</Button><Button variant={st.o.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => done(true)}>{st.o.confirmLabel ?? 'Confirm'}</Button></>}>
          <div className="col">
            {st.o.body && <div className="text2">{st.o.body}</div>}
            {needReason && <Field label={typeof st.o.reason === 'string' ? st.o.reason : 'Reason (required, recorded in the audit log)'}><Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
            {st.o.typeToConfirm && <Field label={`Type ${st.o.typeToConfirm} to confirm`}><Input value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>}
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export function Toasts() {
  const toasts = useStore((s) => s.ui.toasts);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)} role="status">
          {t.kind === 'success' ? <CheckCircle2 size={18} color="var(--good)" /> : t.kind === 'error' ? <XCircle size={18} color="var(--crit)" /> : <Info size={18} color="var(--brand)" />}
          <div>{t.text}</div>
        </div>
      ))}
    </div>, document.body);
}
export function Popover({ trigger, children, align = 'right', width }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className="popover" style={{ top: 'calc(100% + 6px)', [align]: 0, width }}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

// ---------- data table
export interface Col<T> { key: string; header: ReactNode; render: (r: T) => ReactNode; num?: boolean; right?: boolean; sort?: (r: T) => string | number; width?: number | string; hideSm?: boolean }
export function DataTable<T>({ rows, cols, rowKey, onRow, pageSize = 12, search, empty, toolbar, initialSort, compact, footerRow, max }: {
  rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string; onRow?: (r: T) => void; pageSize?: number; search?: (r: T) => string; empty?: ReactNode; toolbar?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' }; compact?: boolean; footerRow?: ReactNode; max?: boolean;
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState(initialSort ?? null);
  const filtered = useMemo(() => {
    let r = rows;
    if (q && search) { const s = q.toLowerCase(); r = r.filter((x) => search(x).toLowerCase().includes(s)); }
    if (sort) {
      const c = cols.find((x) => x.key === sort.key);
      if (c?.sort) { const f = c.sort; r = [...r].sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1); }); }
    }
    return r;
  }, [rows, q, sort, cols, search]);
  useEffect(() => setPage(0), [q, rows.length]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const view = filtered.slice(cur * pageSize, cur * pageSize + pageSize);
  return (
    <div>
      {(search || toolbar) && <div className="row wrap" style={{ padding: '12px 14px' }}>{search && <div style={{ width: 260, maxWidth: '100%' }}><SearchBox value={q} onChange={setQ} /></div>}<div className="grow" />{toolbar}</div>}
      <div className={cx('table-wrap', max && 'max')} role="region" aria-label="Scrollable table" tabIndex={0}>
        <table className={cx('t', compact && 'compact')}>
          <thead><tr>{cols.map((c) => (
            <th key={c.key} className={cx(c.num && 'num', c.right && 'r', c.hideSm && 'hide-sm')} style={{ width: c.width, cursor: c.sort ? 'pointer' : undefined }}
              onClick={() => c.sort && setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }))}>
              {c.header}{sort?.key === c.key && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
            </th>))}</tr></thead>
          <tbody>
            {view.map((r) => (
              <tr key={rowKey(r)} className={cx(onRow && 'click')} onClick={() => onRow?.(r)}>
                {cols.map((c) => <td key={c.key} className={cx(c.num && 'num', c.right && 'r', c.hideSm && 'hide-sm')}>{c.render(r)}</td>)}
              </tr>))}
            {footerRow}
          </tbody>
        </table>
        {!filtered.length && (empty ?? <Empty title="Nothing here yet" hint={q ? 'No results match your search.' : undefined} />)}
      </div>
      {filtered.length > pageSize && (
        <div className="pager"><span>{cur * pageSize + 1}–{Math.min(filtered.length, cur * pageSize + pageSize)} of {filtered.length}</span>
          <div className="row gap-6"><Button size="sm" icon aria-label="Previous page" disabled={cur === 0} onClick={() => setPage(cur - 1)}><ChevronLeft size={15} /></Button><span>{cur + 1} / {pages}</span><Button size="sm" icon aria-label="Next page" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}><ChevronRight size={15} /></Button></div></div>
      )}
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return <div className="col gap-6">{items.map(([k, v], i) => <div key={i} className="row between" style={{ alignItems: 'flex-start' }}><span className="muted">{k}</span><span style={{ textAlign: 'right' }}>{v}</span></div>)}</div>;
}
export const Dot = ({ color }: { color: string }) => <i className="ch-dot" style={{ background: color }} />;

// ---------- report header: period, currency, basis, costing, scope, generation time, draft/posted/reconciled (QA addendum §23.11)
export function ReportHead({ title, from, to, scope }: { title: ReactNode; from?: string; to?: string; scope?: ReactNode }) {
  const db = useDB();
  const recon = useMemo(() => reconciliationMatrix(db), [db.journals, db.orders, db.allocations, db.receipts, db.apInvoices, db.balances]); // eslint-disable-line react-hooks/exhaustive-deps
  const closed = !!db.meta.lockedUntil && !!to && to <= db.meta.lockedUntil;
  const diffs = recon.filter((r) => r.status === 'diff').length;
  return (
    <div className="row wrap between" style={{ gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', borderRadius: 'var(--radius) var(--radius) 0 0', fontSize: 12.5 }}>
      <div className="text2"><b style={{ color: 'var(--text)' }}>{title}</b> · {from ? `${from} → ${to}` : `as of ${to}`} · THB · {db.org.accountingBasis} basis · costing: weighted average{scope ? <> · {scope}</> : null} · generated {new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>
      <div className="row gap-6"><Badge tone={closed ? 'good' : 'warn'} dot>{closed ? 'Posted · period closed' : 'Draft · period open'}</Badge><Badge tone={diffs ? 'bad' : 'good'} dot>{diffs ? `${diffs} reconciliation difference(s)` : 'Reconciled'}</Badge></div>
    </div>
  );
}

// Data-bound components of the customer app (Data card, Product cards, Product image, Data table, List, KPI, Chart,
// Search, Filter). Used by render.tsx for both the real customer app and the DEV APP preview. Values are always rendered
// as text by React; images must be https; data comes only from registered sources (datasources.ts).
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { useDB } from '../domain/store';
import type { ID } from '../domain/types';
import { Card } from '../ui/kit';
import { cx, dateFmt, money } from '../lib/util';
import { queryDb } from './api';
import { applyQuery, ColumnDef, localSource, PageQuery, pickFilters, pickKey, QueryResult, resolveFilters, Row } from './datasources';
import { Binding, ColType, FieldFormat, isSafeImageUrl, PropValue } from './schema';

// ---------------------------------------------------------------- page context (search box, filter chips, tapped record)
export interface PageQueryState extends PageQuery { setQ: (q: string) => void; setPick: (key: string, v: string) => void }
export const PageQueryCtx = createContext<PageQueryState>({ q: '', picks: {}, selected: null, setQ: () => {}, setPick: () => {} });
export function usePageQueryState(selected: Row | null): PageQueryState {
  const [q, setQ] = useState('');
  const [picks, setPicks] = useState<Record<string, string>>({});
  return useMemo(() => ({ q, picks, selected, setQ, setPick: (k: string, v: string) => setPicks((p) => ({ ...p, [k]: v })) }), [q, picks, selected]);
}
/** True inside the DEV APP designer: data errors are shown in full there, and quietly to customers. */
export const DesignerCtx = createContext(false);

export type Go = (target: string, record?: Row) => void;
export interface DataState extends QueryResult { loading: boolean; error: string | null }

/**
 * Rows for a binding, from app data (computed in memory) or an approved database view (customer_app_query RPC).
 * `need` = columns the component needs besides the binding's own fields. Page search / chips are applied here.
 */
export function useData(b: Binding | null, need: string[], customerId: ID | null, opts: { search?: boolean; ownPick?: string } = {}): DataState {
  const db = useDB();
  const pq = useContext(PageQueryCtx);
  const local = !!b && b.source.startsWith('local:');
  const query = useMemo(() => {
    if (!b) return null;
    const filters = resolveFilters(b, pq.selected);
    const extra = pickFilters(b.source, pq.picks).filter((f) => f.field !== opts.ownPick);
    const fields = [...new Set([...b.fields, ...need].filter(Boolean))];
    return { b: { ...b, filters }, extra, fields, search: opts.search ? pq.q : '' };
  }, [b, pq.selected, pq.picks, pq.q, need.join(), opts.search, opts.ownPick]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = JSON.stringify(query);

  const localRes = useMemo<DataState | null>(() => {
    if (!local || !query) return null;
    const s = localSource(query.b.source);
    if (!s) return { columns: [], rows: [], loading: false, error: `Unknown data source ${query.b.source}` };
    return { ...applyQuery(s.rows(db, customerId), s.columns, query.b, query.fields, query.extra, query.search), loading: false, error: null };
  }, [local, db, customerId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const [remote, setRemote] = useState<DataState>({ columns: [], rows: [], loading: true, error: null });
  useEffect(() => {
    if (local || !query) return;
    if (!query.b.agg && !query.fields.length) { setRemote({ columns: [], rows: [], loading: false, error: null }); return; }
    let on = true;
    setRemote((r) => ({ ...r, loading: true }));
    queryDb({ source: query.b.source, fields: query.fields, filters: [...query.b.filters, ...query.extra], sort: query.b.sort, limit: query.b.limit, search: query.search, agg: query.b.agg })
      .then((r) => { if (on) setRemote({ ...r, loading: false, error: null }); })
      .catch((e: Error) => { if (on) setRemote({ columns: [], rows: [], loading: false, error: e.message }); });
    return () => { on = false; };
  }, [local, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!b) return { columns: [], rows: [], loading: false, error: null };
  return local ? localRes! : remote;
}

// ---------------------------------------------------------------- value formatting
export function formatValue(v: unknown, type: ColType | undefined, format: FieldFormat = 'auto'): ReactNode {
  if (v == null || v === '') return '—';
  const f = format === 'auto' ? (type === 'money' ? 'money' : type === 'number' ? 'number' : type === 'date' ? 'date' : 'text') : format;
  if (type === 'emoji') return <span aria-hidden>{String(v)}</span>;
  if (type === 'image') return isSafeImageUrl(String(v)) ? <img src={String(v)} alt="" className="ca-thumb" /> : '—';
  if (type === 'boolean' && f === 'text') return v === true ? '✓' : '✗';
  if (f === 'money') { const n = Number(v); return isFinite(n) ? money(n) : String(v); }
  if (f === 'number') { const n = Number(v); return isFinite(n) ? n.toLocaleString() : String(v); }
  if (f === 'date') return dateFmt(String(v));
  if (f === 'badge') return <span className="ca-badge">{String(v)}</span>;
  return type === 'boolean' ? (v === true ? '✓' : '✗') : String(v);
}
const colOf = (cols: ColumnDef[], k: string) => cols.find((c) => c.key === k);
const fmtField = (row: Row, cols: ColumnDef[], b: Binding, k: string) => formatValue(row[k], colOf(cols, k)?.type, b.formats[k] ?? 'auto');

function Status({ st, children, hideWhenEmpty }: { st: DataState; children: ReactNode; hideWhenEmpty?: boolean }) {
  const designer = useContext(DesignerCtx);
  if (st.error) return designer ? <div className="ca-data-err" role="alert">⚠ {st.error}</div> : null;
  if (st.loading && !st.rows.length) return <div className="ca-data-loading" aria-busy="true"><span /><span /><span /></div>;
  if (!st.rows.length) return hideWhenEmpty ? null : <div className="muted" style={{ fontSize: 12.5 }}>Nothing to show yet.</div>;
  return <>{children}</>;
}
const str = (v: PropValue | undefined) => (typeof v === 'string' ? v : '');
const tapProps = (open: ((r: Row) => void) | undefined, r: Row) => (open ? { role: 'button' as const, tabIndex: 0, onClick: () => open(r), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') open(r); }, style: { cursor: 'pointer' } } : {});
const linkOpen = (p: Record<string, PropValue>, go: Go) => { const t = str(p.linkTab); return t ? (r: Row) => go(t, r) : undefined; };

// ---------------------------------------------------------------- components
export function DataCardSection({ p, customerId, go }: { p: Record<string, PropValue>; customerId: ID | null; go: Go }) {
  const b = p.data as Binding;
  const display = str(p.display) || 'list';
  const st = useData(b, [], customerId, { search: display !== 'single' });
  if (p.hideWhenEmpty === true && !st.loading && !st.error && !st.rows.length) return null;
  const open = linkOpen(p, go);
  const cols = b.fields.map((k) => colOf(st.columns, k)).filter(Boolean) as ColumnDef[];
  const label = (c: ColumnDef) => (p.showLabels === true ? <span className="muted">{c.label}: </span> : null);
  return (
    <Card title={str(p.title) || undefined}>
      {str(p.description) && <div className="muted" style={{ fontSize: 12.5, marginBottom: 6, whiteSpace: 'pre-wrap' }}>{str(p.description)}</div>}
      <Status st={st}>
        {display === 'single' ? (
          <div className="col gap-4" {...tapProps(open, st.rows[0])}>{cols.map((c) => <div key={c.key} className="row between" style={{ gap: 10 }}><span className="muted">{c.label}</span><b style={{ textAlign: 'right' }}>{fmtField(st.rows[0], st.columns, b, c.key)}</b></div>)}</div>
        ) : display === 'tiles' ? (
          <div className="ca-tiles">{st.rows.map((r, i) => <div key={i} className="ca-tile" {...tapProps(open, r)}>{cols.map((c, j) => <div key={c.key} className={j === 0 ? 'ca-tile-main' : 'muted'}>{label(c)}{fmtField(r, st.columns, b, c.key)}</div>)}</div>)}</div>
        ) : (
          // first field bold with the second under it; the remaining fields on the right
          <div className="col">{st.rows.map((r, i) => (
            <div key={i} className="ca-drow" {...tapProps(open, r)}>
              <span className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                {cols[0] && <b>{label(cols[0])}{fmtField(r, st.columns, b, cols[0].key)}</b>}
                {cols[1] && <span className="muted" style={{ fontSize: 12.5 }}>{label(cols[1])}{fmtField(r, st.columns, b, cols[1].key)}</span>}
              </span>
              {cols.length > 2 && <span className="col" style={{ gap: 1, alignItems: 'flex-end', textAlign: 'right', flex: 'none' }}>
                {cols.slice(2).map((c, j) => <span key={c.key} className={j === 0 ? '' : 'muted'} style={j === 0 ? { fontWeight: 650 } : { fontSize: 12 }}>{label(c)}{fmtField(r, st.columns, b, c.key)}</span>)}
              </span>}
            </div>
          ))}</div>
        )}
      </Status>
    </Card>
  );
}

function ImageCell({ v, type, size }: { v: unknown; type: ColType | undefined; size: number }) {
  if (type === 'image' && typeof v === 'string' && v && isSafeImageUrl(v)) return <img src={v} alt="" style={{ width: '100%', height: size, objectFit: 'cover', borderRadius: 'calc(var(--radius) - 2px)', display: 'block' }} />;
  return <div className="ca-pimg" style={{ height: size, fontSize: size * 0.45 }} aria-hidden>{type === 'emoji' && v ? String(v) : '🛍️'}</div>;
}

export function ProductCardsSection({ p, customerId, go }: { p: Record<string, PropValue>; customerId: ID | null; go: Go }) {
  const b = p.data as Binding;
  const roles = ['imageField', 'titleField', 'priceField', 'subField', 'badgeField'].map((k) => str(p[k]));
  const st = useData(b, roles, customerId, { search: true });
  if (p.hideWhenEmpty === true && !st.loading && !st.error && !st.rows.length) return null;
  const [img, title, price, sub, badge] = roles;
  const layout = str(p.layout) || 'grid';
  const open = linkOpen(p, go);
  const extra = b.fields.filter((k) => !roles.includes(k));
  const t = (k: string) => colOf(st.columns, k)?.type;
  return (
    <div className="col gap-8">
      {str(p.title) && <div style={{ fontSize: 17, fontWeight: 750 }}>{str(p.title)}</div>}
      <Status st={st} hideWhenEmpty={p.hideWhenEmpty === true}>
        <div className={cx(layout === 'grid' && 'ca-pgrid', layout === 'scroll' && 'ca-hscroll', layout === 'list' && 'col gap-8')}>
          {st.rows.map((r, i) => (
            <div key={i} className={cx('ca-pcard', layout === 'list' && 'row', layout === 'scroll' && 'w')} {...tapProps(open, r)}>
              {img && <div style={layout === 'list' ? { width: 64, flex: 'none' } : undefined}><ImageCell v={r[img]} type={t(img)} size={layout === 'list' ? 64 : 110} /></div>}
              <div className="col" style={{ gap: 2, minWidth: 0, padding: layout === 'list' ? 0 : '8px 10px 10px' }}>
                {badge && r[badge] != null && r[badge] !== '' && <span className="ca-badge" style={{ alignSelf: 'flex-start' }}>{fmtField(r, st.columns, b, badge)}</span>}
                {title && <b className="ca-clamp">{fmtField(r, st.columns, b, title)}</b>}
                {sub && <span className="muted ca-clamp" style={{ fontSize: 12 }}>{fmtField(r, st.columns, b, sub)}</span>}
                {extra.map((k) => <span key={k} className="muted" style={{ fontSize: 12 }}>{colOf(st.columns, k)?.label}: {fmtField(r, st.columns, b, k)}</span>)}
                {price && <b style={{ color: 'var(--brand)' }}>{fmtField(r, st.columns, b, price)}</b>}
              </div>
            </div>
          ))}
        </div>
      </Status>
    </div>
  );
}

export function ProductImageSection({ p, customerId }: { p: Record<string, PropValue>; customerId: ID | null }) {
  const b = p.data as Binding;
  const img = str(p.imageField), cap = str(p.captionField);
  const st = useData(b, [img, cap], customerId);
  if (p.hideWhenEmpty === true && !st.loading && !st.error && !st.rows.length) return null;
  const r = st.rows[0];
  const type = colOf(st.columns, img)?.type;
  const h = typeof p.height === 'number' ? p.height : 200;
  return (
    <Status st={st} hideWhenEmpty={p.hideWhenEmpty === true}>
      {r && <figure style={{ margin: 0 }}>
        {type === 'image' && typeof r[img] === 'string' && isSafeImageUrl(r[img] as string) && r[img]
          ? <img src={r[img] as string} alt={cap ? String(r[cap] ?? '') : ''} style={{ width: '100%', height: h, objectFit: p.fit === 'cover' ? 'cover' : 'contain', borderRadius: 'var(--radius)', display: 'block', background: 'var(--surface-3)' }} />
          : <div className="ca-pimg" style={{ height: h, fontSize: h * 0.45, borderRadius: 'var(--radius)' }} aria-hidden>{type === 'emoji' && r[img] ? String(r[img]) : '🛍️'}</div>}
        {cap && r[cap] != null && <figcaption className="center" style={{ marginTop: 6, fontWeight: 650 }}>{String(r[cap])}</figcaption>}
      </figure>}
    </Status>
  );
}

export function DataTableSection({ p, customerId, go }: { p: Record<string, PropValue>; customerId: ID | null; go: Go }) {
  const b = p.data as Binding;
  const st = useData(b, [], customerId, { search: true });
  if (p.hideWhenEmpty === true && !st.loading && !st.error && !st.rows.length) return null;
  const open = linkOpen(p, go);
  const cols = b.fields.map((k) => colOf(st.columns, k)).filter(Boolean) as ColumnDef[];
  const num = (c: ColumnDef) => c.type === 'money' || c.type === 'number';
  return (
    <Card title={str(p.title) || undefined}>
      <Status st={st}>
        <div className="ca-table-wrap"><table className="ca-table">
          <thead><tr>{cols.map((c) => <th key={c.key} style={{ textAlign: num(c) ? 'right' : 'left' }}>{c.label}</th>)}</tr></thead>
          <tbody>{st.rows.map((r, i) => <tr key={i} {...tapProps(open, r)}>{cols.map((c) => <td key={c.key} style={{ textAlign: num(c) ? 'right' : 'left' }}>{fmtField(r, st.columns, b, c.key)}</td>)}</tr>)}</tbody>
        </table></div>
      </Status>
    </Card>
  );
}

export function DataListSection({ p, customerId, go }: { p: Record<string, PropValue>; customerId: ID | null; go: Go }) {
  const b = p.data as Binding;
  const [a, s, rt] = ['primaryField', 'secondaryField', 'rightField'].map((k) => str(p[k]));
  const st = useData(b, [a, s, rt], customerId, { search: true });
  if (p.hideWhenEmpty === true && !st.loading && !st.error && !st.rows.length) return null;
  const open = linkOpen(p, go);
  return (
    <Card title={str(p.title) || undefined}>
      <Status st={st}>
        {st.rows.map((r, i) => (
          <div key={i} className="ca-drow" {...tapProps(open, r)}>
            <span className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>{a && <b>{fmtField(r, st.columns, b, a)}</b>}{s && <span className="muted" style={{ fontSize: 12.5 }}>{fmtField(r, st.columns, b, s)}</span>}</span>
            {rt && <span style={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{fmtField(r, st.columns, b, rt)}</span>}
          </div>
        ))}
      </Status>
    </Card>
  );
}

const fmtNum = (v: unknown, format: string) => { const n = Number(v); if (v == null || !isFinite(n)) return '—'; return format === 'money' ? money(n) : Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }); };

export function KpiSection({ p, customerId }: { p: Record<string, PropValue>; customerId: ID | null }) {
  const st = useData(p.data as Binding, [], customerId);
  const designer = useContext(DesignerCtx);
  return (
    <div className="ca-kpi">
      <span className="muted">{str(p.label)}</span>
      {st.error ? (designer ? <span className="ca-data-err">⚠ {st.error}</span> : <b>—</b>)
        : <b>{st.loading ? '…' : <>{str(p.prefix)}{fmtNum(st.rows[0]?.value, str(p.format))}{str(p.suffix) && <small> {str(p.suffix)}</small>}</>}</b>}
    </div>
  );
}

export function ChartSection({ p, customerId }: { p: Record<string, PropValue>; customerId: ID | null }) {
  const st = useData(p.data as Binding, [], customerId);
  const rows = st.rows.map((r) => ({ g: String(r.group ?? '—'), v: Number(r.value) || 0 }));
  const max = Math.max(1, ...rows.map((r) => r.v));
  const format = str(p.format);
  const summary = rows.map((r) => `${r.g}: ${fmtNum(r.v, format)}`).join(', ');
  return (
    <Card title={str(p.title) || undefined}>
      <Status st={st}>
        {p.chartType === 'columns' ? (
          <div className="ca-cols" role="img" aria-label={summary}>
            {rows.map((r) => <div key={r.g} className="ca-col"><small>{fmtNum(r.v, format)}</small><i style={{ height: `${Math.max(3, (r.v / max) * 100)}%` }} /><span className="ca-clamp">{r.g}</span></div>)}
          </div>
        ) : (
          <div className="col gap-6" role="img" aria-label={summary}>
            {rows.map((r) => <div key={r.g} className="ca-bar"><span className="ca-clamp">{r.g}</span><div><i style={{ width: `${Math.max(2, (r.v / max) * 100)}%` }} /></div><b>{fmtNum(r.v, format)}</b></div>)}
          </div>
        )}
      </Status>
    </Card>
  );
}

export function SearchSection({ p }: { p: Record<string, PropValue> }) {
  const pq = useContext(PageQueryCtx);
  return (
    <label className="ca-search">
      <SearchIcon size={16} aria-hidden />
      <input type="search" value={pq.q} placeholder={str(p.placeholder)} aria-label={str(p.placeholder) || 'Search'} maxLength={100} onChange={(e) => pq.setQ(e.target.value)} />
    </label>
  );
}

export function FilterSection({ p, customerId }: { p: Record<string, PropValue>; customerId: ID | null }) {
  const b = p.data as Binding;
  const field = b?.fields[0] ?? '';
  const pq = useContext(PageQueryCtx);
  // all values of the field (ignoring this chip's own choice), most frequent first
  const st = useData(b ? { ...b, agg: { fn: 'count', field: '', groupBy: field }, sort: null } : null, [], customerId, { ownPick: field });
  const key = b ? pickKey(b.source, field) : '';
  const cur = pq.picks[key] ?? '';
  return (
    <div className="col gap-6">
      {str(p.label) && <b style={{ fontSize: 13 }}>{str(p.label)}</b>}
      <Status st={st} hideWhenEmpty>
        <div className="ca-hscroll" role="group" aria-label={str(p.label) || field}>
          {[{ g: '', label: str(p.allLabel) || 'All' }, ...st.rows.map((r) => ({ g: String(r.group ?? ''), label: String(r.group ?? '—') }))].map((c) => (
            <button key={c.g || '__all'} type="button" className={cx('ca-chip', cur === c.g && 'on')} aria-pressed={cur === c.g} onClick={() => pq.setPick(key, c.g)}>{c.label}</button>
          ))}
        </div>
      </Status>
    </div>
  );
}

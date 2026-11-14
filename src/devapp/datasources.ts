// DEV APP Customer: data sources a component can be bound to.
//
// Two connections:
//   * App data ('local:*'): this app's own store (products, offers, rewards, the signed-in member's coupons/orders/profile).
//     Defined below. Member sources are ALWAYS pre-filtered to the member viewing the app: a layout cannot widen them.
//     Only customer-safe columns are listed (e.g. no product cost).
//   * Central database ('db:*'): approved views registered by an administrator in public.customer_app_data_sources and
//     read only through the public.customer_app_query RPC (allow-listed columns, bound parameters, row cap). No SQL is
//     ever written in or sent from the editor.
// applyQuery() below is the app-data twin of customer_app_query and has the same filter/sort/aggregate semantics.
import type { DB, ID } from '../domain/types';
import { customerLifetimeSpend, pointsBalance, tierFor } from '../domain/loyalty';
import { effectiveStatus } from '../domain/promotions';
import { AggFn, Binding, BindingFilter, ColType, FILTER_OPS, SELECTED_TOKEN } from './schema';

export interface ColumnDef { key: string; label: string; type: ColType }
export type Connection = 'local' | 'db';
export interface SourceDef {
  id: string; label: string; description: string; connection: Connection; schema: string; table: string; columns: ColumnDef[];
  /** public = same for everyone; member = only the signed-in member's own rows; authenticated/staff = database audience */
  scope: 'public' | 'member' | 'authenticated' | 'staff';
  enabled?: boolean;
}
export type Row = Record<string, unknown>;
export const CONNECTIONS: { v: Connection; label: string; desc: string }[] = [
  { v: 'local', label: 'App data', desc: 'Products, offers and rewards of this app, and the signed-in member’s own records' },
  { v: 'db', label: 'Central database', desc: 'Approved database views (e.g. the SKU catalogue). Managed by administrators.' },
];

interface LocalSource extends SourceDef { rows: (db: DB, customerId: ID | null) => Row[] }

const nowIso = () => new Date().toISOString();
/** Units on hand in the LINE shop warehouse (same rule as the Shop tab). */
const lineStock = (db: DB, productId: ID) => Object.entries(db.balances).filter(([k]) => k.endsWith('|' + productId) && k.startsWith('W3')).reduce((s, [, b]) => s + b.qty, 0);

export const LOCAL_SOURCES: LocalSource[] = [
  {
    id: 'local:products', label: 'Products (LINE shop)', description: 'Active products sold in the app, with LINE price and stock', connection: 'local', schema: 'catalog', table: 'products', scope: 'public',
    columns: [
      { key: 'sku', label: 'SKU code', type: 'text' }, { key: 'name', label: 'Product name', type: 'text' }, { key: 'category', label: 'Category', type: 'text' },
      { key: 'price', label: 'Price', type: 'money' }, { key: 'stock', label: 'Available stock', type: 'number' }, { key: 'in_stock', label: 'In stock', type: 'boolean' },
      { key: 'unit', label: 'Unit', type: 'text' }, { key: 'emoji', label: 'Product icon', type: 'emoji' }, { key: 'description', label: 'Description', type: 'text' },
      { key: 'barcode', label: 'Barcode', type: 'text' },
    ],
    // same rule as the Shop tab: sellable kinds with a LINE price above zero
    rows: (db) => db.products.filter((p) => p.active && ['finished', 'resale'].includes(p.kind) && (p.channelPrices.LINE ?? p.price) > 0).map((p) => {
      const stock = Math.floor(lineStock(db, p.id));
      return { sku: p.sku, name: p.name, category: p.category, price: p.channelPrices.LINE ?? p.price, stock, in_stock: stock > 0, unit: p.unit, emoji: p.emoji, description: p.description ?? '', barcode: p.barcode ?? '' };
    }),
  },
  {
    id: 'local:promotions', label: 'Offers', description: 'Promotions that are active right now', connection: 'local', schema: 'marketing', table: 'offers', scope: 'public',
    columns: [
      { key: 'name', label: 'Offer', type: 'text' }, { key: 'description', label: 'Description', type: 'text' }, { key: 'code', label: 'Promo code', type: 'text' },
      { key: 'starts', label: 'Starts', type: 'date' }, { key: 'ends', label: 'Ends', type: 'date' },
    ],
    rows: (db) => db.promotions.filter((p) => effectiveStatus(p, nowIso()) === 'active').map((p) => ({ name: p.name, description: p.description, code: p.code ?? '', starts: p.startAt, ends: p.endAt })),
  },
  {
    id: 'local:rewards', label: 'Rewards', description: 'Rewards members can redeem with points', connection: 'local', schema: 'marketing', table: 'rewards', scope: 'public',
    columns: [
      { key: 'name', label: 'Reward', type: 'text' }, { key: 'description', label: 'Description', type: 'text' }, { key: 'points', label: 'Points needed', type: 'number' },
      { key: 'left', label: 'Left', type: 'number' }, { key: 'emoji', label: 'Icon', type: 'emoji' },
    ],
    rows: (db) => db.rewards.filter((r) => r.active).map((r) => ({ name: r.name, description: r.description, points: r.cost, left: r.stock ?? null, emoji: r.emoji })),
  },
  {
    id: 'local:my_profile', label: 'My member details', description: 'The signed-in member: name, code, tier and points (their own record only)', connection: 'local', schema: 'member', table: 'my_profile', scope: 'member',
    columns: [
      { key: 'name', label: 'Name', type: 'text' }, { key: 'member_code', label: 'Member code', type: 'text' }, { key: 'tier', label: 'Tier', type: 'text' },
      { key: 'points', label: 'Points', type: 'number' }, { key: 'lifetime_spend', label: 'Total spent', type: 'money' }, { key: 'member_since', label: 'Member since', type: 'date' },
    ],
    rows: (db, id) => {
      const c = id ? db.customers.find((x) => x.id === id) : undefined;
      if (!c) return [];
      const spend = customerLifetimeSpend(db, c.id);
      return [{ name: c.name, member_code: c.code, tier: tierFor(db, spend).name, points: pointsBalance(db, c.id), lifetime_spend: spend, member_since: c.createdAt }];
    },
  },
  {
    id: 'local:my_coupons', label: 'My coupons', description: 'The signed-in member’s coupons (their own only)', connection: 'local', schema: 'member', table: 'my_coupons', scope: 'member',
    columns: [
      { key: 'title', label: 'Coupon', type: 'text' }, { key: 'code', label: 'Code', type: 'text' }, { key: 'value', label: 'Value', type: 'number' },
      { key: 'status', label: 'Status', type: 'text' }, { key: 'valid', label: 'Can be used now', type: 'boolean' }, { key: 'expires', label: 'Expires', type: 'date' },
    ],
    rows: (db, id) => (id ? db.coupons.filter((x) => x.customerId === id) : []).map((x) => ({ title: x.title, code: x.code, value: x.value, status: x.status, valid: x.status === 'issued' && x.expiresAt > nowIso(), expires: x.expiresAt })),
  },
  {
    id: 'local:my_orders', label: 'My orders', description: 'The signed-in member’s orders (their own only)', connection: 'local', schema: 'member', table: 'my_orders', scope: 'member',
    columns: [
      { key: 'order_no', label: 'Order no.', type: 'text' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'status', label: 'Status', type: 'text' },
      { key: 'total', label: 'Total', type: 'money' }, { key: 'channel', label: 'Channel', type: 'text' }, { key: 'items', label: 'Items', type: 'number' },
    ],
    rows: (db, id) => (id ? db.orders.filter((o) => o.customerId === id) : []).slice().reverse().map((o) => ({ order_no: o.no, date: o.createdAt, status: o.status, total: o.total, channel: o.channel, items: o.lines.reduce((s, l) => s + l.qty, 0) })),
  },
];
export const localSource = (id: string) => LOCAL_SOURCES.find((s) => s.id === id);

// ---------------------------------------------------------------- query
/** What the page around a component contributes: the search box text, filter chip choices, and the tapped record. */
export interface PageQuery { q: string; picks: Record<string, string>; selected: Row | null }
export const pickKey = (source: string, field: string) => `${source}|${field}`;

/** Replace {selected.x} in filter values with the tapped record's value (pages opened from a product card, list…). */
export function resolveFilters(b: Binding, selected: Row | null): BindingFilter[] {
  return b.filters.map((f) => ({ ...f, value: f.value.replace(SELECTED_TOKEN, (_, k: string) => (selected && selected[k] != null ? String(selected[k]) : '')) }));
}
/** Filters added by the page: chip picks on this source. */
export function pickFilters(source: string, picks: Record<string, string>): BindingFilter[] {
  return Object.entries(picks).filter(([k, v]) => v !== '' && k.startsWith(source + '|')).map(([k, v]) => ({ field: k.slice(source.length + 1), op: 'eq' as const, value: v }));
}

const isNumType = (t: ColType | undefined) => t === 'number' || t === 'money';
const cmpVal = (v: unknown, t: ColType | undefined): number | string | null => {
  if (v == null || v === '') return null;
  if (isNumType(t)) { const n = Number(v); return isFinite(n) ? n : null; }
  if (t === 'date') { const d = Date.parse(String(v)); return isFinite(d) ? d : null; }
  return String(v);
};
export function matchFilter(row: Row, f: BindingFilter, t: ColType | undefined): boolean {
  const v = row[f.field];
  switch (f.op) {
    case 'is_true': return v === true;
    case 'is_false': return v === false;
    case 'not_empty': return v != null && String(v) !== '';
    case 'contains': return String(v ?? '').toLowerCase().includes(f.value.toLowerCase());
    case 'eq': case 'neq': {
      let same: boolean;
      if (isNumType(t)) same = v != null && Number(v) === Number(f.value);
      else if (t === 'date') same = v != null && String(v).slice(0, 10) === f.value.slice(0, 10);
      else if (t === 'boolean') same = String(v) === f.value;
      else same = String(v ?? '') === f.value;
      return f.op === 'eq' ? same : !same;
    }
    default: {
      const a = cmpVal(v, t), b = cmpVal(f.value, t);
      if (a == null || b == null) return false;
      return f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : a <= b;
    }
  }
}
const aggregate = (fn: AggFn, vals: number[], n: number) => {
  if (fn === 'count') return n;
  if (!vals.length) return null;
  if (fn === 'sum') return vals.reduce((s, x) => s + x, 0);
  if (fn === 'avg') return vals.reduce((s, x) => s + x, 0) / vals.length;
  return fn === 'min' ? Math.min(...vals) : Math.max(...vals);
};

export interface QueryResult { columns: ColumnDef[]; rows: Row[] }
/**
 * Run a binding over rows already in memory. Same semantics as public.customer_app_query: unknown columns are ignored,
 * filters AND together, search matches any requested text column, records are capped at the binding's limit.
 * With `agg`, returns rows { group, value } (one row without groupBy), largest value first.
 */
export function applyQuery(rows: Row[], columns: ColumnDef[], b: Binding, need: string[], extra: BindingFilter[] = [], search = ''): QueryResult {
  const types = new Map(columns.map((c) => [c.key, c.type]));
  const filters = [...b.filters, ...extra].filter((f) => types.has(f.field) && FILTER_OPS.some((o) => o.v === f.op));
  let out = rows.filter((r) => filters.every((f) => matchFilter(r, f, types.get(f.field))));
  const wanted = [...new Set([...b.fields, ...need])].filter((k) => types.has(k));
  const q = search.trim().toLowerCase();
  const textCols = wanted.filter((k) => !isNumType(types.get(k)) && types.get(k) !== 'boolean');
  if (q && textCols.length) out = out.filter((r) => textCols.some((k) => String(r[k] ?? '').toLowerCase().includes(q)));
  const limit = Math.max(1, Math.min(50, b.limit || 1));
  if (b.agg) {
    const { fn, field, groupBy } = b.agg;
    if (fn !== 'count' && !types.has(field)) return { columns: [], rows: [] };
    const groups = new Map<string, Row[]>();
    for (const r of out) { const g = groupBy && types.has(groupBy) ? String(r[groupBy] ?? '—') : ''; groups.set(g, [...(groups.get(g) ?? []), r]); }
    if (!groupBy && !groups.size) groups.set('', []);
    const res = [...groups.entries()].map(([g, rs]) => ({ group: groupBy ? g : null, value: aggregate(fn, rs.map((r) => Number(r[field])).filter((n) => isFinite(n)), rs.length) }))
      .sort((x, y) => (Number(y.value ?? -Infinity) - Number(x.value ?? -Infinity)));
    return { columns: [{ key: 'group', label: groupBy, type: 'text' }, { key: 'value', label: fn, type: fn === 'count' ? 'number' : types.get(field) ?? 'number' }], rows: res.slice(0, groupBy ? limit : 1) };
  }
  if (b.sort && types.has(b.sort.field)) {
    const { field, dir } = b.sort; const t = types.get(field);
    out = [...out].sort((x, y) => {
      const a = cmpVal(x[field], t), c = cmpVal(y[field], t);
      if (a == null && c == null) return 0; if (a == null) return 1; if (c == null) return -1; // nulls last, both directions
      const r = typeof a === 'number' && typeof c === 'number' ? a - c : String(a).localeCompare(String(c), 'th');
      return dir === 'desc' ? -r : r;
    });
  }
  return { columns: columns.filter((c) => wanted.includes(c.key)), rows: out.slice(0, limit).map((r) => Object.fromEntries(wanted.map((k) => [k, r[k]]))) };
}

/** Problems with a layout's bindings against the sources this editor knows (unknown source/column, wrong column type). */
export function checkBinding(b: Binding, sources: SourceDef[], roleFields: { key: string; label: string; value: string; types?: ColType[] }[]): string[] {
  const src = sources.find((s) => s.id === b.source);
  if (!src) return [`Data source "${b.source}" is not available`];
  if (src.enabled === false) return [`Data source "${src.label}" is switched off`];
  const types = new Map(src.columns.map((c) => [c.key, c.type]));
  const out: string[] = [];
  const known = (k: string, what: string) => { if (k && !types.has(k)) out.push(`${what}: "${k}" is not a column of ${src.label}`); };
  b.fields.forEach((k) => known(k, 'Field'));
  b.filters.forEach((f) => known(f.field, 'Filter'));
  if (b.sort) known(b.sort.field, 'Sorting');
  if (b.agg) { known(b.agg.field, 'Calculation'); known(b.agg.groupBy, 'Group by'); if (b.agg.fn !== 'count' && b.agg.field && types.has(b.agg.field) && !isNumType(types.get(b.agg.field))) out.push(`Calculation: ${b.agg.fn} needs a number or price field`); }
  for (const r of roleFields) { known(r.value, r.label); if (r.value && r.types && types.has(r.value) && !r.types.includes(types.get(r.value)!)) out.push(`${r.label}: "${r.value}" is not a suitable field`); }
  return out;
}

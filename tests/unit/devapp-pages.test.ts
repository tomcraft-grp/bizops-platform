// DEV APP Customer: every page editable, custom pages, data-bound components and data source isolation.
import { describe, expect, it } from 'vitest';
import {
  CORE_OF, defaultLayout, diffLayouts, emptyBinding, LayoutConfig, newSection, normalizeLayout, PAGE_TABS, pageList, pageSections, SECTION_DEFS,
  validateBinding, validateLayout,
} from '../../src/devapp/schema';
import { applyQuery, checkBinding, LOCAL_SOURCES, localSource, pickFilters, resolveFilters } from '../../src/devapp/datasources';
import type { DB } from '../../src/domain/types';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const paths = (c: unknown) => validateLayout(c).map((i) => i.path);

describe('DEV APP Customer: every page is editable', () => {
  it('the built-in layout has one page per tab, each holding only its core block (= the original tab)', () => {
    const c = defaultLayout();
    for (const t of PAGE_TABS) expect(c.pages[t].map((s) => s.type)).toEqual([CORE_OF[t]]);
    expect(pageList(c).map((p) => p.ref)).toEqual(['home', 'shop', 'rewards', 'pay', 'events', 'profile']);
  });
  it('layouts stored before pages existed keep working: normalize adds the default pages', () => {
    const old = clone(defaultLayout()) as unknown as Record<string, unknown>; delete old.pages; delete old.customPages;
    expect(validateLayout(old)).toEqual([]);
    const n = normalizeLayout(old as unknown as LayoutConfig);
    expect(n.customPages).toEqual([]);
    for (const t of PAGE_TABS) expect(pageSections(n, t).map((s) => s.type)).toEqual([CORE_OF[t]]);
  });
  it('pages are independent: editing one page does not change another', () => {
    const c = defaultLayout();
    c.pages.shop.unshift(newSection('banner'));
    expect(c.pages.rewards.length).toBe(1); expect(c.home.length).toBe(4);
    expect(validateLayout(c)).toEqual([]);
    expect(diffLayouts(defaultLayout(), c).join('\n')).toMatch(/shop: added Banner/);
  });
  it('a tab page must keep its core block exactly once, and core blocks cannot be placed elsewhere', () => {
    const a = defaultLayout(); a.pages.pay = [newSection('text')];
    expect(paths(a)).toContain('pages.pay');
    const b = defaultLayout(); b.home.push({ ...newSection('shopCore'), id: 'x' });
    expect(paths(b)).toContain('home.4.type');
    // normalize restores a missing core and drops duplicates, so the business features can never disappear
    expect(normalizeLayout(a).pages.pay.filter((s) => s.type === 'payCore').length).toBe(1);
    const d = defaultLayout(); d.pages.events.push({ ...d.pages.events[0], id: 'dup' });
    expect(normalizeLayout(d).pages.events.filter((s) => s.type === 'eventsCore').length).toBe(1);
  });
  it('core blocks are not in the component palette', () => {
    expect(SECTION_DEFS.some((d) => d.type.endsWith('Core'))).toBe(false);
  });
  it('custom pages: unique addresses, links must point to an existing page', () => {
    const c = defaultLayout();
    c.customPages = [{ id: 'product-details', title: 'Product details', sections: [newSection('productImage')] }];
    const btn = newSection('button'); btn.props.linkTab = 'page:product-details'; c.home.push(btn);
    expect(validateLayout(c)).toEqual([]);
    btn.props.linkTab = 'page:missing';
    expect(paths(c)).toContain('home.4.props.linkTab');
    c.customPages.push({ id: 'product-details', title: 'Dup', sections: [] });
    expect(paths(c)).toContain('customPages.1.id');
  });
  it('section ids are unique across all pages', () => {
    const c = defaultLayout(); c.pages.shop.push({ ...newSection('text'), id: 'member-card' });
    expect(paths(c)).toContain('pages.shop.1.id');
  });
  it('visibility only accepts known customer groups', () => {
    const c = defaultLayout(); c.home[0].visibility = { groups: ['vip'] };
    expect(validateLayout(c)).toEqual([]);
    (c.home[0].visibility.groups as string[]).push('admins');
    expect(paths(c)).toContain('home.0.visibility');
  });
});

describe('DEV APP Customer: data bindings', () => {
  const recF = SECTION_DEFS.find((d) => d.type === 'dataCard')!.fields.find((f) => f.kind === 'binding')!;
  const aggF = SECTION_DEFS.find((d) => d.type === 'chart')!.fields.find((f) => f.kind === 'binding')!;
  const issues = (b: unknown, f = recF) => { const out: string[] = []; validateBinding(b, f, 'b', (p) => out.push(p)); return out; };

  it('a binding is structured data, never SQL: names, operators and limits are checked', () => {
    expect(issues({ ...emptyBinding(), fields: ['sku', 'name'] })).toEqual([]);
    expect(issues({ ...emptyBinding('db:x; drop table y') })).toContain('b.source');
    expect(issues({ ...emptyBinding(), fields: ['name; drop'] })).toContain('b.fields');
    expect(issues({ ...emptyBinding(), filters: [{ field: 'price', op: 'like', value: '%' }] })).toContain('b.filters.0.op');
    expect(issues({ ...emptyBinding(), limit: 500 })).toContain('b.limit');
    expect(issues({ ...emptyBinding(), sort: { field: 'price', dir: 'sideways' } })).toContain('b.sort');
    expect(issues(emptyBinding(), aggF)).toContain('b.agg'); // a chart needs a calculation
    expect(issues({ ...emptyBinding(), agg: { fn: 'count', field: '', groupBy: '' } }, aggF)).toContain('b.agg.groupBy');
  });

  const cols = [{ key: 'sku', label: 'SKU', type: 'text' as const }, { key: 'name', label: 'Name', type: 'text' as const }, { key: 'cat', label: 'Cat', type: 'text' as const },
    { key: 'price', label: 'Price', type: 'money' as const }, { key: 'active', label: 'Active', type: 'boolean' as const }, { key: 'since', label: 'Since', type: 'date' as const }];
  const rows = [
    { sku: 'A1', name: 'Mint pod', cat: 'POD', price: 99, active: true, since: '2026-01-05T10:00:00Z', secret: 1 },
    { sku: 'A2', name: 'Grape pod', cat: 'POD', price: 120, active: false, since: '2026-03-01T10:00:00Z', secret: 2 },
    { sku: 'B1', name: 'Kratom drink', cat: 'Drink', price: 30, active: true, since: '2026-02-01T10:00:00Z', secret: 3 },
  ];
  const b = (o: Partial<ReturnType<typeof emptyBinding>>) => ({ ...emptyBinding('local:x'), limit: 10, ...o });

  it('filters, sort and limit (same semantics as the database RPC)', () => {
    expect(applyQuery(rows, cols, b({ fields: ['sku'], filters: [{ field: 'price', op: 'gte', value: '99' }], sort: { field: 'price', dir: 'desc' } }), []).rows).toEqual([{ sku: 'A2' }, { sku: 'A1' }]);
    expect(applyQuery(rows, cols, b({ fields: ['sku'], filters: [{ field: 'active', op: 'is_true', value: '' }, { field: 'cat', op: 'eq', value: 'POD' }] }), []).rows).toEqual([{ sku: 'A1' }]);
    expect(applyQuery(rows, cols, b({ fields: ['sku'], filters: [{ field: 'since', op: 'lt', value: '2026-02-15' }] }), []).rows.map((r) => r.sku)).toEqual(['A1', 'B1']);
    expect(applyQuery(rows, cols, b({ fields: ['sku'], filters: [{ field: 'name', op: 'contains', value: '%' }] }), []).rows).toEqual([]);
    expect(applyQuery(rows, cols, b({ fields: ['sku'], limit: 1 }), []).rows.length).toBe(1);
  });
  it('only requested, registered columns come back (never other fields of the record)', () => {
    const r = applyQuery(rows, cols, b({ fields: ['sku', 'secret'] }), ['name']);
    expect(Object.keys(r.rows[0]).sort()).toEqual(['name', 'sku']);
  });
  it('search matches requested text fields, case-insensitive', () => {
    expect(applyQuery(rows, cols, b({ fields: ['sku', 'name'] }), [], [], 'GRAPE').rows).toEqual([{ sku: 'A2', name: 'Grape pod' }]);
  });
  it('aggregates: count per group and sum', () => {
    expect(applyQuery(rows, cols, b({ agg: { fn: 'count', field: '', groupBy: 'cat' } }), []).rows).toEqual([{ group: 'POD', value: 2 }, { group: 'Drink', value: 1 }]);
    expect(applyQuery(rows, cols, b({ agg: { fn: 'sum', field: 'price', groupBy: '' } }), []).rows).toEqual([{ group: null, value: 249 }]);
    expect(applyQuery([], cols, b({ agg: { fn: 'count', field: '', groupBy: '' } }), []).rows).toEqual([{ group: null, value: 0 }]);
  });
  it('filter chips and the tapped record (product details pages) become filters', () => {
    expect(pickFilters('local:x', { 'local:x|cat': 'POD', 'local:y|cat': 'Drink', 'local:x|sku': '' })).toEqual([{ field: 'cat', op: 'eq', value: 'POD' }]);
    expect(resolveFilters(b({ filters: [{ field: 'sku', op: 'eq', value: '{selected.sku}' }] }), { sku: 'B1' })).toEqual([{ field: 'sku', op: 'eq', value: 'B1' }]);
    expect(resolveFilters(b({ filters: [{ field: 'sku', op: 'eq', value: '{selected.sku}' }] }), null)[0].value).toBe('');
  });
  it('checkBinding reports unknown sources, columns and unsuitable fields; every palette default is consistent', () => {
    expect(checkBinding(b({ source: 'db:nope' }), LOCAL_SOURCES, [])[0]).toMatch(/not available/);
    expect(checkBinding({ ...emptyBinding('local:products'), fields: ['cost'] }, LOCAL_SOURCES, []).join()).toMatch(/"cost" is not a column/);
    expect(checkBinding(emptyBinding('local:products'), LOCAL_SOURCES, [{ key: 'priceField', label: 'Price field', value: 'name', types: ['money'] }]).join()).toMatch(/not a suitable field/);
    for (const d of SECTION_DEFS) for (const f of d.fields) if (f.kind === 'binding') {
      const bd = d.defaults[f.key] as ReturnType<typeof emptyBinding>;
      const roles = d.fields.filter((x) => x.kind === 'column').map((x) => ({ key: x.key, label: x.label, value: String(d.defaults[x.key] ?? ''), types: x.colTypes }));
      expect(checkBinding(bd, LOCAL_SOURCES, roles), d.type).toEqual([]);
    }
  });
});

describe('DEV APP Customer: app data sources', () => {
  const fake = {
    products: [{ id: 'p1', sku: 'S1', name: 'Latte', category: 'Coffee', kind: 'finished', unit: 'cup', price: 60, channelPrices: { LINE: 55 }, active: true, emoji: '☕', color: '#000', stdCost: 12, levels: {}, mediaIds: [] }],
    balances: { 'W3|p1': { qty: 7.6, value: 0, lastCost: 0 }, 'W1|p1': { qty: 100, value: 0, lastCost: 0 } },
    coupons: [
      { id: 'c1', code: 'MINE', customerId: 'me', kind: 'fixed', value: 20, title: 'Mine', status: 'issued', source: 'promo', sourceId: 'x', expiresAt: '2999-01-01', createdAt: '' },
      { id: 'c2', code: 'THEIRS', customerId: 'other', kind: 'fixed', value: 50, title: 'Not mine', status: 'issued', source: 'promo', sourceId: 'x', expiresAt: '2999-01-01', createdAt: '' },
    ],
    orders: [{ id: 'o1', no: 'O-1', customerId: 'other', createdAt: '', status: 'paid', total: 9, channel: 'LINE', lines: [] }],
  } as unknown as DB;
  it('products expose the LINE price and shop stock, never the cost', () => {
    const r = localSource('local:products')!.rows(fake, null)[0];
    expect(r).toMatchObject({ sku: 'S1', price: 55, stock: 7, in_stock: true });
    expect(Object.keys(r)).not.toContain('stdCost');
    expect(localSource('local:products')!.columns.some((c) => /cost/i.test(c.key))).toBe(false);
  });
  it('member sources only ever return the viewing member’s own records', () => {
    expect(localSource('local:my_coupons')!.rows(fake, 'me').map((r) => r.code)).toEqual(['MINE']);
    expect(localSource('local:my_coupons')!.rows(fake, null)).toEqual([]);
    expect(localSource('local:my_orders')!.rows(fake, 'me')).toEqual([]);
    // a layout filter cannot widen it: filters only narrow the member's rows
    const src = localSource('local:my_coupons')!;
    expect(applyQuery(src.rows(fake, 'me'), src.columns, { ...emptyBinding(src.id), fields: ['code'], filters: [{ field: 'code', op: 'eq', value: 'THEIRS' }] }, []).rows).toEqual([]);
  });
});

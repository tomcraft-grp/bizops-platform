// Filter panel for Inventory > Stock levels: keyword search, grouped dropdowns, result count and "Clear filters".
// On narrow screens the groups fold behind a "Filters (n)" button so the page is not crowded.
import { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useLang } from '../domain/store';
import { PRODUCT_KIND_LABEL } from '../domain/meta';
import { SKU_CATEGORIES, SKU_CATEGORY_LABEL } from '../domain/sku';
import { activeFilterCount, type StockFilters } from '../domain/stockFilters';
import type { ProductKind, Warehouse } from '../domain/types';
import { cx } from '../lib/util';
import { t } from '../lib/i18n';
import { Button, Check, Field, Input, SearchBox, Select } from './kit';

const STOCKED_KINDS: ProductKind[] = ['material', 'packaging', 'wip', 'finished', 'resale'];

export function StockFilterBar({ f, onChange, onClear, warehouses, options, products, totalProducts, rows }: {
  f: StockFilters; onChange: (patch: Partial<StockFilters>) => void; onClear: () => void; warehouses: Warehouse[];
  options: { categories: string[]; brands: string[]; units: string[] }; products: number; totalProducts: number; rows: number;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const n = activeFilterCount(f);
  const pick = <K extends keyof StockFilters>(k: K) => (e: { target: { value: string } }) => onChange({ [k]: e.target.value } as Partial<StockFilters>);
  return (
    <div className="filter-panel">
      <div className="filter-top">
        <div className="filter-search"><SearchBox value={f.q} onChange={(v) => onChange({ q: v })} placeholder="Search SKU, name, brand, barcode…" /></div>
        <Button className="filter-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><SlidersHorizontal size={15} />{' '}{t(lang, 'Filters')}{n ? ` (${n})` : ''}</Button>
        {n > 0 && <Button variant="soft" onClick={onClear}><X size={14} />{' '}{t(lang, 'Clear filters')}</Button>}
      </div>
      <div className={cx('filter-body', open && 'open')}>
        <fieldset className="filter-group g-product">
          <legend>{t(lang, 'Product')}</legend>
          <div className="filter-grid">
            <Field label="Product type"><Select value={f.skuType} onChange={pick('skuType')}><option value="">All SKU types</option>{SKU_CATEGORIES.map((c) => <option key={c} value={c}>{SKU_CATEGORY_LABEL[c]}</option>)}</Select></Field>
            <Field label="Kind"><Select value={f.kind} onChange={pick('kind')}><option value="">All kinds</option>{STOCKED_KINDS.map((k) => <option key={k} value={k}>{PRODUCT_KIND_LABEL[k]}</option>)}</Select></Field>
            <Field label="Product category"><Select value={f.category} onChange={pick('category')}><option value="">All categories</option>{options.categories.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
            <Field label="Brand"><Select value={f.brand} onChange={pick('brand')}><option value="">All brands</option>{options.brands.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>
            <Field label="Unit"><Select value={f.unit} onChange={pick('unit')}><option value="">All units</option>{options.units.map((u) => <option key={u} value={u}>{u}</option>)}</Select></Field>
          </div>
        </fieldset>
        <fieldset className="filter-group g-stock">
          <legend>{t(lang, 'Stock')}</legend>
          <div className="filter-grid">
            <Field label="Warehouse"><Select value={f.warehouse} onChange={pick('warehouse')}><option value="">All warehouses</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
            <Field label="Availability"><Select value={f.stock} onChange={pick('stock')}><option value="">All stock levels</option><option value="in">In stock</option><option value="out">Out of stock</option></Select></Field>
            <Field label="Status"><Select value={f.status} onChange={pick('status')}><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
            <div className="field filter-check"><Check checked={f.low} onChange={(v) => onChange({ low: v })}>Low only</Check></div>
          </div>
        </fieldset>
        <fieldset className="filter-group g-date">
          <legend>{t(lang, 'Date created')}</legend>
          <div className="filter-grid">
            <Field label="From"><Input type="date" value={f.from} max={f.to || undefined} onChange={pick('from')} /></Field>
            <Field label="To"><Input type="date" value={f.to} min={f.from || undefined} onChange={pick('to')} /></Field>
          </div>
          {(f.from || f.to) && <div className="hint">{t(lang, 'Products saved before creation dates were recorded are left out while a date is set.')}</div>}
        </fieldset>
      </div>
      <div className="filter-count muted" aria-live="polite">{t(lang, '{n} of {total} products · {r} stock rows', { n: products, total: totalProducts, r: rows })}</div>
    </div>
  );
}

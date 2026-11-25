import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { useDB } from '../domain/store';
import { PRODUCT_KIND_LABEL } from '../domain/meta';
import type { ID, Product } from '../domain/types';
import { cx, qtyFmt } from '../lib/util';
import { PICKER_ROWS, searchProducts } from './forms';
import { useT } from './parts';

/**
 * Search box with a list of products (name, SKU, legacy SKU, barcode, brand, category). Arrow keys, Enter and Escape work; a scanned barcode followed by Enter picks its product.
 * The list is part of the page, not a layer over it, so nothing cuts it off on a phone. `blocked` says why a product cannot be chosen.
 */
export function ProductPicker({ label, value, onPick, blocked, placeholder, testid }: {
  label: string; value?: ID; onPick: (p: Product) => void; blocked?: (p: Product) => string | null; placeholder?: string; testid?: string;
}) {
  const db = useDB(), T = useT(), id = useId(), box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState(''), [open, setOpen] = useState(false), [at, setAt] = useState(0);
  const stock = useMemo(() => { const m: Record<ID, number> = {}; for (const k in db.balances) { const pid = k.split('|')[1]; m[pid] = (m[pid] || 0) + db.balances[k].qty; } return m; }, [db.balances]);
  const { rows, total } = useMemo(() => (open ? searchProducts(db.products, q, (p) => !!blocked?.(p)) : { rows: [], total: 0 }), [open, q, db.products, blocked]);
  const cur = Math.min(at, rows.length - 1), chosen = value ? db.products.find((p) => p.id === value) : undefined;
  const show = () => { setOpen(true); setAt(0); };
  const close = () => { setOpen(false); setQ(''); };
  // closed by the click itself, not by the focus that leaves before it: closing moves the page, and the button under the finger would no longer be there
  useEffect(() => {
    if (!open) return undefined;
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [open]);
  const pick = (p: Product | undefined) => { if (!p || blocked?.(p)) return; close(); onPick(p); };
  const move = (to: number) => { const n = Math.max(0, Math.min(rows.length - 1, to)); setAt(n); document.getElementById(`${id}-o${n}`)?.scrollIntoView({ block: 'nearest' }); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (open) move(cur + 1); else show(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(cur - 1); }
    else if (e.key === 'Home' && open && !q) { e.preventDefault(); move(0); }
    else if (e.key === 'End' && open && !q) { e.preventDefault(); move(rows.length - 1); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); pick(rows[cur]); }
    else if (e.key === 'Tab') close();
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); }
  };
  return (
    <div className="pp" ref={box} data-testid={testid}>
      <div className="input-icon">
        <Search aria-hidden />
        <input className="input" role="combobox" aria-label={T(label)} aria-expanded={open} aria-controls={`${id}-l`} aria-autocomplete="list" aria-activedescendant={open && rows.length ? `${id}-o${cur}` : undefined} autoComplete="off"
          placeholder={chosen && !open ? `${chosen.name} · ${chosen.sku}` : T(placeholder ?? 'Type a name, SKU, barcode or brand')} value={q} onFocus={show} onClick={() => { if (!open) show(); }} onChange={(e) => { setQ(e.target.value); setOpen(true); setAt(0); }} onKeyDown={onKey} />
      </div>
      <div id={`${id}-l`} role="listbox" aria-label={T(label)} className={cx('pp-list', !open && 'pp-off')} tabIndex={-1}>
        {open && rows.map((p, i) => {
          const why = blocked?.(p);
          return (
            <div key={p.id} id={`${id}-o${i}`} role="option" aria-selected={i === cur} aria-disabled={!!why} className={cx('pp-row', i === cur && 'on', why && 'no')} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => i !== at && setAt(i)} onClick={() => pick(p)}>
              <div className="grow"><b>{p.name}</b>{!p.active && !why && <span className="badge warn">{T('Inactive')}</span>}
                <div className="sub"><span className="mono">{p.sku}</span>{p.legacySku ? ` · ${p.legacySku}` : ''}{p.barcode ? ` · ${p.barcode}` : ''}{p.brand ? ` · ${p.brand}` : ''} · {p.category}</div>
                {why && <div className="sub pp-why">{T(why)}</div>}</div>
              <div className="pp-end"><span>{T(PRODUCT_KIND_LABEL[p.kind])}</span>{p.kind !== 'menu' && <span className="sub">{T('On hand')} {qtyFmt(stock[p.id] || 0)} {p.unit}</span>}</div>
            </div>
          );
        })}
      </div>
      {open && <div className="sub pp-note" role="status">{!db.products.length ? T('There is no product yet. Add products on the Products page first.') : !total ? T('No product matches the search') : total > PICKER_ROWS ? T('Showing the first {n} of {m} products. Type to narrow the list.', { n: PICKER_ROWS, m: total }) : T('{n} of {m} products', { n: total, m: db.products.length })}</div>}
    </div>
  );
}

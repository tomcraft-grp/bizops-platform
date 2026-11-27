// The item box of the daily expense sheet: a text box with a list of earlier items and the categories, each with the icon of its category.
// A browser's own <datalist> cannot show pictures, so this is a small combobox: arrow keys, Enter, Escape, mouse and touch.
// The list is drawn at page level (a portal, placed from the box's position), so no table or card can cut it off, and it opens upwards when
// there is no room below. It opens when the box is clicked, typed in or ArrowDown is pressed, never by focus alone: the sheet moves the cursor
// into the next row by itself and a list must not pop up each time.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { cx } from '../lib/util';
import { CatIcon } from './parts';
import { filterSuggestions } from './sheet';

export interface ItemOption {
  /** what goes into the box when it is chosen */
  text: string;
  /** the icon name of the category this item belongs to (none: a neutral icon) */
  icon?: string;
  /** the category name, shown small at the end when it is not the same as the text */
  sub?: string;
}

interface Pos { left: number; width: number; top: number; bottom: number; up: boolean; max: number }

export function ItemBox({ value, onChange, options, label, listLabel, placeholder, invalid, readOnly, maxLength = 300, icon, inputRef }: {
  value: string; onChange: (text: string) => void; options: ItemOption[]; label: string; /** the name of the list itself: it must differ from the name of the box */ listLabel: string; placeholder?: string; invalid?: boolean; readOnly?: boolean; maxLength?: number;
  /** icon name of the row's category, shown in front of the text */
  icon?: string; inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(-1);
  const [pos, setPos] = useState<Pos | null>(null);
  const rows = open && !readOnly ? filterSuggestions(options, value) : [];
  const shown = rows.length > 0;
  const cur = at < rows.length ? at : -1;

  const place = () => {
    const el = input.current; if (!el) return;
    const r = el.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
    const below = vh - r.bottom - 8, above = r.top - 8;
    const up = below < 200 && above > below;
    const width = Math.min(Math.max(r.width, 280), vw - 16);
    setPos({ left: Math.max(8, Math.min(r.left, vw - width - 8)), width, top: r.bottom + 4, bottom: vh - r.top + 4, up, max: Math.max(120, Math.min(300, (up ? above : below) - 4)) });
  };
  useLayoutEffect(() => {
    if (!shown) return undefined;
    place();
    const h = () => place();
    window.addEventListener('scroll', h, true); window.addEventListener('resize', h);
    return () => { window.removeEventListener('scroll', h, true); window.removeEventListener('resize', h); };
  }, [shown, rows.length]);
  // closed by a press or by the cursor going somewhere else; pressing on the list itself neither moves the cursor nor closes it
  useEffect(() => {
    if (!open) return undefined;
    const outside = (t: EventTarget | null) => !(t instanceof Node) || !(input.current?.contains(t) || list.current?.contains(t));
    const down = (e: MouseEvent) => { if (outside(e.target)) setOpen(false); };
    const focus = (e: FocusEvent) => { if (outside(e.target)) setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('focusin', focus); };
  }, [open]);
  useEffect(() => { if (shown && cur >= 0) document.getElementById(`${id}-o${cur}`)?.scrollIntoView({ block: 'nearest' }); }, [cur, shown, id]);

  const pick = (o: ItemOption) => { onChange(o.text); setOpen(false); setAt(-1); input.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (readOnly || e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!shown) { setOpen(true); setAt(0); } else setAt(Math.min(rows.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp' && shown) { e.preventDefault(); setAt(Math.max(0, cur - 1)); }
    else if (e.key === 'Enter' && shown && cur >= 0) { e.preventDefault(); pick(rows[cur]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="xs-ib">
      <span className={cx('xs-lead', !icon && 'off')} aria-hidden><CatIcon name={icon} size={16} /></span>
      <input ref={(el) => { input.current = el; inputRef?.(el); }} className={cx('input', invalid && 'bad')} role="combobox" aria-expanded={shown} aria-controls={`${id}-l`} aria-autocomplete="list"
        aria-activedescendant={shown && cur >= 0 ? `${id}-o${cur}` : undefined} aria-label={label} aria-invalid={invalid || undefined} autoComplete="off" value={value} maxLength={maxLength}
        readOnly={readOnly} placeholder={placeholder} onChange={(e) => { onChange(e.target.value); setOpen(true); setAt(-1); }} onClick={() => { if (!readOnly) setOpen(true); }} onKeyDown={onKey} />
      {!readOnly && <ChevronDown className="xs-chev" size={16} aria-hidden />}
      {shown && pos && createPortal(
        <div ref={list} id={`${id}-l`} role="listbox" aria-label={listLabel} className="xs-pop" data-testid="xs-pop"
          style={{ left: pos.left, width: pos.width, maxHeight: pos.max, ...(pos.up ? { bottom: pos.bottom } : { top: pos.top }) }}>
          {rows.map((o, i) => (
            <div key={o.text} id={`${id}-o${i}`} role="option" aria-selected={i === cur} className={cx('xs-opt', i === cur && 'on')} data-testid="xs-opt"
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (i !== cur) setAt(i); }} onClick={() => pick(o)}>
              <span className={cx('xs-ico', !o.icon && 'off')} aria-hidden><CatIcon name={o.icon} size={16} /></span>
              <span className="xs-opt-t">{o.text}</span>
              {o.sub && <small className="xs-opt-s">{o.sub}</small>}
            </div>))}
        </div>, document.body)}
    </div>
  );
}

// Daily expense sheet: pick a day, type one row per expense (item, category, how paid, amount, note), save them together.
// Every row is its own expense claim (public.expense_claims) written by expense_save, the same single writer the full form uses, so
// approval, tax review and posting work as before. Unsaved rows are kept in this browser per person and day until they are saved,
// so changing the day, switching tabs or reloading never loses them. Saving gives each new row its claim id at once: saving again
// (after a failure, or a second click) updates that claim instead of creating a second one.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, FileText, Plus, Send, Trash2 } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { Badge, Button, Modal, useConfirm } from '../ui/kit';
import { cx, dayKey } from '../lib/util';
import { METHOD_META, cancelClaim, catName, listClaims, saveClaim, submitClaim, useT, type Claim, type PayMethod } from './api';
import { CatIcon, StatusBadge, useExpense } from './parts';
import { ItemBox, type ItemOption } from './ItemBox';
import { ExpenseForm } from './ExpenseForm';
import {
  blankRow, dayTotals, fillFromSuggestion, formatAmount, isBlank, isDirty, isEditable, matchSuggestion, mergeDay, newRowTaxType, parseAmount, rowFromClaim, shiftDay, stashOf, suggestionsFrom,
  validateRow, type RowErrors, type SheetRow, type Suggestion,
} from './sheet';

const STASH = 'expenseSheet.v1';
const stashKey = (uid: string, day: string) => `${STASH}.${uid}.${day}`;
function readStash(uid: string, day: string): SheetRow[] {
  try { const v = JSON.parse(localStorage.getItem(stashKey(uid, day)) ?? '[]') as SheetRow[]; return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeStash(uid: string, day: string, rows: SheetRow[]) {
  try { const s = stashOf(rows); if (s.length) localStorage.setItem(stashKey(uid, day), JSON.stringify(s)); else localStorage.removeItem(stashKey(uid, day)); } catch { /* private mode: rows live in memory only */ }
}
/** other days with rows that were typed but not saved (this browser only) */
function stashedDays(uid: string, except: string): { day: string; n: number }[] {
  const out: { day: string; n: number }[] = [];
  try {
    const pre = `${STASH}.${uid}.`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(pre)) continue;
      const day = k.slice(pre.length);
      if (day === except) continue;
      const n = readStash(uid, day).length;
      if (n) out.push({ day, n });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}

type Sheet = { day: string; rows: SheetRow[] };

export function DailySheet({ refreshKey, onOpen, onChanged }: { refreshKey: number; onOpen: (id: string) => void; onChanged: () => void }) {
  const T = useT();
  const lang = useLang();
  const confirm = useConfirm();
  const { userId, categories, catById, settings } = useExpense();
  const today = dayKey(new Date());
  const [day, setDay] = useState(today);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [errs, setErrs] = useState<Record<string, RowErrors>>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'save' | 'submit'>('');
  const [history, setHistory] = useState<Claim[]>([]);
  const [full, setFull] = useState(false);
  const [others, setOthers] = useState<{ day: string; n: number }[]>([]);
  const busyRef = useRef(false);
  const sheetRef = useRef<Sheet | null>(null);
  sheetRef.current = sheet;
  const itemRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const focusNext = useRef<string | null>(null);
  const active = useMemo(() => categories.filter((c) => c.active), [categories]);
  const suggestions = useMemo(() => suggestionsFrom(history, categories, lang), [history, categories, lang]);
  // each suggestion carries the icon of its category and, small at the end, the category name (not repeated when the suggestion IS the category)
  const options = useMemo<ItemOption[]>(() => suggestions.map((x) => {
    const c = x.categoryId ? catById[x.categoryId] : undefined, name = c ? catName(lang, c) : '';
    return { text: x.text, icon: c?.icon, sub: name && name !== x.text ? name : undefined };
  }), [suggestions, catById, lang]);

  // ---------------------------------------------------------------- loading
  const loadHistory = useCallback(() => {
    listClaims({ employee: userId }, 0, 300).then((r) => setHistory(r.rows)).catch(() => undefined);
  }, [userId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const reqSeq = useRef(0);
  const loadDay = useCallback(async (d: string, quiet: boolean) => {
    const my = ++reqSeq.current;
    if (!quiet) setSheet(null);
    setLoadErr('');
    try {
      const { rows } = await listClaims({ employee: userId, from: d, to: d }, 0, 500);
      if (my !== reqSeq.current) return;
      // read the stash only now: rows typed while the request was out are in it too
      const live = sheetRef.current?.day === d ? stashOf(sheetRef.current.rows) : readStash(userId, d);
      const merged = mergeDay(rows, live, 'cash');
      setSheet({ day: d, rows: merged.rows });
      if (merged.dropped) toast('error', T(`${merged.dropped} unsaved change(s) could not be kept: those expenses were sent for approval or cancelled in the meantime.`, `มี ${merged.dropped} รายการที่แก้ไว้แต่เก็บไม่ได้ เพราะรายการนั้นถูกส่งอนุมัติหรือยกเลิกไปแล้ว`));
    } catch (e) { if (my === reqSeq.current) { setLoadErr((e as Error).message); if (!quiet) setSheet(null); } }
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadDay(day, false); setErrs({}); setRowErr({}); }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } void loadDay(day, true); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep unsaved rows in this browser, per person and day
  useEffect(() => { if (sheet) writeStash(userId, sheet.day, sheet.rows); }, [sheet, userId]);
  useEffect(() => { setOthers(stashedDays(userId, day)); }, [userId, day, sheet]);
  useEffect(() => {
    if (focusNext.current) { itemRefs.current[focusNext.current]?.focus(); focusNext.current = null; }
  });

  // ---------------------------------------------------------------- editing
  const rows = sheet?.day === day ? sheet.rows : null;
  const totals = useMemo(() => dayTotals(rows ?? []), [rows]);
  const setRows = (fn: (r: SheetRow[]) => SheetRow[]) => setSheet((s) => (s ? { ...s, rows: fn(s.rows) } : s));
  const patch = (key: string, p: Partial<SheetRow> | ((r: SheetRow) => SheetRow)) => {
    setRows((rs) => rs.map((r) => (r.key === key ? (typeof p === 'function' ? p(r) : { ...r, ...p }) : r)));
    setRowErr((e) => (e[key] ? { ...e, [key]: '' } : e));
  };
  const clearErr = (key: string, f: keyof RowErrors) => setErrs((e) => (e[key]?.[f] ? { ...e, [key]: { ...e[key], [f]: undefined } } : e));
  const addRow = () => {
    if (!rows) return;
    const last = rows[rows.length - 1];
    if (last && isBlank(last) && isEditable(last)) { itemRefs.current[last.key]?.focus(); return; }
    const r = blankRow(last?.method ?? 'cash');
    focusNext.current = r.key;
    setRows((rs) => [...rs, r]);
  };
  const nextRow = (key: string) => {
    if (!rows) return;
    const i = rows.findIndex((r) => r.key === key);
    const next = rows.slice(i + 1).find(isEditable);
    if (next) itemRefs.current[next.key]?.focus(); else addRow();
  };
  const onEnter = (key: string) => (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); nextRow(key); } };
  const typeItem = (r: SheetRow, text: string) => {
    const m: Suggestion | null = matchSuggestion(suggestions, text);
    patch(r.key, (x) => { const y = { ...x, description: text }; return m ? fillFromSuggestion(y, m, !x.categoryId || !!x.auto) : y; });
    clearErr(r.key, 'description'); if (m) clearErr(r.key, 'category');
  };

  const changeDay = (d: string) => {
    if (!d || d > today || d === day || busyRef.current) return;   // never mid-save: the saved ids must land on this day's rows
    const n = rows ? stashOf(rows).length : 0;
    if (n) toast('info', T(`${n} unsaved row(s) of ${dateLabel(day, lang)} are kept on this device. Come back to that day to save them.`, `เก็บ ${n} แถวที่ยังไม่บันทึกของ${dateLabel(day, lang)}ไว้ในเครื่องนี้แล้ว กลับไปที่วันนั้นเพื่อบันทึก`));
    setDay(d);
  };

  // ---------------------------------------------------------------- saving
  const errText = (f: keyof RowErrors, code?: string) => {
    if (!code) return '';
    if (f === 'description') return code === 'too_long' ? T('At most 300 characters', 'ไม่เกิน 300 ตัวอักษร') : T('Type what it was', 'ใส่ชื่อรายการ');
    if (f === 'category') return code === 'inactive' ? T('This category is closed: pick another', 'หมวดนี้ปิดใช้แล้ว เลือกหมวดอื่น') : T('Pick a category', 'เลือกหมวดหมู่');
    if (f === 'amount') return code === 'too_big' ? T('Too large', 'จำนวนเงินมากเกินไป') : code === 'invalid' ? T('Numbers only, up to 2 decimals', 'ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง') : T('Enter the amount', 'ใส่จำนวนเงิน');
    return T('At most 1,000 characters', 'ไม่เกิน 1,000 ตัวอักษร');
  };

  /** Saves every changed row. Returns the day's rows as they are after saving, or null when something is still unsaved. */
  const save = async (): Promise<SheetRow[] | null> => {
    const cur = sheetRef.current;
    if (busyRef.current || !cur) return null;
    const dirty = cur.rows.filter(isDirty);
    if (!dirty.length) return cur.rows;
    let latest = cur.rows;
    const bad: Record<string, RowErrors> = {};
    for (const r of dirty) { const e = validateRow(r, catById); if (Object.keys(e).length) bad[r.key] = e; }
    setErrs(bad);
    if (Object.keys(bad).length) {
      toast('error', T('Some rows are not complete: fix the fields marked in red', 'บางแถวยังกรอกไม่ครบ กรุณาแก้ช่องที่มีสีแดง'));
      const k = Object.keys(bad)[0]; itemRefs.current[k]?.focus();
      return null;
    }
    busyRef.current = true; setBusy('save');
    const failed: Record<string, string> = {};
    let ok = 0;
    try {
      for (const r of dirty) {
        try {
          const c = await saveClaim({
            id: r.id, expenseDate: cur.day, categoryId: r.categoryId, description: r.description.trim(), amount: parseAmount(r.amount)!,
            taxType: r.id ? r.taxType : newRowTaxType(catById[r.categoryId], settings.vat_registered), paymentMethod: r.method,
            vendor: r.base?.vendor ?? '', vendorTaxId: r.base?.vendor_tax_id ?? '', referenceNo: r.base?.reference_no ?? '', notes: r.notes.trim(),
          });
          ok++;
          // the row keeps its place and key; from now on it is that claim (a second save updates it)
          const done = { ...rowFromClaim(c), key: r.key };
          latest = latest.map((x) => (x.key === r.key ? done : x));
          setSheet((s) => (s && s.day === cur.day ? { ...s, rows: s.rows.map((x) => (x.key === r.key ? done : x)) } : s));
        } catch (e) { failed[r.key] = (e as Error).message; }
      }
    } finally { busyRef.current = false; setBusy(''); }
    setRowErr(failed);
    const nFail = Object.keys(failed).length;
    if (ok) { onChanged(); loadHistory(); }
    if (nFail) { toast('error', T(`${ok} saved, ${nFail} not saved: ${Object.values(failed)[0]}. Your rows are still here; press Save again.`, `บันทึกแล้ว ${ok} รายการ ยังไม่สำเร็จ ${nFail} รายการ: ${Object.values(failed)[0]} ข้อมูลยังอยู่ครบ กด “บันทึก” อีกครั้งได้`)); return null; }
    toast('success', T(`Saved ${ok} expense(s) for ${dateLabel(cur.day, 'en')}`, `บันทึก ${ok} รายการของ${dateLabel(cur.day, 'th')}แล้ว`));
    return latest;
  };

  const submitDay = async () => {
    if (busyRef.current) return;
    const cur = sheetRef.current;
    const now = await save();
    if (!now || !cur) return;
    const ready = now.filter((r) => r.id && (r.status === 'draft' || r.status === 'rejected'));
    if (!ready.length) { toast('info', T('Nothing to send: save some rows first.', 'ยังไม่มีรายการที่จะส่ง กรุณาบันทึกก่อน')); return; }
    const sum = ready.reduce((s, r) => Math.round((s + (parseAmount(r.amount) ?? 0)) * 100) / 100, 0);
    const x = await confirm({
      title: T(`Send ${ready.length} expense(s) for approval?`, `ส่ง ${ready.length} รายการขออนุมัติ?`),
      body: T(`Total ${formatAmount(sum)} THB. After sending they cannot be changed here unless the approver sends them back.`, `รวม ${formatAmount(sum)} บาท ส่งแล้วจะแก้ไขไม่ได้ จนกว่าผู้อนุมัติจะส่งกลับมา`),
      confirmLabel: T('Send for approval', 'ส่งอนุมัติ'),
    });
    if (!x.ok) return;
    busyRef.current = true; setBusy('submit');
    let ok = 0; let firstErr = '';
    try {
      for (const r of ready) { try { await submitClaim(r.id!); ok++; } catch (e) { firstErr ||= (e as Error).message; } }
    } finally { busyRef.current = false; setBusy(''); }
    if (firstErr) toast('error', T(`${ok} sent; the rest failed: ${firstErr}`, `ส่งแล้ว ${ok} รายการ ที่เหลือไม่สำเร็จ: ${firstErr}`));
    else toast('success', T(`${ok} expense(s) sent for approval`, `ส่งขออนุมัติแล้ว ${ok} รายการ`));
    onChanged();
    void loadDay(cur.day, true);
  };

  const removeRow = async (r: SheetRow) => {
    if (busyRef.current) return;
    if (r.id === null) {
      setRows((rs) => { const left = rs.filter((x) => x.key !== r.key); return left.some((x) => isEditable(x) && isBlank(x)) ? left : [...left, blankRow(r.method)]; });
      setErrs((e) => ({ ...e, [r.key]: {} }));
      return;
    }
    const needReason = r.status !== 'draft';
    const x = await confirm({
      title: T('Remove this expense?', 'ลบรายการนี้?'),
      body: T(`“${r.saved?.description ?? r.description}” will be cancelled. Expenses are never erased: it stays in the history as cancelled.`, `“${r.saved?.description ?? r.description}” จะถูกยกเลิก ระบบไม่ลบรายการทิ้ง แต่จะเก็บไว้ในประวัติว่ายกเลิกแล้ว`),
      danger: true, confirmLabel: T('Remove', 'ลบรายการ'), ...(needReason ? { reason: T('Reason', 'เหตุผล') } : {}),
    });
    if (!x.ok) return;
    busyRef.current = true;
    try {
      await cancelClaim(r.id, x.reason);
      setRows((rs) => { const left = rs.filter((y) => y.key !== r.key); return left.length ? left : [blankRow(r.method)]; });
      toast('success', T('Removed', 'ลบรายการแล้ว'));
      onChanged();
    } catch (e) { toast('error', (e as Error).message); } finally { busyRef.current = false; }
  };

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  };

  // ---------------------------------------------------------------- view
  const anyDraft = !!rows?.some((r) => r.id && (r.status === 'draft' || r.status === 'rejected'));
  const isToday = day === today;
  const methodLabel = (m: PayMethod) => (lang === 'th' ? METHOD_META[m].th : METHOD_META[m].en);
  return (
    <div className="xs" onKeyDown={onKeys}>
      <div className="xs-head">
        <div className="xs-date">
          <div className="xs-date-nav">
            <Button icon aria-label={T('Previous day', 'วันก่อนหน้า')} onClick={() => changeDay(shiftDay(day, -1))}><ChevronLeft size={18} /></Button>
            <label className="xs-date-pick">
              <CalendarDays size={16} />
              <input type="date" aria-label={T('Expense date', 'วันที่จ่ายเงิน')} value={day} max={today} onChange={(e) => changeDay(e.target.value)} />
            </label>
            <Button icon aria-label={T('Next day', 'วันถัดไป')} onClick={() => changeDay(shiftDay(day, 1))} style={isToday ? { visibility: 'hidden' } : undefined}><ChevronRight size={18} /></Button>
            {!isToday && <Button variant="soft" onClick={() => changeDay(today)}>{T('Today', 'วันนี้')}</Button>}
          </div>
          <div className="xs-date-label"><b>{dateLabel(day, lang)}</b>{isToday && <Badge tone="info">{T('Today', 'วันนี้')}</Badge>}</div>
        </div>
        <div className="xs-stats" aria-live="polite">
          <div className="xs-stat"><span>{T('Items', 'จำนวนรายการ')}</span><b data-testid="xs-count">{totals.count}</b></div>
          <div className="xs-stat main"><span>{T('Total for the day', 'รวมทั้งวัน')}</span><b data-testid="xs-total">฿{formatAmount(totals.total)}</b></div>
        </div>
      </div>

      {others.length > 0 && (
        <div className="xs-others">
          {T('Unsaved rows on other days:', 'มีแถวที่ยังไม่บันทึกในวันอื่น:')}{' '}
          {others.slice(0, 5).map((o) => <button key={o.day} type="button" className="exp-chip" onClick={() => changeDay(o.day)}>{dateLabel(o.day, lang, true)} ({o.n})</button>)}
        </div>)}

      {loadErr && <div className="exp-err xs-loaderr" role="alert">{loadErr} <Button size="sm" onClick={() => void loadDay(day, false)}>{T('Try again', 'ลองอีกครั้ง')}</Button></div>}
      {!rows ? (!loadErr && <div className="card-b"><div className="spinner" /></div>) : (
        <div className="xs-grid" role="table" aria-label={T('Expenses of the day', 'รายจ่ายของวัน')}>
          <div className="xs-row xs-hrow" role="row">
            <span role="columnheader" className="xs-n">#</span>
            <span role="columnheader">{T('Expense item', 'รายการ')}</span>
            <span role="columnheader">{T('Category', 'หมวดหมู่')}</span>
            <span role="columnheader">{T('Paid by', 'จ่ายโดย')}</span>
            <span role="columnheader" className="num">{T('Amount (฿)', 'จำนวนเงิน (บาท)')}</span>
            <span role="columnheader">{T('Notes', 'หมายเหตุ')}</span>
            <span role="columnheader" className="sr-only">{T('Actions', 'จัดการ')}</span>
          </div>
          {rows.map((r, i) => {
            const e = errs[r.key] ?? {};
            const edit = isEditable(r) && busy === '';
            const dirty = isDirty(r);
            const n = parseAmount(r.amount);
            if (!isEditable(r)) return (
              <div key={r.key} className="xs-row xs-locked" role="row" data-testid="xs-row">
                <span className="xs-n" role="cell">{i + 1}</span>
                <span role="cell" className="xs-item"><b className="xs-lt"><span className="xs-ico" aria-hidden><CatIcon name={(catById[r.categoryId] ?? r.base?.category)?.icon} size={14} /></span>{r.description}</b><span className="xs-meta"><StatusBadge status={r.status!} />{r.expenseNo && <span className="muted">{r.expenseNo}</span>}</span></span>
                <span role="cell" className="xs-cat">{catName(lang, catById[r.categoryId] ?? r.base?.category)}</span>
                <span role="cell" className="xs-method">{methodLabel(r.method)}</span>
                <span role="cell" className="xs-amt num"><b>{n !== null ? formatAmount(n) : r.amount}</b></span>
                <span role="cell" className="xs-notes muted">{r.notes}</span>
                <span role="cell" className="xs-act"><Button size="sm" variant="ghost" icon aria-label={T('Open details', 'ดูรายละเอียด')} title={T('Open details', 'ดูรายละเอียด')} onClick={() => onOpen(r.id!)}><ExternalLink size={15} /></Button></span>
              </div>);
            return (
              <Fragment key={r.key}>
                <div className={cx('xs-row', dirty && 'dirty', rowErr[r.key] && 'failed')} role="row" data-testid="xs-row">
                  <span className="xs-n" role="cell" title={dirty ? T('Not saved yet', 'ยังไม่บันทึก') : undefined}>{dirty ? <i className="xs-dot" aria-label={T('Not saved yet', 'ยังไม่บันทึก')} /> : i + 1}</span>
                  <span role="cell" className="xs-item">
                    <ItemBox inputRef={(el) => { itemRefs.current[r.key] = el; }} value={r.description} options={options} icon={catById[r.categoryId]?.icon} invalid={!!e.description} readOnly={!edit}
                      placeholder={T('e.g. Coffee, Gasoline…', 'เช่น กาแฟ ค่าน้ำมัน…')} label={T(`Expense item, row ${i + 1}`, `รายการ แถว ${i + 1}`)} listLabel={T(`Suggestions for the item, row ${i + 1}`, `รายการแนะนำ แถว ${i + 1}`)} onChange={(text) => typeItem(r, text)} />
                    {e.description && <span className="exp-err">{errText('description', e.description)}</span>}
                    {(r.status === 'rejected' || r.id) && <span className="xs-meta">{r.status && <StatusBadge status={r.status} />}{r.status === 'rejected' && r.base?.reject_reason && <span className="muted">{r.base.reject_reason}</span>}</span>}
                  </span>
                  <span role="cell" className="xs-cat">
                    <select className={cx('select', e.category && 'bad')} value={r.categoryId} disabled={!edit} aria-label={T(`Category, row ${i + 1}`, `หมวดหมู่ แถว ${i + 1}`)} aria-invalid={!!e.category}
                      onChange={(ev) => { patch(r.key, { categoryId: ev.target.value, auto: false }); clearErr(r.key, 'category'); }}>
                      <option value="">{T('Category…', 'เลือกหมวด…')}</option>
                      {active.map((c) => <option key={c.id} value={c.id}>{catName(lang, c)}</option>)}
                      {r.categoryId && !catById[r.categoryId]?.active && <option value={r.categoryId}>{catName(lang, catById[r.categoryId] ?? r.base?.category)} ({T('closed', 'ปิดใช้')})</option>}
                    </select>
                    {e.category && <span className="exp-err">{errText('category', e.category)}</span>}
                  </span>
                  <span role="cell" className="xs-method">
                    <select className="select" value={r.method} disabled={!edit} aria-label={T(`Paid by, row ${i + 1}`, `จ่ายโดย แถว ${i + 1}`)} onChange={(ev) => patch(r.key, { method: ev.target.value as PayMethod })}>
                      {(Object.keys(METHOD_META) as PayMethod[]).map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
                    </select>
                  </span>
                  <span role="cell" className="xs-amt">
                    <span className={cx('xs-money', e.amount && 'bad')}>
                      <i aria-hidden>฿</i>
                      <input className="input num" inputMode="decimal" autoComplete="off" placeholder="0.00" readOnly={!edit} aria-label={T(`Amount, row ${i + 1}`, `จำนวนเงิน แถว ${i + 1}`)} aria-invalid={!!e.amount}
                        value={r.amount} onBlur={() => { if (n !== null && r.amount !== formatAmount(n)) patch(r.key, { amount: formatAmount(n) }); }}
                        onChange={(ev) => { patch(r.key, { amount: ev.target.value.replace(/[^0-9.,]/g, '') }); clearErr(r.key, 'amount'); }} onKeyDown={onEnter(r.key)} />
                    </span>
                    {e.amount && <span className="exp-err">{errText('amount', e.amount)}</span>}
                  </span>
                  <span role="cell" className="xs-notes">
                    <input className={cx('input', e.notes && 'bad')} value={r.notes} maxLength={1000} readOnly={!edit} placeholder={T('Optional', 'ไม่บังคับ')} aria-label={T(`Notes, row ${i + 1}`, `หมายเหตุ แถว ${i + 1}`)}
                      onChange={(ev) => { patch(r.key, { notes: ev.target.value }); clearErr(r.key, 'notes'); }} onKeyDown={onEnter(r.key)} />
                  </span>
                  <span role="cell" className="xs-act">
                    {r.id && <Button size="sm" variant="ghost" icon aria-label={T('Open details (receipts, VAT)', 'ดูรายละเอียด (ใบเสร็จ, VAT)')} title={T('Open details (receipts, VAT)', 'ดูรายละเอียด (ใบเสร็จ, VAT)')} onClick={() => onOpen(r.id!)}><ExternalLink size={15} /></Button>}
                    {!(r.id === null && isBlank(r) && rows.length === 1) && <Button size="sm" variant="ghost" icon aria-label={T(`Delete row ${i + 1}`, `ลบแถว ${i + 1}`)} title={T('Delete row', 'ลบแถว')} onClick={() => void removeRow(r)}><Trash2 size={15} /></Button>}
                  </span>
                </div>
                {rowErr[r.key] && <div className="xs-rowerr exp-err" role="alert">{T('Not saved', 'ยังไม่ได้บันทึก')}: {rowErr[r.key]}</div>}
              </Fragment>);
          })}
        </div>)}

      {rows && (
        <div className="xs-bar">
          <Button onClick={addRow}><Plus size={16} />{' '}{T('Add expense', 'เพิ่มรายการ')}</Button>
          <span className="xs-bar-sum">
            <span>{T(`${totals.count} item(s)`, `${totals.count} รายการ`)}</span><b>฿{formatAmount(totals.total)}</b>
            {totals.unsaved > 0 && <Badge tone="warn" dot>{T(`${totals.unsaved} not saved`, `ยังไม่บันทึก ${totals.unsaved}`)}</Badge>}
          </span>
          <span className="xs-bar-act">
            {anyDraft && <Button onClick={() => void submitDay()}>{busy === 'submit' ? T('Sending…', 'กำลังส่ง…') : <><Send size={15} />{' '}{T('Send day for approval', 'ส่งอนุมัติทั้งวัน')}</>}</Button>}
            <Button variant="primary" data-testid="xs-save" onClick={() => { void save().then((ok) => { if (ok && totals.unsaved === 0) toast('info', T('Everything on this day is already saved', 'บันทึกครบทุกรายการแล้ว')); }); }}>
              {busy === 'save' ? T('Saving…', 'กำลังบันทึก…') : totals.unsaved > 0 ? T(`Save ${totals.unsaved} expense(s)`, `บันทึก ${totals.unsaved} รายการ`) : T('Save expenses', 'บันทึกรายการ')}
            </Button>
          </span>
        </div>)}

      <div className="xs-foot muted">
        <span className="xs-keys">{T('Enter in Amount or Notes goes to the next row · Ctrl+S saves · Saved rows stay editable until you send them for approval.', 'กด Enter ที่ช่องจำนวนเงินหรือหมายเหตุเพื่อไปแถวถัดไป · Ctrl+S บันทึก · รายการที่บันทึกแล้วยังแก้ไขได้จนกว่าจะส่งอนุมัติ')}</span>
        <button type="button" className="exp-more" onClick={() => setFull(true)}><FileText size={15} />{' '}{T('Detailed entry (receipt photo, VAT, vendor)', 'บันทึกแบบละเอียด (ถ่ายใบเสร็จ, VAT, ร้านค้า)')}</button>
      </div>
      {full && <Modal title={T('New expense (detailed)', 'บันทึกรายจ่ายแบบละเอียด')} size="lg" onClose={() => setFull(false)}>
        <ExpenseForm defaultDate={day} onDone={() => { setFull(false); onChanged(); loadHistory(); }} />
      </Modal>}
    </div>
  );
}

/** "Thursday 26 November 2026" / "วันพฤหัสบดีที่ 26 พฤศจิกายน 2569" (short: "26 Nov" / "26 พ.ย.") */
export function dateLabel(day: string, lang: string, short = false): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (short) return dt.toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short' });
  const s = dt.toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return lang === 'th' ? s.replace(/^(วัน\S+)\s+/, '$1ที่ ') : s;
}

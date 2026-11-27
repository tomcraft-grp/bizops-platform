// The daily expense sheet, without the screen: one date, many rows, one total. Pure functions so the arithmetic, the checks and the
// "keep my unsaved rows" logic are tested on their own (tests/unit/expenseSheet.test.ts). Each row is one expense claim in the database
// (public.expense_claims); the sheet only decides which rows to save, and expense_save stays the single writer that recomputes the money.
import type { TaxType } from '../domain/expenseLedger';
import type { Category, Claim, PayMethod, Status } from './api';

export interface SavedFields { description: string; categoryId: string; amount: number; method: PayMethod; notes: string }
export interface SheetRow {
  /** stable React key: stays the same when the row is saved and gets an id */
  key: string;
  /** the claim id once saved: saving again updates that claim instead of creating a new one */
  id: string | null;
  status: Status | null;
  expenseNo: string | null;
  description: string; categoryId: string; amount: string; method: PayMethod; notes: string;
  taxType: TaxType;
  /** the category was filled in from a suggestion, so picking another suggestion may replace it */
  auto?: boolean;
  /** what the database holds now (null for a new row) */
  saved: SavedFields | null;
  /** the stored claim, so fields the sheet does not show (vendor, tax ID, reference) are sent back unchanged */
  base: Claim | null;
}

let seq = 0;
const newKey = () => `r${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const cents = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// ------------------------------------------------------------------------------------------ amounts and dates
/** What people type ("1,234.50", "฿ 80", ".5") as a number above zero with at most two decimals, or null. */
export function parseAmount(s: string): number | null {
  const t = s.replace(/[\s,฿]/g, '');
  if (!t || t === '.' || !/^\d*\.?\d{0,2}$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? cents(n) : null;
}
const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatAmount = (n: number) => fmt.format(n);
export const MAX_AMOUNT = 99_999_999;

/** yyyy-mm-dd plus n days, computed in UTC so no time zone can shift the day. */
export function shiftDay(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------------------------------ rows
export function blankRow(method: PayMethod): SheetRow {
  return { key: newKey(), id: null, status: null, expenseNo: null, description: '', categoryId: '', amount: '', method, notes: '', taxType: 'none', saved: null, base: null };
}
export function rowFromClaim(c: Claim): SheetRow {
  const amount = Number(c.amount_paid);
  return {
    key: `c-${c.id}`, id: c.id, status: c.status, expenseNo: c.expense_no, description: c.description, categoryId: c.category_id, amount: formatAmount(amount), method: c.payment_method,
    notes: c.notes ?? '', taxType: c.tax_type, saved: { description: c.description, categoryId: c.category_id, amount, method: c.payment_method, notes: c.notes ?? '' }, base: c,
  };
}
/** New rows, drafts and rejected expenses can be changed here. Anything sent for approval is locked (the database enforces the same).
 *  "VAT added on top" is edited in the full form: there the amount typed is the price before VAT, here it is the money paid. */
export const isEditable = (r: SheetRow) => (r.status === null || r.status === 'draft' || r.status === 'rejected') && r.taxType !== 'vat_excluded';
export const isBlank = (r: SheetRow) => r.id === null && !r.description.trim() && !r.amount.trim() && !r.notes.trim() && !r.categoryId;
export function isDirty(r: SheetRow): boolean {
  if (r.id === null) return !isBlank(r);
  if (!isEditable(r) || !r.saved) return false;
  const s = r.saved;
  return r.description.trim() !== s.description || r.categoryId !== s.categoryId || parseAmount(r.amount) !== s.amount || r.method !== s.method || r.notes.trim() !== s.notes;
}

export type RowErrors = Partial<Record<'description' | 'category' | 'amount' | 'notes', 'required' | 'inactive' | 'too_long' | 'invalid' | 'too_big'>>;
/** The same checks expense_save makes, so a row is fixed before anything is sent. */
export function validateRow(r: SheetRow, catById: Record<string, Category | undefined>): RowErrors {
  const e: RowErrors = {};
  const d = r.description.trim();
  if (!d) e.description = 'required'; else if (d.length > 300) e.description = 'too_long';
  if (!r.categoryId) e.category = 'required'; else if (!catById[r.categoryId]?.active) e.category = 'inactive';
  const n = parseAmount(r.amount);
  if (!r.amount.trim()) e.amount = 'required'; else if (n === null) e.amount = 'invalid'; else if (n > MAX_AMOUNT) e.amount = 'too_big';
  if (r.notes.trim().length > 1000) e.notes = 'too_long';
  return e;
}

export function dayTotals(rows: SheetRow[]): { count: number; total: number; unsaved: number } {
  let count = 0, total = 0, unsaved = 0;
  for (const r of rows) {
    if (isBlank(r)) continue;
    count++;
    total = cents(total + (parseAmount(r.amount) ?? 0));
    if (isDirty(r)) unsaved++;
  }
  return { count, total, unsaved };
}

/** A new row's tax type: the category's default when the business is VAT-registered. "VAT added on top" becomes "VAT included",
 *  because a sheet row records the money paid. The accountant still reviews the tax before posting. */
export function newRowTaxType(cat: Category | undefined, vatRegistered: boolean): TaxType {
  if (!cat || !vatRegistered) return 'none';
  return cat.default_tax_type === 'vat_excluded' ? 'vat_included' : cat.default_tax_type;
}

// ------------------------------------------------------------------------------------------ suggestions for the item box
export interface Suggestion { text: string; categoryId: string; method: PayMethod | null; uses: number; last: string }
/** The person's own items, most used first (category and payment method as used last time), then the active category names. */
export function suggestionsFrom(history: Claim[], categories: Category[], lang: string): Suggestion[] {
  const active = new Set(categories.filter((c) => c.active).map((c) => c.id));
  const by = new Map<string, Suggestion>();
  for (const c of history) {
    if (c.status === 'cancelled') continue;
    const text = c.description.trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const k = norm(text);
    const prev = by.get(k);
    if (!prev) { by.set(k, { text, categoryId: active.has(c.category_id) ? c.category_id : '', method: c.payment_method, uses: 1, last: c.created_at }); continue; }
    prev.uses++;
    if (c.created_at > prev.last) Object.assign(prev, { text, categoryId: active.has(c.category_id) ? c.category_id : '', method: c.payment_method, last: c.created_at });
  }
  const mine = [...by.values()].sort((a, b) => b.uses - a.uses || (a.last < b.last ? 1 : -1));
  const cats = categories.filter((c) => c.active).map((c) => ({ text: lang === 'th' ? c.name_th : c.name_en, categoryId: c.id, method: null, uses: 0, last: '' }))
    .filter((s) => !by.has(norm(s.text)));
  return [...mine, ...cats];
}
export const matchSuggestion = (list: Suggestion[], typedText: string): Suggestion | null => { const k = norm(typedText); return k ? list.find((s) => norm(s.text) === k) ?? null : null; };
/** The suggestions that fit what was typed (any part of the text, upper or lower case), in the same order. Nothing is offered when the only fit is exactly what is
 *  typed: there is nothing left to choose. */
export function filterSuggestions<T extends { text: string }>(list: T[], typed: string, limit = 60): T[] {
  const k = norm(typed);
  const hit = k ? list.filter((s) => norm(s.text).includes(k)) : list;
  if (k && hit.length === 1 && norm(hit[0].text) === k) return [];
  return hit.slice(0, limit);
}
/** Fill the category (and how it was paid) from a suggestion. `overwrite` = the person did not choose them by hand. */
export function fillFromSuggestion(r: SheetRow, s: Suggestion, overwrite: boolean): SheetRow {
  const out = { ...r };
  if (s.categoryId && (overwrite || !r.categoryId)) { out.categoryId = s.categoryId; out.auto = true; }
  if (s.method && overwrite) out.method = s.method;
  return out;
}

// ------------------------------------------------------------------------------------------ unsaved work
/** The rows worth keeping in this browser until they are saved. */
export const stashOf = (rows: SheetRow[]) => rows.filter(isDirty);
/** The day as the server has it (creation order, cancelled left out) with the unsaved rows put back, then one blank row.
 *  An edit to a row that is no longer editable here (sent for approval, cancelled elsewhere) is dropped and counted. */
export function mergeDay(server: Claim[], stash: SheetRow[], method: PayMethod): { rows: SheetRow[]; dropped: number } {
  const rows = server.filter((c) => c.status !== 'cancelled').sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)).map(rowFromClaim);
  let dropped = 0;
  for (const s of stash) {
    if (s.id === null) { rows.push(s); continue; }
    const i = rows.findIndex((r) => r.id === s.id);
    if (i < 0 || !isEditable(rows[i])) { dropped++; continue; }
    rows[i] = { ...rows[i], description: s.description, categoryId: s.categoryId, amount: s.amount, method: s.method, notes: s.notes, auto: s.auto };
  }
  const last = rows[rows.length - 1];
  rows.push(blankRow(last?.method ?? method));
  return { rows, dropped };
}

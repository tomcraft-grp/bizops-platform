// Bank books (สมุดบัญชีธนาคาร): the balance of each of the shop's bank accounts and every movement behind it. The balance is never typed in:
// it is the sum of an append-only ledger (public.finance_bank_transactions) — the opening balance, posted expenses paid from the account,
// their reversals and adjustments to match the statement. Each movement links to the expense that caused it. Used on the Daily expenses
// page (people who post expenses) and on Payments & wallet → Bank accounts (finance staff).
import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Landmark, Plus, Scale } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toast, useLang } from '../domain/store';
import { Badge, Banner, Button, Card, Empty, ErrText, Field, Input, Modal, Select, Textarea } from '../ui/kit';
import { cx, dateFmt, dateTimeFmt, dayKey, money } from '../lib/util';

export interface BankBalance {
  id: string; code: string; bank_name_th: string; bank_name_en: string; account_name: string; last4: string; active: boolean; balance: number; updated_at: string | null;
  has_opening: boolean; txns: number; expense_out: number;
}
export interface BankMove {
  id: string; txn_no: string; txn_type: 'OPENING' | 'EXPENSE' | 'EXPENSE_REVERSAL' | 'ADJUSTMENT'; direction: 'in' | 'out'; amount: number; balance_before: number; balance_after: number;
  value_date: string; created_at: string; created_by_name: string | null; note: string | null; ref_no: string | null; reversal_of_no: string | null; reversed_by_no: string | null;
  expense: { id: string; expense_no: string | null; description: string; status: string; expense_date: string } | null;
}
interface Reconcile { bank_account_id: string; code: string; balance: number; ledger: number; chain_breaks: number; ok: boolean }

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const r = await supabase.rpc(fn, args);
  if (r.error) throw new Error(r.error.message === 'REASON_TOO_SHORT' ? 'REASON_TOO_SHORT' : r.error.message);
  return r.data as T;
}
export const bankBooks = {
  overview: () => rpc<BankBalance[]>('finance_bank_overview'),
  ledger: (bank: string, limit = 200, offset = 0) => rpc<{ balance: number | null; total: number; items: BankMove[] }>('finance_bank_ledger', { p_bank: bank, p_limit: limit, p_offset: offset }),
  reconcile: () => rpc<Reconcile[]>('finance_bank_reconcile'),
  opening: (bank: string, amount: number, date: string, note: string) => rpc<BankMove>('finance_bank_opening', { p_bank: bank, p_amount: amount, p_date: date, p_note: note || null }),
  adjust: (bank: string, direction: 'in' | 'out', amount: number, reason: string, key: string) => rpc<BankMove>('finance_bank_adjust', { p_bank: bank, p_direction: direction, p_amount: amount, p_reason: reason, p_key: key }),
};

const TYPE: Record<BankMove['txn_type'], [string, string]> = {
  OPENING: ['Opening balance', 'ยอดยกมา'], EXPENSE: ['Expense paid', 'จ่ายค่าใช้จ่าย'], EXPENSE_REVERSAL: ['Expense reversed', 'กลับรายการค่าใช้จ่าย'], ADJUSTMENT: ['Adjustment', 'ปรับปรุงยอด'],
};
const newKey = () => { try { return crypto.randomUUID(); } catch { return `adj-${Date.now()}-${Math.random().toString(36).slice(2)}`; } };

/** `canManage`: may enter the opening balance and adjustments (finance manager / owner). The database checks it again. */
export function BankBooks({ refreshKey = 0, canManage, onOpenExpense }: { refreshKey?: number; canManage?: boolean; onOpenExpense?: (id: string) => void }) {
  const lang = useLang();
  const T = (en: string, th: string) => (lang === 'th' ? th : en);
  const [list, setList] = useState<BankBalance[] | null>(null);
  const [rec, setRec] = useState<Reconcile[]>([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => {
    setErr('');
    Promise.all([bankBooks.overview(), bankBooks.reconcile()]).then(([o, r]) => { setList(o); setRec(r); setOpen((x) => x ?? o.find((b) => b.active)?.id ?? null); })
      .catch((e) => { setErr((e as Error).message); setList([]); });
  }, []);
  useEffect(load, [load, refreshKey, tick]);
  const bad = rec.filter((r) => !r.ok || r.chain_breaks > 0);
  const cur = list?.find((b) => b.id === open);

  if (list === null) return <div className="card-b"><div className="spinner" /></div>;
  return (
    <div className="col gap-16">
      {err && <Banner tone="bad"><ErrText>{err}</ErrText></Banner>}
      <div className="bb-cards">
        {list.map((b) => (
          <button key={b.id} type="button" className={cx('bb-card', b.id === open && 'on', !b.active && 'off')} onClick={() => setOpen(b.id)} data-testid="bb-card">
            <span className="row gap-8"><Landmark size={18} /><b>{b.code}</b><span className="muted">••{b.last4}</span>{!b.active && <Badge>{T('inactive', 'ปิดใช้')}</Badge>}</span>
            <span className="muted bb-name">{lang === 'th' ? b.bank_name_th : b.bank_name_en} · {b.account_name}</span>
            <span className={cx('bb-bal', Number(b.balance) < 0 && 'exp-err')} data-testid="bb-balance">{money(Number(b.balance))}</span>
            <span className="muted bb-meta">{b.has_opening ? T(`${b.txns} movement(s)`, `${b.txns} รายการเคลื่อนไหว`) : <span className="exp-err">{T('no opening balance yet', 'ยังไม่ได้ใส่ยอดยกมา')}</span>}</span>
          </button>))}
      </div>
      {rec.length > 0 && (bad.length ? <Banner tone="bad"><Scale size={14} />{' '}{T(`Ledger check: ${bad.map((r) => r.code).join(', ')} does not add up — tell the developer.`, `ตรวจสมุดบัญชี: ${bad.map((r) => r.code).join(', ')} ยอดไม่ตรงกับรายการ แจ้งผู้พัฒนา`)}</Banner>
        : <div><Badge tone="good" dot>{T('Ledger check: every balance equals the sum of its movements', 'ตรวจสมุดบัญชี: ยอดคงเหลือทุกบัญชีตรงกับผลรวมรายการเคลื่อนไหว')}</Badge></div>)}
      {list.length === 0 && <Empty title={T('No bank accounts are set up', 'ยังไม่ได้ตั้งค่าบัญชีธนาคาร')} />}
      {cur && <Ledger bank={cur} canManage={!!canManage} refreshKey={refreshKey + tick} onChanged={() => setTick((x) => x + 1)} onOpenExpense={onOpenExpense} />}
      <div className="muted">{T('Only posted expenses move a balance (drafts never do). Customer transfers into the account are not recorded here yet: match the statement with an adjustment.', 'ยอดจะเปลี่ยนเฉพาะรายจ่ายที่ลงบัญชีแล้วเท่านั้น (แบบร่างไม่ตัดยอด) เงินที่ลูกค้าโอนเข้ายังไม่ถูกบันทึกในสมุดนี้ ให้ปรับยอดให้ตรงกับรายการเดินบัญชีด้วย “ปรับปรุงยอด”')}</div>
    </div>
  );
}

function Ledger({ bank, canManage, refreshKey, onChanged, onOpenExpense }: { bank: BankBalance; canManage: boolean; refreshKey: number; onChanged: () => void; onOpenExpense?: (id: string) => void }) {
  const lang = useLang();
  const T = (en: string, th: string) => (lang === 'th' ? th : en);
  const [data, setData] = useState<{ balance: number | null; total: number; items: BankMove[] } | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<'' | 'opening' | 'adjust'>('');
  useEffect(() => {
    let live = true;
    setData(null); setErr('');
    bankBooks.ledger(bank.id).then((d) => live && setData(d)).catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [bank.id, refreshKey]);
  return (
    <Card flush title={<span className="row gap-8"><Landmark size={16} />{bank.code} ••{bank.last4} · {money(Number(bank.balance))}</span>} sub={T('Movements, newest first. Click an expense to open it.', 'รายการเคลื่อนไหว ล่าสุดอยู่บน คลิกรายการค่าใช้จ่ายเพื่อเปิดดู')}
      actions={canManage && <span className="row gap-8">
        {!bank.has_opening && <Button size="sm" variant="primary" onClick={() => setForm('opening')}><Plus size={14} />{' '}{T('Opening balance', 'ใส่ยอดยกมา')}</Button>}
        <Button size="sm" onClick={() => setForm('adjust')}><Scale size={14} />{' '}{T('Adjust to statement', 'ปรับปรุงยอด')}</Button></span>}>
      {err && <div className="card-b"><ErrText>{err}</ErrText></div>}
      {!data ? <div className="card-b"><div className="spinner" /></div> : data.items.length === 0 ? <Empty title={T('No movements yet', 'ยังไม่มีรายการเคลื่อนไหว')} /> : (
        <div className="table-wrap"><table className="t" data-testid="bb-ledger">
          <thead><tr><th>{T('Date', 'วันที่')}</th><th>{T('Movement', 'รายการ')}</th><th className="num">{T('In', 'เงินเข้า')}</th><th className="num">{T('Out', 'เงินออก')}</th><th className="num">{T('Balance', 'คงเหลือ')}</th></tr></thead>
          <tbody>{data.items.map((m) => (
            <tr key={m.id} className={cx(m.expense && onOpenExpense && 'clickable')} onClick={() => m.expense && onOpenExpense?.(m.expense.id)}>
              <td>{dateFmt(m.value_date)}<div className="sub">{dateTimeFmt(m.created_at)}</div></td>
              <td><span className="row gap-6">{m.direction === 'in' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}<b>{lang === 'th' ? TYPE[m.txn_type][1] : TYPE[m.txn_type][0]}</b><span className="muted">{m.txn_no}</span></span>
                <div className="sub">{m.expense ? `${m.expense.expense_no ?? ''} ${m.expense.description}` : m.note}{m.reversal_of_no ? ` · ${T('reverses', 'กลับรายการ')} ${m.reversal_of_no}` : ''}{m.reversed_by_no ? ` · ${T('reversed by', 'ถูกกลับโดย')} ${m.reversed_by_no}` : ''}{m.created_by_name ? ` · ${m.created_by_name}` : ''}</div></td>
              <td className="num">{m.direction === 'in' ? money(Number(m.amount)) : ''}</td>
              <td className="num">{m.direction === 'out' ? money(Number(m.amount)) : ''}</td>
              <td className={cx('num', Number(m.balance_after) < 0 && 'exp-err')}><b>{money(Number(m.balance_after))}</b></td>
            </tr>))}</tbody>
        </table></div>)}
      {data && data.total > data.items.length && <div className="card-b muted">{T(`Showing the latest ${data.items.length} of ${data.total}.`, `แสดงล่าสุด ${data.items.length} จาก ${data.total} รายการ`)}</div>}
      {form && <MoveForm kind={form} bank={bank} onClose={() => setForm('')} onDone={() => { setForm(''); onChanged(); }} />}
    </Card>
  );
}

function MoveForm({ kind, bank, onClose, onDone }: { kind: 'opening' | 'adjust'; bank: BankBalance; onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const T = (en: string, th: string) => (lang === 'th' ? th : en);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(dayKey(new Date()));
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);   // one key per form: pressing Save twice records it once
  const n = Number(amount.replace(/,/g, ''));
  const save = async () => {
    if (busy) return;
    if (!(n > 0)) { toast('error', T('Enter an amount greater than zero', 'ใส่จำนวนเงินมากกว่าศูนย์')); return; }
    if (kind === 'adjust' && note.trim().length < 10) { toast('error', T('Write the reason (at least 10 characters)', 'ใส่เหตุผลอย่างน้อย 10 ตัวอักษร')); return; }
    setBusy(true);
    try {
      if (kind === 'opening') await bankBooks.opening(bank.id, n, date, note);
      else await bankBooks.adjust(bank.id, dir, n, note, key);
      toast('success', T('Saved', 'บันทึกแล้ว'));
      onDone();
    } catch (e) { const m = (e as Error).message; toast('error', m === 'REASON_TOO_SHORT' ? T('Write the reason (at least 10 characters)', 'ใส่เหตุผลอย่างน้อย 10 ตัวอักษร') : m); } finally { setBusy(false); }
  };
  return (
    <Modal title={kind === 'opening' ? T(`Opening balance of ${bank.code}`, `ยอดยกมาของ ${bank.code}`) : T(`Adjust ${bank.code} to the bank statement`, `ปรับปรุงยอด ${bank.code} ให้ตรงกับรายการเดินบัญชี`)} onClose={onClose}
      footer={<><Button onClick={onClose}>{T('Cancel', 'ยกเลิก')}</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? T('Saving…', 'กำลังบันทึก…') : T('Save', 'บันทึก')}</Button></>}>
      <div className="col gap-12">
        {kind === 'opening'
          ? <div className="muted">{T('The balance shown by the bank on the day the bank book starts. It is entered once; later corrections are adjustments.', 'ยอดเงินตามธนาคาร ณ วันที่เริ่มใช้สมุดบัญชีนี้ ใส่ได้ครั้งเดียว หากต้องแก้ภายหลังให้ใช้ “ปรับปรุงยอด”')}</div>
          : <Field label={T('Direction', 'ประเภท')}><Select value={dir} onChange={(e) => setDir(e.target.value as 'in' | 'out')}><option value="in">{T('Money in (e.g. customer transfers)', 'เงินเข้า (เช่น ลูกค้าโอน)')}</option><option value="out">{T('Money out (e.g. bank fee)', 'เงินออก (เช่น ค่าธรรมเนียม)')}</option></Select></Field>}
        <Field label={T('Amount (฿)', 'จำนวนเงิน (บาท)')}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))} /></Field>
        {kind === 'opening' && <Field label={T('As of', 'ณ วันที่')}><Input type="date" value={date} max={dayKey(new Date())} onChange={(e) => setDate(e.target.value)} /></Field>}
        <Field label={kind === 'opening' ? T('Note (optional)', 'หมายเหตุ (ไม่บังคับ)') : T('Reason (required)', 'เหตุผล (จำเป็น)')}><Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

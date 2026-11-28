// "Approve & post to accounting" (อนุมัติและลงบัญชี): the one step after recording. Filter, tick many expenses (or all that can be posted in
// the filter), see a summary (count, total, payment methods, bank accounts and their balances, what cannot be posted and why), confirm,
// then read the result (posted / already posted / failed with the reason). The database does the work (expense_post_bulk): each expense
// is posted with its journal and bank movement in one transaction, and a second click, a retry or a second person can never post or
// deduct twice.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCheck, CircleAlert, Landmark, RotateCcw, Send } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { Badge, Banner, Button, Card, Empty, ErrText, Field, Input, Modal, Select } from '../ui/kit';
import { cx, dateFmt, dayKey, money } from '../lib/util';
import {
  METHOD_META, OPEN_STATUSES, bankLabel, catName, listClaims, markReviewed, needsBank, postBulk, previewPost, problemText, useT,
  type Claim, type ClaimFilters, type PayMethod, type PostPreview, type PostResult,
} from './api';
import { CatIcon, StatusBadge, useExpense } from './parts';
import { shiftDay } from './sheet';

const PAGE = 50;
const LIMIT = 500;   // the most one request may post (the database refuses more)
const newRequestId = () => { try { return crypto.randomUUID(); } catch { return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`; } };

/** Can this row be ticked? Only expenses that are not posted yet, and a transfer only when its bank account is known. */
export function rowBlock(c: Pick<Claim, 'status' | 'payment_method' | 'bank_account_id'>): 'not_open' | 'no_bank' | null {
  if (!OPEN_STATUSES.includes(c.status)) return 'not_open';
  if (needsBank(c.payment_method) && !c.bank_account_id) return 'no_bank';
  return null;
}

export function PostQueue({ refreshKey, onOpen, onChanged }: { refreshKey: number; onOpen: (id: string) => void; onChanged: () => void }) {
  const T = useT();
  const lang = useLang();
  const { categories, banks, bankById } = useExpense();
  const today = dayKey(new Date());
  const [f, setF] = useState<ClaimFilters>({ status: 'open', from: shiftDay(today, -30), to: today });
  const [rows, setRows] = useState<Claim[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PostPreview | null>(null);
  const [result, setResult] = useState<PostResult | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'post' | 'review'>('');
  const key = JSON.stringify(f);

  useEffect(() => {
    let live = true;
    setRows(null); setErr('');
    listClaims(f, 0, LIMIT).then((r) => { if (!live) return; setRows(r.rows); setTotal(r.total); setPage(0); setSel((s) => new Set([...s].filter((id) => r.rows.some((x) => x.id === id && !rowBlock(x))))); })
      .catch((e) => { if (live) { setErr((e as Error).message); setRows([]); } });
    return () => { live = false; };
  }, [key, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const eligible = useMemo(() => (rows ?? []).filter((c) => !rowBlock(c)), [rows]);
  const shown = (rows ?? []).slice(page * PAGE, page * PAGE + PAGE);
  const pageEligible = shown.filter((c) => !rowBlock(c));
  const chosen = (rows ?? []).filter((c) => sel.has(c.id));
  const chosenTotal = chosen.reduce((s, c) => Math.round((s + Number(c.amount_paid)) * 100) / 100, 0);
  const allPage = pageEligible.length > 0 && pageEligible.every((c) => sel.has(c.id));
  const set = (patch: Partial<ClaimFilters>) => setF((x) => ({ ...x, ...patch }));
  const toggle = (id: string, on: boolean) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const togglePage = (on: boolean) => setSel((s) => { const n = new Set(s); for (const c of pageEligible) { if (on) n.add(c.id); else n.delete(c.id); } return n; });
  const method = (m: PayMethod) => (lang === 'th' ? METHOD_META[m].th : METHOD_META[m].en);

  const openPreview = async () => {
    if (!sel.size || busy) return;
    setBusy('preview');
    try { setPreview(await previewPost([...sel])); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  // a second click (or a double click) while the first request is out does nothing: the state update would come too late to stop it
  const posting = useRef(false);
  const confirmPost = async () => {
    if (!preview || posting.current) return;
    posting.current = true; setBusy('post');
    try {
      const r = await postBulk(preview.items.map((x) => x.id), newRequestId());
      setPreview(null); setResult(r); setSel(new Set());
      onChanged();
    } catch (e) { toast('error', (e as Error).message); } finally { posting.current = false; setBusy(''); }
  };
  const review = async () => {
    if (!sel.size || busy) return;
    setBusy('review');
    try {
      const n = await markReviewed([...sel]);
      toast('success', T(`${n} expense(s) marked as reviewed`, `ทำเครื่องหมายตรวจแล้ว ${n} รายการ`));
      onChanged();
    } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };

  return (
    <div className="col gap-16">
      <Card title={T('Approve & post to accounting', 'อนุมัติและลงบัญชี')}
        sub={T('Recorded expenses go to the books in one step. Tick the rows (or all that can be posted), check the summary, confirm. Bank transfers and QR payments take the money off the chosen bank account at that moment.', 'รายจ่ายที่บันทึกแล้วลงบัญชีได้ในขั้นตอนเดียว เลือกรายการ (หรือเลือกทั้งหมดที่ลงบัญชีได้) ตรวจสรุป แล้วยืนยัน รายการโอนเงินและ QR จะตัดยอดบัญชีธนาคารที่เลือกทันที')}>
        <div className="pq-filters">
          <Field label={T('From', 'ตั้งแต่วันที่')}><Input type="date" value={f.from ?? ''} max={today} onChange={(e) => set({ from: e.target.value || undefined })} /></Field>
          <Field label={T('To', 'ถึงวันที่')}><Input type="date" value={f.to ?? ''} max={today} onChange={(e) => set({ to: e.target.value || undefined })} /></Field>
          <Field label={T('Status', 'สถานะ')}>
            <Select value={f.status ?? ''} onChange={(e) => set({ status: e.target.value as ClaimFilters['status'] })}>
              <option value="open">{T('Not posted yet', 'ยังไม่ลงบัญชี')}</option>
              <option value="draft">{T('Drafts', 'แบบร่าง')}</option>
              <option value="rejected">{T('Sent back', 'ส่งกลับให้แก้ไข')}</option>
              <option value="posted">{T('Posted', 'ลงบัญชีแล้ว')}</option>
              <option value="cancelled">{T('Cancelled / reversed', 'ยกเลิก / กลับรายการ')}</option>
              <option value="">{T('All', 'ทั้งหมด')}</option>
            </Select></Field>
          <Field label={T('Category', 'หมวดหมู่')}>
            <Select value={f.category ?? ''} onChange={(e) => set({ category: e.target.value || undefined })}>
              <option value="">{T('All categories', 'ทุกหมวด')}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{catName(lang, c)}</option>)}
            </Select></Field>
          <Field label={T('Paid by', 'จ่ายโดย')}>
            <Select value={f.method ?? ''} onChange={(e) => set({ method: (e.target.value || '') as PayMethod | '', bank: needsBank(e.target.value as PayMethod) ? f.bank : undefined })}>
              <option value="">{T('Any method', 'ทุกวิธี')}</option>
              {(Object.keys(METHOD_META) as PayMethod[]).map((m) => <option key={m} value={m}>{method(m)}</option>)}
            </Select></Field>
          <Field label={T('Bank account', 'บัญชีธนาคาร')}>
            <Select value={f.bank ?? ''} onChange={(e) => set({ bank: e.target.value || undefined })}>
              <option value="">{T('Any account', 'ทุกบัญชี')}</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{bankLabel(lang, b)}</option>)}
            </Select></Field>
          <Field label={T('Search', 'ค้นหา')}><Input value={f.q ?? ''} placeholder={T('Item, vendor, EXP no.', 'รายการ ร้านค้า เลขที่ EXP')} onChange={(e) => set({ q: e.target.value || undefined })} /></Field>
        </div>
      </Card>

      {err && <Banner tone="bad"><ErrText>{err}</ErrText></Banner>}
      <Card flush>
        <div className="pq-bar" role="region" aria-label={T('Selection', 'รายการที่เลือก')}>
          <span className="pq-count" aria-live="polite">
            <b data-testid="pq-selected">{T(`${sel.size} selected`, `เลือก ${sel.size} รายการ`)}</b>
            <span className="muted">{money(chosenTotal)}</span>
            {rows && eligible.length > 0 && sel.size < eligible.length && (
              <button type="button" className="exp-more" data-testid="pq-all" onClick={() => setSel(new Set(eligible.slice(0, LIMIT).map((c) => c.id)))}>
                {T(`Select all ${Math.min(eligible.length, LIMIT)} that can be posted in this filter`, `เลือกทั้งหมด ${Math.min(eligible.length, LIMIT)} รายการที่ลงบัญชีได้ในตัวกรองนี้`)}</button>)}
            {sel.size > 0 && <button type="button" className="exp-more" onClick={() => setSel(new Set())}>{T('Clear', 'ล้างที่เลือก')}</button>}
          </span>
          <span className="pq-actions">
            <Button disabled={!sel.size || !!busy} onClick={() => void review()}><CheckCheck size={15} />{' '}{busy === 'review' ? T('Saving…', 'กำลังบันทึก…') : T('Mark reviewed', 'ทำเครื่องหมายตรวจแล้ว')}</Button>
            <Button variant="primary" data-testid="pq-post" disabled={!sel.size || !!busy} onClick={() => void openPreview()}><Send size={15} />{' '}{busy === 'preview' ? T('Checking…', 'กำลังตรวจสอบ…') : T('Approve & post to accounting', 'อนุมัติและลงบัญชี')}</Button>
          </span>
        </div>
        {rows === null ? <div className="card-b"><div className="spinner" /></div> : rows.length === 0 ? <Empty title={T('Nothing here for this filter', 'ไม่มีรายการตามตัวกรองนี้')} /> : (
          <div className="table-wrap">
            <table className="t pq-table">
              <thead><tr>
                <th className="pq-ck"><input type="checkbox" aria-label={T('Select every row on this page that can be posted', 'เลือกทุกแถวในหน้านี้ที่ลงบัญชีได้')} checked={allPage} disabled={!pageEligible.length} onChange={(e) => togglePage(e.target.checked)} /></th>
                <th>{T('Date', 'วันที่')}</th><th>{T('Expense', 'รายการ')}</th><th className="hide-sm">{T('Category', 'หมวดหมู่')}</th><th>{T('Paid by', 'จ่ายโดย')}</th>
                <th className="num">{T('Amount', 'จำนวนเงิน')}</th><th>{T('Status', 'สถานะ')}</th>
              </tr></thead>
              <tbody>{shown.map((c) => {
                const block = rowBlock(c);
                const b = c.bank_account_id ? bankById[c.bank_account_id] : undefined;
                return (
                  <tr key={c.id} className={cx('clickable', sel.has(c.id) && 'pq-on')} data-testid="pq-row" onClick={() => onOpen(c.id)}>
                    <td className="pq-ck" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={T(`Select ${c.description}`, `เลือก ${c.description}`)} checked={sel.has(c.id)} disabled={!!block} onChange={(e) => toggle(c.id, e.target.checked)} /></td>
                    <td>{dateFmt(c.expense_date)}</td>
                    <td><b>{c.description}</b><div className="sub">{c.expense_no ?? T('Draft', 'แบบร่าง')}{c.created_by_name ? ` · ${c.created_by_name}` : ''}{c.sku_code ? ` · ${c.sku_code}` : ''}</div></td>
                    <td className="hide-sm"><span className="row gap-6"><CatIcon name={c.category?.icon} size={15} />{catName(lang, c.category)}</span></td>
                    <td>{method(c.payment_method)}{needsBank(c.payment_method) && <div className="sub">{b ? bankLabel(lang, b) : c.bank_account_id ? T('bank account', 'บัญชีธนาคาร') : <span className="exp-err">{T('no bank account', 'ยังไม่เลือกบัญชี')}</span>}</div>}</td>
                    <td className="num"><b>{money(Number(c.amount_paid))}</b>{Number(c.vat_amount) > 0 && <div className="sub">VAT {money(Number(c.vat_amount))}</div>}</td>
                    <td><span className="col gap-4"><StatusBadge status={c.status} />{c.reviewed_at && OPEN_STATUSES.includes(c.status) && <Badge tone="info">{T('reviewed', 'ตรวจแล้ว')}</Badge>}
                      {block === 'no_bank' && <Badge tone="bad" dot>{T('choose the bank account first', 'ต้องเลือกบัญชีธนาคารก่อน')}</Badge>}</span></td>
                  </tr>);
              })}</tbody>
            </table>
          </div>)}
        {rows && rows.length > PAGE && (
          <div className="card-b row between">
            <span className="muted">{T(`Rows ${page * PAGE + 1}–${Math.min(rows.length, page * PAGE + PAGE)} of ${rows.length}`, `แถว ${page * PAGE + 1}–${Math.min(rows.length, page * PAGE + PAGE)} จาก ${rows.length}`)}</span>
            <span className="row gap-8"><Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{T('Previous', 'ก่อนหน้า')}</Button><Button size="sm" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(page + 1)}>{T('Next', 'ถัดไป')}</Button></span>
          </div>)}
        {total > LIMIT && <div className="card-b muted">{T(`Showing the latest ${LIMIT} of ${total}. Narrow the dates or filters to see the rest.`, `แสดงล่าสุด ${LIMIT} จาก ${total} รายการ กรุณาจำกัดช่วงวันที่หรือตัวกรอง`)}</div>}
      </Card>

      {preview && <PreviewModal p={preview} busy={busy === 'post'} onCancel={() => setPreview(null)} onConfirm={() => void confirmPost()} />}
      {result && <ResultModal r={result} onClose={() => setResult(null)} onOpen={(id) => { setResult(null); onOpen(id); }} />}
    </div>
  );
}

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="row between pq-line"><span className="muted">{label}</span><span>{children}</span></div>;
}

function PreviewModal({ p, busy, onCancel, onConfirm }: { p: PostPreview; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const T = useT();
  const lang = useLang();
  const bad = p.items.filter((x) => x.problem);
  return (
    <Modal title={T('Approve & post to accounting?', 'ยืนยันอนุมัติและลงบัญชี?')} size="lg" onClose={busy ? () => undefined : onCancel}
      footer={<><Button onClick={onCancel} disabled={busy}>{T('Back', 'กลับ')}</Button>
        <Button variant="primary" data-testid="pq-confirm" disabled={busy || p.ok_count === 0} onClick={onConfirm}>{busy ? T('Posting…', 'กำลังลงบัญชี…') : T(`Approve & post ${p.ok_count} expense(s)`, `อนุมัติและลงบัญชี ${p.ok_count} รายการ`)}</Button></>}>
      <div className="col gap-16" data-testid="pq-preview">
        <div className="pq-sum">
          <div className="xs-stat"><span>{T('Will be posted', 'จะลงบัญชี')}</span><b data-testid="pq-ok-count">{p.ok_count}</b></div>
          <div className="xs-stat main"><span>{T('Total', 'ยอดรวม')}</span><b data-testid="pq-ok-total">{money(Number(p.ok_total))}</b></div>
          {bad.length > 0 && <div className="xs-stat"><span>{T('Cannot be posted', 'ลงบัญชีไม่ได้')}</span><b className="exp-err">{bad.length}</b></div>}
        </div>
        {p.by_method.length > 0 && <div><div className="lbl-s mb8">{T('Payment methods', 'วิธีจ่าย')}</div>
          {p.by_method.map((m) => <Line key={m.method} label={`${lang === 'th' ? METHOD_META[m.method].th : METHOD_META[m.method].en} (${m.n})`}>{money(Number(m.amount))}</Line>)}</div>}
        {p.by_bank.length > 0 && <div><div className="lbl-s mb8"><Landmark size={14} />{' '}{T('Bank accounts that will be charged', 'บัญชีธนาคารที่จะถูกตัดยอด')}</div>
          <table className="t compact" data-testid="pq-banks"><thead><tr><th>{T('Account', 'บัญชี')}</th><th className="num">{T('Items', 'รายการ')}</th><th className="num">{T('Out', 'ตัดออก')}</th>
            {p.by_bank.some((b) => b.balance !== null) && <><th className="num">{T('Balance now', 'ยอดคงเหลือตอนนี้')}</th><th className="num">{T('After posting', 'หลังลงบัญชี')}</th></>}</tr></thead>
            <tbody>{p.by_bank.map((b) => <tr key={b.bank_account_id}><td>{bankLabel(lang, { ...b, account_name: '' })}</td><td className="num">{b.n}</td><td className="num">−{money(Number(b.out))}</td>
              {b.balance !== null && <><td className="num">{money(Number(b.balance))}</td><td className={cx('num', Number(b.balance) - Number(b.out) < 0 && 'exp-err')}><b>{money(Math.round((Number(b.balance) - Number(b.out)) * 100) / 100)}</b></td></>}</tr>)}</tbody></table>
          {p.by_bank.some((b) => b.balance !== null && Number(b.balance) - Number(b.out) < 0) && <div className="muted mt8">{T('A balance below zero usually means the opening balance of that account has not been entered yet (Bank accounts tab).', 'ยอดติดลบมักหมายถึงยังไม่ได้ใส่ยอดยกมาของบัญชีนั้น (แท็บบัญชีธนาคาร)')}</div>}
        </div>}
        {bad.length > 0 && <Banner tone="warn"><b><CircleAlert size={14} />{' '}{T('These will NOT be posted:', 'รายการต่อไปนี้จะไม่ถูกลงบัญชี:')}</b>
          <ul className="exp-list">{bad.map((x) => <li key={x.id}>{x.expense_no ?? T('Draft', 'แบบร่าง')} · {x.description} · {money(Number(x.amount_paid))} — <b>{problemText(lang, x.problem)}</b></li>)}</ul></Banner>}
        {p.missing > 0 && <div className="muted">{T(`${p.missing} selected row(s) are no longer visible to you and were left out.`, `มี ${p.missing} รายการที่คุณไม่เห็นแล้ว จึงไม่ถูกรวม`)}</div>}
        <div className="muted">{T('Each expense is posted with its journal and bank movement together, once only. Nothing is deleted later: a mistake is fixed by reversing the expense.', 'แต่ละรายการจะลงบัญชีพร้อมรายการตัดบัญชีธนาคารในคราวเดียว และลงได้เพียงครั้งเดียว ภายหลังจะไม่มีการลบ หากผิดพลาดให้กลับรายการ')}</div>
      </div>
    </Modal>
  );
}

function ResultModal({ r, onClose, onOpen }: { r: PostResult; onClose: () => void; onOpen: (id: string) => void }) {
  const T = useT();
  const lang = useLang();
  return (
    <Modal title={T('Result', 'ผลการลงบัญชี')} size="lg" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{T('Done', 'เสร็จสิ้น')}</Button>}>
      <div className="col gap-16" data-testid="pq-result">
        <div className="pq-sum">
          <div className="xs-stat main"><span>{T('Posted', 'ลงบัญชีสำเร็จ')}</span><b data-testid="pq-res-posted">{r.posted.length}</b></div>
          <div className="xs-stat"><span>{T('Amount posted', 'ยอดที่ลงบัญชี')}</span><b>{money(Number(r.total_posted))}</b></div>
          {r.skipped.length > 0 && <div className="xs-stat"><span>{T('Already posted', 'ลงบัญชีไว้แล้ว')}</span><b>{r.skipped.length}</b></div>}
          <div className="xs-stat"><span>{T('Failed', 'ไม่สำเร็จ')}</span><b className={r.failed.length ? 'exp-err' : ''} data-testid="pq-res-failed">{r.failed.length}</b></div>
        </div>
        {r.posted.length > 0 && <table className="t compact"><thead><tr><th>{T('Expense', 'รายการ')}</th><th className="num">{T('Amount', 'จำนวนเงิน')}</th><th>{T('Bank movement', 'รายการธนาคาร')}</th></tr></thead>
          <tbody>{r.posted.map((x) => <tr key={x.id} className="clickable" onClick={() => onOpen(x.id)}><td><b>{x.expense_no}</b> {x.description}</td><td className="num">{money(Number(x.amount))}</td>
            <td>{x.bank_txn_no ? <>{x.bank_txn_no} · −{money(Number(x.bank_out))}{x.bank_balance_after != null && <span className="muted"> · {T('balance', 'คงเหลือ')} {money(Number(x.bank_balance_after))}</span>}</> : <span className="muted">—</span>}</td></tr>)}</tbody></table>}
        {r.skipped.length > 0 && <div className="muted">{T('Already posted before (nothing was done again):', 'ลงบัญชีไว้ก่อนแล้ว (ไม่ได้ทำซ้ำ):')} {r.skipped.map((x) => x.expense_no).join(', ')}</div>}
        {r.failed.length > 0 && <Banner tone="bad"><b><RotateCcw size={14} />{' '}{T('Not posted — fix and try again:', 'ยังไม่ลงบัญชี แก้ไขแล้วลองใหม่:')}</b>
          <ul className="exp-list">{r.failed.map((x) => <li key={x.id}><button type="button" className="exp-more" onClick={() => onOpen(x.id)}>{x.expense_no ?? T('Draft', 'แบบร่าง')} · {x.description}</button> {x.amount != null && `· ${money(Number(x.amount))}`} — <b>{problemText(lang, x.reason)}</b></li>)}</ul></Banner>}
      </div>
    </Modal>
  );
}

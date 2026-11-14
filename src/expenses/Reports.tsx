// Expense reports for the accounting device. Every figure is computed from posted journals; the other financial statements
// (profit & loss, trial balance, balance sheet, cash flow, general ledger) are in Accounting and include these expenses.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { toast, useDB, useLang } from '../domain/store';
import { byAccount, byCategory, dailySummary, expenseRows, monthlyComparison, reconcileClaims, totalsOf } from '../domain/expenseReports';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Kpi } from '../ui/kit';
import { dateFmt, dayKey, money, money0 } from '../lib/util';
import { listClaims, useT, type Claim } from './api';

const monthStart = () => { const d = new Date(); return dayKey(new Date(d.getFullYear(), d.getMonth(), 1)); };

export function Reports() {
  const T = useT();
  const lang = useLang();
  const db = useDB();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const rows = useMemo(() => expenseRows(db, from, to), [db.journals, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = totalsOf(rows);
  const acctName = (code: string) => { const a = db.accounts.find((x) => x.code === code); return a ? (lang === 'th' ? a.nameTh : a.name) : ''; };
  const daily = dailySummary(rows);
  const cats = byCategory(rows);
  const accts = byAccount(rows);
  const months = useMemo(() => monthlyComparison(db, to, 6), [db.journals, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rec, setRec] = useState<ReturnType<typeof reconcileClaims> | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      const { rows: claims } = await listClaims({ status: 'posted', from, to }, 0, 500);
      const slim = (c: Claim) => ({ id: c.id, expense_no: c.expense_no, amount_paid: Number(c.amount_paid), wht_amount: Number(c.wht_amount), journal_no: c.journal_no, status: c.status });
      setRec(reconcileClaims(db, claims.map(slim)));
    } catch (e) { toast('error', (e as Error).message); } finally { setChecking(false); }
  };

  return (
    <div className="col gap-16">
      <Card title={T('Period', 'ช่วงเวลา')} sub={T('Reports use the ledger posting date. Reversed postings are excluded.', 'รายงานใช้วันที่ลงบัญชีในสมุดบัญชี และไม่นับรายการที่กลับรายการแล้ว')}
        actions={<div className="row wrap gap-8"><Button size="sm" onClick={() => { setFrom(dayKey(new Date())); setTo(dayKey(new Date())); }}>{T('Today', 'วันนี้')}</Button><Button size="sm" onClick={() => { setFrom(monthStart()); setTo(dayKey(new Date())); }}>{T('This month', 'เดือนนี้')}</Button></div>}>
        <div className="exp-filters"><Field label={T('From', 'ตั้งแต่วันที่')}><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field><Field label={T('To', 'ถึงวันที่')}><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field></div>
      </Card>
      <div className="grid g4">
        <Kpi label={T('Expenses recognised', 'ค่าใช้จ่ายที่รับรู้')} value={money0(t.amount)} sub={T(`${t.n} postings`, `${t.n} รายการ`)} />
        <Kpi label={T('Input VAT claimed', 'ภาษีซื้อที่ขอคืน')} value={money0(t.vat)} />
        <Kpi label={T('Cash paid out', 'เงินสดจ่ายออก')} value={money0(t.cashOut)} />
        <Kpi label={T('Bank paid out', 'เงินโอนออกจากธนาคาร')} value={money0(t.bankOut)} sub={t.wht ? T(`+ ${money0(t.wht)} withholding tax owed`, `+ ภาษีหัก ณ ที่จ่ายค้างจ่าย ${money0(t.wht)}`) : undefined} />
      </div>

      <Card flush title={T('Daily expense summary and cash outflow', 'สรุปรายจ่ายประจำวันและเงินจ่ายออก')}>
        <DataTable rows={daily} rowKey={(r) => r.date} pageSize={12} empty={<Empty title={T('No expenses posted in this period', 'ไม่มีรายจ่ายที่ลงบัญชีในช่วงนี้')} />}
          cols={[
            { key: 'd', header: T('Date', 'วันที่'), sort: (r) => r.date, render: (r) => dateFmt(r.date) }, { key: 'n', header: T('Postings', 'จำนวนรายการ'), num: true, render: (r) => r.n },
            { key: 'a', header: T('Expense', 'ค่าใช้จ่าย'), num: true, render: (r) => money(r.amount) }, { key: 'v', header: T('Input VAT', 'ภาษีซื้อ'), num: true, hideSm: true, render: (r) => money(r.vat) },
            { key: 'c', header: T('Cash out', 'เงินสดจ่าย'), num: true, render: (r) => money(r.cashOut) }, { key: 'b', header: T('Bank out', 'โอนออก'), num: true, render: (r) => money(r.bankOut) },
            { key: 'w', header: T('WHT owed', 'ภาษีหัก ณ ที่จ่าย'), num: true, hideSm: true, render: (r) => money(r.wht) },
          ]}
          footerRow={daily.length ? <tr className="total"><td>{T('Total', 'รวม')}</td><td className="num">{t.n}</td><td className="num">{money(t.amount)}</td><td className="num hide-sm">{money(t.vat)}</td><td className="num">{money(t.cashOut)}</td><td className="num">{money(t.bankOut)}</td><td className="num hide-sm">{money(t.wht)}</td></tr> : undefined} />
      </Card>

      <div className="grid g2">
        <Card flush title={T('By expense category', 'แยกตามหมวดหมู่รายจ่าย')}>
          <DataTable rows={cats} rowKey={(c) => c.key} pageSize={10} compact empty={<Empty title={T('Nothing in this period', 'ไม่มีรายการ')} />}
            cols={[{ key: 'c', header: T('Category', 'หมวดหมู่'), render: (c) => (lang === 'th' ? c.th : c.en) }, { key: 'n', header: '#', num: true, render: (c) => c.n }, { key: 'a', header: T('Amount', 'จำนวนเงิน'), num: true, render: (c) => money(c.amount) },
              { key: 'p', header: '%', num: true, hideSm: true, render: (c) => (t.amount ? `${Math.round((c.amount / t.amount) * 100)}%` : '') }]} />
        </Card>
        <Card flush title={T('By ledger account', 'แยกตามบัญชีในสมุดบัญชี')}>
          <DataTable rows={accts} rowKey={(a) => a.code} pageSize={10} compact empty={<Empty title={T('Nothing in this period', 'ไม่มีรายการ')} />}
            cols={[{ key: 'c', header: T('Account', 'บัญชี'), render: (a) => <><b>{a.code}</b> {acctName(a.code)}</> }, { key: 'a', header: T('Amount', 'จำนวนเงิน'), num: true, render: (a) => money(a.amount) }]} />
        </Card>
      </div>

      <Card flush title={T('Month by month', 'เปรียบเทียบรายเดือน')} sub={T('Last 6 months up to the end date above.', '6 เดือนล่าสุดจนถึงวันที่สิ้นสุดด้านบน')}>
        <DataTable rows={[...months].reverse()} rowKey={(m) => m.month} compact pageSize={6}
          cols={[{ key: 'm', header: T('Month', 'เดือน'), render: (m) => m.month }, { key: 'n', header: T('Postings', 'จำนวนรายการ'), num: true, render: (m) => m.n }, { key: 'a', header: T('Expense', 'ค่าใช้จ่าย'), num: true, render: (m) => money(m.amount) },
            { key: 'c', header: T('Change', 'เปลี่ยนแปลง'), num: true, render: (m) => (m.change == null ? '–' : <span className={m.change > 0 ? 'bad' : 'good'}>{m.change > 0 ? '+' : ''}{m.change}%</span>) }]} />
      </Card>

      <Card flush title={T('General ledger entries', 'รายการในบัญชีแยกประเภท')} sub={T('The transaction, approval and posting dates can all differ.', 'วันที่เกิดรายการ วันที่อนุมัติ และวันที่ลงบัญชี อาจไม่ตรงกัน')}>
        <DataTable rows={[...rows].reverse()} rowKey={(r) => r.journal.id} pageSize={10} empty={<Empty title={T('No entries', 'ไม่มีรายการ')} />}
          cols={[
            { key: 'j', header: T('Journal', 'เลขที่รายการ'), render: (r) => <><b>{r.journal.no}</b><div className="sub">{r.claimNo ?? T('old-style entry', 'รายการแบบเดิม')}</div></> },
            { key: 'm', header: T('Description', 'รายละเอียด'), render: (r) => r.vendor ?? r.journal.memo },
            { key: 't', header: T('Transaction', 'เกิดรายการ'), hideSm: true, render: (r) => dateFmt(r.transactionDate) }, { key: 'ap', header: T('Approved', 'อนุมัติ'), hideSm: true, render: (r) => (r.approvedAt ? dateFmt(r.approvedAt) : '–') },
            { key: 'po', header: T('Posted', 'ลงบัญชี'), render: (r) => dateFmt(r.postingDate) },
            { key: 'l', header: T('Debit / Credit', 'เดบิต / เครดิต'), render: (r) => <span className="sub">{r.journal.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${money(l.debit || l.credit)}`).join(' · ')}</span> },
          ]} />
      </Card>

      <Card title={T('Check against the expense workflow', 'ตรวจเทียบกับระบบอนุมัติรายจ่าย')} sub={T('Every claim marked “posted” must have exactly one matching journal in this ledger.', 'ทุกรายการที่ขึ้นสถานะ “บันทึกบัญชีแล้ว” ต้องมีรายการบัญชีที่ตรงกันในสมุดบัญชีนี้หนึ่งรายการพอดี')}
        actions={<Button size="sm" onClick={check}>{checking ? T('Checking…', 'กำลังตรวจ…') : T('Check now', 'ตรวจเดี๋ยวนี้')}</Button>}>
        {!rec ? <div className="muted">{T('Press “Check now” to compare the two sides for the period above.', 'กด “ตรวจเดี๋ยวนี้” เพื่อเทียบสองฝั่งในช่วงเวลาด้านบน')}</div> : (
          <div className="col gap-8">
            {rec.issues.length === 0 && rec.orphans.length === 0
              ? <Banner tone="good"><Check size={14} />{' '}{T(`Workflow ${money(rec.workflow)} = ledger ${money(rec.ledger)}. Nothing to fix.`, `ระบบอนุมัติ ${money(rec.workflow)} = สมุดบัญชี ${money(rec.ledger)} ไม่มีสิ่งที่ต้องแก้`)}</Banner>
              : <Banner tone="bad"><b>{T(`Workflow ${money(rec.workflow)} vs ledger ${money(rec.ledger)} (difference ${money(rec.diff)})`, `ระบบอนุมัติ ${money(rec.workflow)} เทียบสมุดบัญชี ${money(rec.ledger)} (ต่างกัน ${money(rec.diff)})`)}</b></Banner>}
            {rec.issues.map((i) => <div key={i.id + i.problem}><Badge tone="bad">{i.problem}</Badge> <b>{i.no}</b> {i.detail}</div>)}
            {rec.orphans.map((o) => <div key={o.no}><Badge tone="warn">{T('only in ledger', 'มีเฉพาะในสมุดบัญชี')}</Badge> <b>{o.no}</b> {o.claim}</div>)}
          </div>)}
      </Card>

      <div className="muted">{T('Profit & loss, trial balance, balance sheet, cash flow and the general ledger include these expenses:', 'งบกำไรขาดทุน งบทดลอง งบแสดงฐานะการเงิน งบกระแสเงินสด และบัญชีแยกประเภท รวมรายจ่ายเหล่านี้แล้ว:')} <Link to="/accounting"><b>{T('open Accounting', 'เปิดหน้าบัญชี')}</b></Link></div>
    </div>
  );
}

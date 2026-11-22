// The end-of-day slip review dashboard ("Slips to check" on Payment review). An AI reads every slip as soon as it arrives and records what it found; at the end of the day
// an authorised person compares each slip with its order, Confirms the payment against the bank record and then Posts it: only Post makes money officially received.
// The AI is a reader and a risk flagger, never the decision maker: its result is a hint (shown to staff only), nothing it says is ever ticked, filled in as a decision or
// sent for a person, and every amount a person confirms is typed (or checked) by that person. What a role may do is decided by the database; the buttons only mirror it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Play, Plus, XCircle } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { cx, money } from '../lib/util';
import { Badge, Banner, Button, Card, Check, Empty, Field, Input, Kpi, KV, Modal, Select, Switch, Textarea, Tx, useConfirm } from '../ui/kit';
import { canFinance, finance, type FinanceRole } from './api';
import RecordPayment, { type RecordTarget } from './RecordPayment';
import {
  AI_RESULT, REASON_CODES, REASON_TEXT, refOk, review, STAGE, type AiResult, type Bilingual, type PostResult, type ReviewDetail, type ReviewFilter, type ReviewItem, type ReviewPage, type ReviewSettings,
  type ReviewStage, type ReviewSummary, type SlipAnalysis,
} from './review';
import {
  amountOf, compareRows, confirmPrefill, dayText, expectedOf, fromLocalInput, hasDiscrepancy, isFutureInput, isMissingMigration, mayPost, percent, reasonValue, reviewErrorLine, reviewErrorText, SIGNAL_TEXT, SUSPICIOUS,
  summaryRange, timeText, transferredOf, UNRESOLVED, uniqueCodes, uniqueReasons,
} from './reviewUi';

const PAGE = 50;
type Filters = { stage: '' | ReviewStage; ai: '' | AiResult; suspicious: boolean; from: string; to: string; reason: string; source: '' | 'customer_slip' | 'staff_entry'; method: '' | 'transfer' | 'cash'; showAll: boolean; search: string; lineQuick: boolean };
const NO_FILTER: Filters = { stage: '', ai: '', suspicious: false, from: '', to: '', reason: '', source: '', method: '', showAll: false, search: '', lineQuick: false };
const isActive = (f: Filters) => JSON.stringify(f) !== JSON.stringify(NO_FILTER);

/** The filter the database gets. Unresolved payments are the default, so the list is small; a chosen stage, or "Show all", replaces it. */
function toFilter(f: Filters): ReviewFilter {
  const o: ReviewFilter = {};
  if (f.stage) o.stage = [f.stage]; else if (!f.showAll) o.stage = [...UNRESOLVED];
  if (f.suspicious) o.ai_result = [...SUSPICIOUS]; else if (f.ai) o.ai_result = [f.ai];
  if (f.from) o.from = f.from; if (f.to) o.to = f.to;
  if (f.reason) o.reason = f.reason; if (f.source) o.source = [f.source]; if (f.method) o.method = [f.method];
  if (f.search.trim()) o.search = f.search.trim();
  if (f.lineQuick) o.via = ['line_quick'];
  return o;
}
const newestDone = (as: SlipAnalysis[]) => as.find((a) => a.status === 'done') ?? null;     // analyses come newest first
const METHOD_LABEL = { transfer: 'Bank transfer', cash: 'Cash' } as const;
const ACTION_LABEL: Record<string, string> = {
  'evidence.confirm': 'Confirmed', 'evidence.post': 'Posted', 'evidence.reject': 'Rejected', 'evidence.request_more': 'Asked for more evidence', 'evidence.record': 'Recorded by staff', 'evidence.verify': 'Verified in one step',
  'evidence.superseded': 'Replaced by a newer slip',
};
interface Target { id: string; invoiceNo: string; amount: number; outstanding?: number; /** confirmed without a bank reference: Post may add one */ noRef?: boolean }
/** The old verify form's hint, back where the money is decided: an amount above what the invoice owes is credited to the customer's wallet. Empty when it is not above. */
const overOwed = (lang: 'en' | 'th', amount: number, outstanding: number | undefined) =>
  outstanding != null && amount > outstanding + 0.004 ? tl(lang, 'More than the invoice still owes ({n} over): the extra is credited to the customer’s wallet when the payment is posted.', { n: money(amount - outstanding) }) : '';
interface BulkRow { id: string; label: string; ok: boolean; text: string }

// ================================================================================================ the dashboard
export default function SlipReview({ role, onChanged, initialOpenId }: { role: FinanceRole; onChanged: () => void; /** a link from LINE: open this slip's detail */ initialOpenId?: string | null }) {
  const lang = useLang();
  const ask = useConfirm();
  const L = (b: Bilingual) => (lang === 'th' ? b.th : b.en);
  const canAct = canFinance(role, 'verify');
  const [settings, setSettings] = useState<ReviewSettings | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [sumToday, setSumToday] = useState(true);                              // the tiles show today (no date chosen) or the chosen range
  const [page, setPage] = useState<ReviewPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [f, setF] = useState<Filters>(NO_FILTER);
  const [box, setBox] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const [record, setRecord] = useState<RecordTarget | null>(null);
  const [busy, setBusy] = useState('');
  const [bulk, setBulk] = useState<BulkRow[] | null>(null);
  const [bulkSkipped, setBulkSkipped] = useState(0);                         // confirmed cash payments the last "Post all" left out (only a manager posts cash)
  const seq = useRef(0);
  const sumSeq = useRef(0);
  const cur = useRef({ f, offset });                                     // what is on screen right now: an action that finishes later still reloads THIS page, never the page it was started from
  cur.current = { f, offset };
  const appliedSearch = useRef('');
  const asking = useRef(false);
  const canPostRow = (i: Pick<ReviewItem, 'method'>) => mayPost(role, settings, i.method);   // per row: cash is a manager's, a transfer follows the setting

  const loadList = useCallback(async () => {
    const id = ++seq.current;                                              // a slower, older answer never overwrites a newer one
    const { f: now, offset: at } = cur.current;
    try {
      const p = await review.list(toFilter(now), PAGE, at);
      if (id === seq.current) { setPage(p); setMissing(false); }
    } catch (e) {
      if (id !== seq.current) return;
      const m = (e as Error).message;
      if (isMissingMigration(m)) setMissing(true); else toast('error', reviewErrorText(lang, e));
      setPage({ total: 0, items: [] });
    }
  }, [f, offset]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The tiles follow the date filter; with no date chosen the range is today, so Posted means "posted today". The unresolved counts ignore the range (the database does). */
  const loadSummary = useCallback(async () => {
    const id = ++sumSeq.current, r = summaryRange(cur.current.f.from, cur.current.f.to);
    try { const s = await review.summary(r.from, r.to); if (id === sumSeq.current) { setSummary(s); setSumToday(r.today); } } catch { /* the list says what is wrong */ }
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { void loadSummary(); }, [loadSummary, f.from, f.to]);
  useEffect(() => { review.settings().then((s) => setSettings(s ?? null)).catch(() => setSettings(null)); }, []);
  useEffect(() => {                                                        // typing waits 300 ms; the page goes back to the first only when the text really changed (opening the screen must not undo a Next press)
    const h = setTimeout(() => { if (appliedSearch.current === box) return; appliedSearch.current = box; setF((x) => ({ ...x, search: box })); setOffset(0); }, 300);
    return () => clearTimeout(h);
  }, [box]);
  // the last row of the last page was dealt with: the page is gone, so show the new last page instead of an empty one
  useEffect(() => { if (page && page.items.length === 0 && page.total > 0 && offset > 0) setOffset(Math.floor((page.total - 1) / PAGE) * PAGE); }, [page, offset]);
  const refresh = useCallback(async () => { await Promise.all([loadList(), loadSummary()]); onChanged(); }, [loadList, loadSummary, onChanged]);
  const set = (patch: Partial<Filters>) => { setF((x) => ({ ...x, ...patch })); setOffset(0); };
  /** A dialog asks before an action: pressing the button again (the keyboard can) while it is open or the request runs must not start a second one. */
  const once = async <T,>(dflt: T, fn: () => Promise<T>): Promise<T> => {
    if (asking.current) return dflt;
    asking.current = true;
    try { return await fn(); } finally { asking.current = false; }
  };
  /** One request at a time: every action button is off while one runs, so nothing is sent twice. */
  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    setBusy(key);
    try { return await fn(); } finally { setBusy(''); }
  };

  const toastPosted = (r: PostResult) => {
    if (r.replay) return toast('info', tl(lang, 'Already posted: nothing new was recorded'));
    toast(r.result === 'overpaid_review' ? 'info' : 'success',
      r.result === 'fully_paid' ? tl(lang, 'Posted: invoice fully paid')
        : r.result === 'partially_paid' ? tl(lang, 'Posted: partially paid, {n} left', { n: money(r.state.outstanding) })
          : r.result === 'overpaid_credited' ? tl(lang, 'Posted: invoice fully paid. {n} above the invoice was credited to the customer’s wallet', { n: money(r.credited_to_wallet ?? 0) })
            : tl(lang, 'Posted as an overpayment: decide it under Overpayments'));
  };
  /** Post one confirmed payment, after a dialog that says how much. Returns true when it is done (or was already). */
  const postOne = (g: Target): Promise<boolean> => once(false, async () => {
    const over = overOwed(lang, g.amount, g.outstanding);
    const a = await ask({ title: tl(lang, 'Post {a} to {n}?', { a: money(g.amount), n: g.invoiceNo }), body: [tl(lang, 'This makes the payment official: a receipt and a ledger entry are created. It cannot be undone, only reversed.'), over].filter(Boolean).join(' '), confirmLabel: tl(lang, 'Post Invoice'),
      ...(g.noRef ? { reason: tl(lang, 'Bank transaction reference (optional, from the bank statement)'), reasonOptional: true } : {}) });
    if (!a.ok) return false;
    const r = await run(g.id, async () => { try { const x = await review.post(g.id, undefined, g.noRef ? a.reason : undefined); toastPosted(x); return true; } catch (e) { toast('error', reviewErrorText(lang, e)); return false; } });
    if (r) await refresh();
    return !!r;
  });
  const rejectOne = (g: Target): Promise<boolean> => once(false, async () => {
    const a = await ask({ title: tl(lang, 'Reject this payment?'), body: tl(lang, 'The payment of {a} on {n} is rejected. The customer sees your reason and can send a new slip.', { a: money(g.amount), n: g.invoiceNo }), confirmLabel: tl(lang, 'Reject'), danger: true, reason: tl(lang, 'Reason (shown to the customer)') });
    if (!a.ok) return false;
    const r = await run(g.id, async () => { try { await review.reject(g.id, a.reason); toast('success', tl(lang, 'Rejected')); return true; } catch (e) { toast('error', reviewErrorText(lang, e)); return false; } });
    if (r) await refresh();
    return !!r;
  });

  const items = page?.items ?? [];
  const confirmedRows = items.filter((i) => i.status === 'confirmed');
  const postable = confirmedRows.filter(canPostRow);                                          // what this person may post
  const skippedCash = confirmedRows.filter((i) => i.method === 'cash' && !canPostRow(i)).length;   // cash they may not: left for a manager, and said so
  const SKIPPED = '{n} confirmed cash payments are not included: only a manager can post cash.';
  const postAll = () => once(undefined, async () => {
    const rows = postable; if (!rows.length) return;
    const total = rows.reduce((s, i) => s + amountOf(i), 0);
    const a = await ask({ title: tl(lang, 'Post {n} confirmed payments?', { n: rows.length }), body: [tl(lang, '{a} in total will be recorded as received money: receipts and ledger entries are created. This cannot be undone, only reversed.', { a: money(total) }), skippedCash > 0 ? tl(lang, SKIPPED, { n: skippedCash }) : ''].filter(Boolean).join(' '), confirmLabel: tl(lang, 'Post all confirmed') });
    if (!a.ok) return;
    await run('bulk', async () => {
      const out: BulkRow[] = []; setBulk([]); setBulkSkipped(skippedCash);
      for (const i of rows) {                                               // one after the other, each answered on its own: one refusal does not stop the rest
        const label = `${i.order_no ?? i.invoice_no} · ${i.customer_name}`;
        try {
          const r = await review.post(i.evidence_id);
          out.push({ id: i.evidence_id, label, ok: true, text: r.replay ? tl(lang, 'Already posted') : `${r.receipt_no} · ${tl(lang, r.result === 'fully_paid' ? 'invoice fully paid' : r.result === 'partially_paid' ? 'partially paid' : 'posted')}` });
        } catch (e) { out.push({ id: i.evidence_id, label, ok: false, text: reviewErrorLine(lang, e) }); }
        setBulk([...out]);
      }
    });
    await refresh();
  });

  if (missing) return <Banner tone="warn"><Tx>The finance database part is not set up yet. An administrator needs to apply the finance migration in Supabase.</Tx></Banner>;

  const total = page?.total ?? 0;
  const tile = (id: string, label: string, value: string, sub: string, title?: string, tone?: 'bad') => <div data-kpi={id} title={title ? tl(lang, title) : undefined}><Kpi label={label} value={value} sub={sub} tone={tone} /></div>;
  const AI_TIP = 'The three AI tiles never overlap and need not add up to Awaiting: a slip that is still waiting for the AI, or was never analysed, is counted only in Awaiting.';
  const s = summary;
  const n = (v: number | undefined) => (v == null ? '—' : String(v));
  const m = (v: number | undefined) => (v == null ? '—' : money(v));

  return (
    <div className="col gap-12">
      <div className="grid g4">
        {tile('awaiting', 'Awaiting review', n(s?.awaiting.count), 'Submitted + confirmed')}
        {tile('expected', 'Expected total', m(s?.awaiting.expected_total), 'What these orders expect', 'An invoice is counted once for every awaiting slip: an invoice with two awaiting slips is counted twice.')}
        {tile('ai_read', 'Read by AI', m(s?.awaiting.ai_total), 'Total the AI read on them')}
        {tile('ai_passed', 'AI passed', n(s?.ai_verified), 'Not proof of payment', AI_TIP)}
        {tile('manual', 'Manual review', n(s?.manual_review), 'A person must check', AI_TIP)}
        {tile('suspicious', 'Suspicious', n(s?.suspicious), 'Duplicate or edited', AI_TIP, s && s.suspicious > 0 ? 'bad' : undefined)}
        {tile('confirmed', 'Confirmed', n(s?.confirmed.count), tl(lang, '{a} waiting to be posted', { a: m(s?.confirmed.amount) }))}
        {tile('posted', sumToday ? 'Posted today' : 'Posted (in range)', n(s?.posted.count), tl(lang, '{a} received', { a: m(s?.posted.amount) }))}
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <Select sm style={{ width: 'auto' }} value={f.stage} onChange={(e) => set({ stage: e.target.value as Filters['stage'] })} aria-label={tl(lang, 'Stage')}>
          <option value="">{tl(lang, 'Unresolved payments')}</option>{(Object.keys(STAGE) as ReviewStage[]).map((k) => <option key={k} value={k}>{L(STAGE[k])}</option>)}
        </Select>
        <Select sm style={{ width: 'auto' }} value={f.ai} disabled={f.suspicious} onChange={(e) => set({ ai: e.target.value as Filters['ai'] })} aria-label={tl(lang, 'AI result')}>
          <option value="">{tl(lang, 'All AI results')}</option>{(Object.keys(AI_RESULT) as AiResult[]).map((k) => <option key={k} value={k}>{L(AI_RESULT[k])}</option>)}
        </Select>
        <button type="button" className="chip sr-chip" aria-pressed={f.suspicious} onClick={() => set({ suspicious: !f.suspicious })}>{tl(lang, 'Suspicious')}{s ? ` (${s.suspicious})` : ''}</button>
        <button type="button" className="chip sr-chip" aria-pressed={f.lineQuick} onClick={() => set({ lineQuick: !f.lineQuick })}>{tl(lang, 'LINE quick approvals')}</button>
        <Input sm type="date" style={{ width: 'auto' }} value={f.from} onChange={(e) => set({ from: e.target.value })} aria-label={tl(lang, 'From date')} />
        <Input sm type="date" style={{ width: 'auto' }} value={f.to} onChange={(e) => set({ to: e.target.value })} aria-label={tl(lang, 'To date')} />
        <Select sm style={{ width: 'auto', maxWidth: 200 }} value={f.reason} onChange={(e) => set({ reason: e.target.value })} aria-label={tl(lang, 'Reason')}>
          <option value="">{tl(lang, 'Any reason')}</option>{REASON_CODES.map((c) => <option key={c} value={c}>{L(REASON_TEXT(c))}</option>)}
        </Select>
        <Select sm style={{ width: 'auto' }} value={f.source} onChange={(e) => set({ source: e.target.value as Filters['source'] })} aria-label={tl(lang, 'Source')}>
          <option value="">{tl(lang, 'Any source')}</option><option value="customer_slip">{tl(lang, 'Customer slip')}</option><option value="staff_entry">{tl(lang, 'Recorded by staff')}</option>
        </Select>
        <Select sm style={{ width: 'auto' }} value={f.method} onChange={(e) => set({ method: e.target.value as Filters['method'] })} aria-label={tl(lang, 'Method')}>
          <option value="">{tl(lang, 'Any method')}</option><option value="transfer">{tl(lang, 'Bank transfer')}</option><option value="cash">{tl(lang, 'Cash')}</option>
        </Select>
        <Input sm style={{ width: 'auto', minWidth: 220 }} value={box} onChange={(e) => setBox(e.target.value)} aria-label={tl(lang, 'Search')} placeholder={tl(lang, 'Order, invoice, customer or bank reference')} />
      </div>
      <div className="row wrap between" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <Check checked={f.showAll} onChange={(v) => set({ showAll: v })}>Show all (including posted and rejected)</Check>
          {isActive(f) && <Button size="sm" variant="ghost" onClick={() => { setF(NO_FILTER); setBox(''); setOffset(0); }}><Tx>Clear filters</Tx></Button>}
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {skippedCash > 0 && <span className="muted" style={{ fontSize: 12.5 }} data-note="cash-skipped">{tl(lang, SKIPPED, { n: skippedCash })}</span>}
          {postable.length > 0 && <Button variant="primary" size="sm" disabled={!!busy} loading={busy === 'bulk'} onClick={postAll}><CheckCircle2 size={14} /> {tl(lang, 'Post all confirmed ({n})', { n: postable.length })}</Button>}
        </div>
      </div>

      {bulk && (
        <div className="dev-item" data-bulk-results role="status">
          <div className="row between"><b><Tx>Result of posting the confirmed payments</Tx></b>{busy !== 'bulk' && <Button size="sm" variant="ghost" onClick={() => setBulk(null)}><Tx>Dismiss</Tx></Button>}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {bulk.map((r) => <li key={r.id} data-ok={r.ok}>{r.ok ? <CheckCircle2 size={13} className="good" aria-hidden /> : <XCircle size={13} className="bad" aria-hidden />} <b>{r.label}</b> — {r.text}</li>)}
          </ul>
          {bulkSkipped > 0 && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }} data-bulk-skipped>{tl(lang, SKIPPED, { n: bulkSkipped })}</div>}
        </div>
      )}

      {!page ? <div className="spinner" /> : !items.length ? <Empty title={isActive(f) ? 'No payments match these filters' : 'Nothing is waiting for review'} hint={isActive(f) ? 'Try removing a filter.' : 'New slips and payments recorded by staff appear here.'} /> : (
        <div>
          <div className="table-wrap" role="region" aria-label={tl(lang, 'Payments to review')} tabIndex={0}>
            <table className="t compact">
              <thead><tr>
                <th><Tx>Order</Tx></th><th><Tx>Customer</Tx></th><th><Tx>Order date</Tx></th><th className="r"><Tx>Expected</Tx></th><th className="r"><Tx>Transferred (AI)</Tx></th><th><Tx>Transaction date</Tx></th>
                <th><Tx>Transaction time</Tx></th><th><Tx>AI result</Tx></th><th className="r"><Tx>Confidence</Tx></th><th><Tx>Payment status</Tx></th><th><Tx>Action</Tx></th>
              </tr></thead>
              <tbody>
                {items.map((i) => (
                  <Row key={i.evidence_id} i={i} lang={lang} L={L} canAct={canAct} canPostNow={canPostRow(i)} busy={busy} onOpen={() => setOpenId(i.evidence_id)} onPost={() => postOne({ id: i.evidence_id, invoiceNo: i.invoice_no, amount: amountOf(i), outstanding: i.outstanding, noRef: i.method === 'transfer' && !i.confirmed_bank_ref })} />
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE && (
            <div className="pager"><span>{tl(lang, '{from}–{to} of {total}', { from: offset + 1, to: Math.min(total, offset + PAGE), total })}</span>
              <div className="row gap-6"><Button size="sm" icon aria-label={tl(lang, 'Previous page')} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹</Button><span>{Math.floor(offset / PAGE) + 1} / {Math.ceil(total / PAGE)}</span><Button size="sm" icon aria-label={tl(lang, 'Next page')} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>›</Button></div></div>
          )}
        </div>
      )}

      {role === 'manager' && settings && <SettingsCard settings={settings} onSaved={setSettings} />}

      {openId && (
        <Detail id={openId} role={role} settings={settings} busy={busy} run={run} postOne={postOne} rejectOne={rejectOne} onClose={() => setOpenId(null)} onRefresh={refresh}
          onRecord={(t) => setRecord(t)} />
      )}
      {record && <RecordPayment target={record} onClose={() => setRecord(null)} onDone={() => { setRecord(null); setOpenId(null); void refresh(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ one row of the table
function Row({ i, lang, L, canAct, canPostNow, busy, onOpen, onPost }: { i: ReviewItem; lang: 'en' | 'th'; L: (b: Bilingual) => string; canAct: boolean; canPostNow: boolean; busy: string; onOpen: () => void; onPost: () => void }) {
  const disc = hasDiscrepancy(i);
  const exp = expectedOf(i), tr = transferredOf(i);
  const amountRed = disc && tr?.from === 'ai' && exp != null && Math.abs(tr.amount - exp) > 0.004;
  const codes = uniqueCodes(i.reasons);
  const timeKnown = !!i.ai_transfer_at && /T\d{2}:\d{2}/.test(i.ai_transfer_at) && !i.reasons.includes('TIME_MISSING');
  const st = STAGE[i.stage];
  const ai = i.ai_result ? AI_RESULT[i.ai_result] : null;
  return (
    <tr className={cx(disc && 'disc')} data-discrepancy={disc ? 'true' : undefined} data-stage={i.stage}>
      <td><b>{i.order_no ?? i.invoice_no}</b><div className="sub">{i.order_no ? i.invoice_no : ''}{i.source === 'staff_entry' && <>{i.order_no ? ' · ' : ''}<Tx>Recorded by staff</Tx> · <Tx>{METHOD_LABEL[i.method]}</Tx></>}</div></td>
      <td>{i.customer_name}{i.customer_phone && <div className="sub">{i.customer_phone}</div>}</td>
      <td className="muted">{i.order_created_at ? dayText(i.order_created_at) : '—'}</td>
      <td className="num">{exp != null ? money(exp) : '—'}</td>
      <td className="num">{tr ? <span className={cx(amountRed && 'bad')} style={amountRed ? { fontWeight: 650 } : undefined}>{money(tr.amount)}{amountRed && <span aria-hidden> ≠</span>}</span> : '—'}
        {tr?.from === 'confirmed' && <div className="sub"><Tx>confirmed</Tx></div>}
        {tr?.from === 'ai' && (i.stage === 'confirmed' || i.stage === 'posted') && i.confirmed_amount != null && Math.abs(i.confirmed_amount - tr.amount) > 0.004 && <div className="sub">{tl(lang, 'confirmed {a}', { a: money(i.confirmed_amount) })}</div>}</td>
      <td className="muted">{i.ai_transfer_at ? dayText(i.ai_transfer_at) || '—' : '—'}</td>
      <td className="muted">{timeKnown ? timeText(i.ai_transfer_at) : '—'}</td>
      <td style={{ maxWidth: 250 }}>
        {i.ai_status === 'queued' || i.ai_status === 'running' ? <Badge tone="info" dot>AI check in progress</Badge>
          : i.ai_status === 'failed' ? <Badge tone="warn" dot>AI check failed</Badge>
            : ai ? <Badge tone={ai.tone} dot>{L(ai)}</Badge> : i.source === 'staff_entry' ? <span className="muted">—</span> : <span className="muted"><Tx>Not analysed</Tx></span>}
        {ai && i.ai_status === 'done' && i.ai_result === 'match' && ai.hint && <div className="sub" style={{ whiteSpace: 'normal' }}>{L(ai.hint)}</div>}
        {codes.length > 0 && i.ai_status !== 'queued' && i.ai_status !== 'running' && (
          <div className="sub" style={{ whiteSpace: 'normal' }} title={codes.map((c) => L(REASON_TEXT(c))).join('; ')}>{L(REASON_TEXT(codes[0]))}{codes.length > 1 && <> (+{codes.length - 1})</>}</div>
        )}
      </td>
      <td className="num">{i.ai_confidence != null ? percent(i.ai_confidence) : '—'}</td>
      <td><Badge tone={st.tone} dot>{L(st)}</Badge>
        {i.confirmed_via === 'line_quick' && <div className="sub"><Badge tone="info">{tl(lang, 'LINE quick approve')}</Badge></div>}
        {i.no_ref && (i.status === 'confirmed' || i.status === 'verified') && <div className="sub"><Badge tone="warn">{tl(lang, 'No bank reference')}</Badge></div>}
      </td>
      <td><div className="row gap-4" style={{ flexWrap: 'wrap' }}>
        <Button size="sm" variant={canAct && i.status !== 'confirmed' ? 'primary' : undefined} onClick={onOpen}>{canAct ? <Tx>Review</Tx> : <Tx>View</Tx>}</Button>
        {i.status === 'confirmed' && canPostNow && <Button size="sm" variant="primary" disabled={!!busy} loading={busy === i.evidence_id} onClick={onPost}><Tx>Post Invoice</Tx></Button>}
      </div></td>
    </tr>
  );
}

// ================================================================================================ the detail: the slip beside its order
interface DetailProps {
  id: string; role: FinanceRole; settings: ReviewSettings | null; busy: string; run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined>;
  postOne: (g: Target) => Promise<boolean>; rejectOne: (g: Target) => Promise<boolean>; onClose: () => void; onRefresh: () => Promise<void>; onRecord: (t: RecordTarget) => void;
}
function Detail({ id, role, settings, busy, run, postOne, rejectOne, onClose, onRefresh, onRecord }: DetailProps) {
  const lang = useLang();
  const ask = useConfirm();
  const L = (b: Bilingual) => (lang === 'th' ? b.th : b.en);
  const [d, setD] = useState<ReviewDetail | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'confirm' | 'more'>('view');
  const [intent, setIntent] = useState<'confirm' | 'post'>('confirm');
  const [form, setForm] = useState<{ amount: string; ref: string; when: string; note: string; filled: ('amount' | 'when')[]; unreadDay: string; aiRef: string }>({ amount: '', ref: '', when: '', note: '', filled: [], unreadDay: '', aiRef: '' });
  const [message, setMessage] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const asking = useRef(false);
  const canAct = canFinance(role, 'verify');

  const load = useCallback(async () => {
    try { setD(await review.detail(id)); } catch (e) { toast('error', reviewErrorText(lang, e)); onClose(); }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const path = d?.evidence.file_path ?? null;
  useEffect(() => { setUrl(null); if (path) finance.slipUrl(path).then(setUrl).catch((e: Error) => toast('error', e.message)); }, [path]);
  useEffect(() => { if (mode !== 'view') panel.current?.scrollIntoView({ block: 'nearest' }); }, [mode]);

  const done = async () => { onClose(); await onRefresh(); };
  const thenDone = (p: Promise<boolean>) => { void p.then((ok) => (ok ? done() : undefined)); };
  if (!d) return <Modal size="xl" title={tl(lang, 'Payment')} onClose={onClose}><div className="spinner" /></Modal>;

  const e = d.evidence, inv = d.invoice, o = d.order;
  const canPostNow = mayPost(role, settings, e.method);                       // this row: cash is only for a manager
  const newest = d.analyses[0] ?? null, last = newestDone(d.analyses);
  const label = o?.order_no ?? inv.invoice_no;
  const stage = STAGE[e.stage];
  const amount = e.confirmed_amount ?? last?.extracted?.amount ?? e.claimed_amount;
  const g: Target = { id: e.id, invoiceNo: inv.invoice_no, amount, outstanding: inv.outstanding, noRef: e.method === 'transfer' && !e.confirmed_bank_ref };
  const reasons = uniqueReasons(newest?.reasons);
  const info = reasons.filter((r) => r.severity === 'info'), rest = reasons.filter((r) => r.severity !== 'info');
  const cmp = compareRows(last, e.expected_amount);
  const room = Math.max(Math.round((inv.outstanding - (inv.confirmed_pending ?? 0)) * 100) / 100, 0);
  const canRunAi = canAct && settings?.ai_review_enabled === true && !!e.file_path && e.status === 'submitted' && (!newest || newest.status === 'queued' || newest.status === 'failed');
  const staffEntry = e.source === 'staff_entry';
  const statusLabel = (s: string) => (s in STAGE ? L(STAGE[s as ReviewStage]) : s === 'submitted' ? L(STAGE.slip_submitted) : s === 'verified' ? L(STAGE.posted) : s);

  const openConfirm = (how: 'confirm' | 'post') => {
    const p = confirmPrefill(last?.extracted, last?.qr?.trans_ref);        // the amount and the time the AI really read; the reference is typed from the bank record (what the AI read is a hint line)
    setForm({ amount: p.amount, ref: p.ref, when: p.when, note: '', filled: p.filled, unreadDay: p.unreadTimeDay, aiRef: p.aiRef });
    setIntent(how); setMode('confirm');
  };
  const amt = Number(form.amount);
  const amtOk = form.amount.trim() !== '' && amt > 0 && Math.abs(Math.round(amt * 100) - amt * 100) < 1e-6;
  const sentAt = fromLocalInput(form.when);                                 // what was typed is Bangkok time, sent with an explicit +07:00
  const future = isFutureInput(form.when);                                  // the database refuses more than 10 minutes ahead: say so here, before sending
  const formOk = amtOk && refOk(form.ref) && sentAt != null && !future;     // the bank reference is optional (owner's decision, 2026-11-22)
  const overHint = amtOk ? overOwed(lang, amt, inv.outstanding) : '';

  const submitConfirm = async (post: boolean) => {
    if (asking.current) return;
    asking.current = true;
    try { await submitConfirmNow(post); } finally { asking.current = false; }
  };
  const submitConfirmNow = async (post: boolean) => {
    if (!formOk) return toast('error', tl(lang, 'Enter the amount and the transfer date and time from your bank record'));
    if (e.expected_amount && Math.abs(amt - e.expected_amount) > 0.004) {
      const r = await ask({ title: tl(lang, 'The amount differs from what the order expects'), body: tl(lang, 'The order expects {e}, you entered {a}. The amount from the bank record is the one that will be recorded.', { e: money(e.expected_amount), a: money(amt) }), confirmLabel: tl(lang, 'Record bank amount') });
      if (!r.ok) return;
    }
    if (post) {
      const r = await ask({ title: tl(lang, 'Confirm and post {a} to {n}?', { a: money(amt), n: inv.invoice_no }), body: [tl(lang, 'This makes the payment official: a receipt and a ledger entry are created. It cannot be undone, only reversed.'), overHint].filter(Boolean).join(' '), confirmLabel: tl(lang, 'Post Invoice') });
      if (!r.ok) return;
    }
    const ok = await run('confirm', async () => {
      try { await review.confirm({ evidenceId: e.id, amount: amt, bankRef: form.ref.trim(), transferAt: sentAt!, note: form.note }); } catch (x) { toast('error', reviewErrorText(lang, x)); return false; }
      if (!post) { toast('success', tl(lang, 'Payment confirmed. It is not posted yet: the invoice still owes the money until it is posted.')); return true; }
      try { await review.post(e.id); toast('success', tl(lang, 'Confirmed and posted')); } catch (x) { toast('error', `${tl(lang, 'Confirmed, but not posted:')} ${reviewErrorLine(lang, x)}`); }
      return true;
    });
    if (ok) await done();
  };
  const sendMore = async () => {
    const ok = await run('more', async () => { try { await review.requestMore(e.id, message.trim()); toast('success', tl(lang, 'Asked the customer for more evidence')); return true; } catch (x) { toast('error', reviewErrorText(lang, x)); return false; } });
    if (ok) await done();
  };
  const runAi = async () => {
    await run('ai', async () => {
      try {
        try { await review.requestAnalysis(e.id); } catch (x) { if (!/ALREADY_QUEUED/.test((x as Error).message)) throw x; }   // already waiting: just run it
        const r = await review.analyze({ evidenceId: e.id });
        if (!r.ok) toast('info', tl(lang, 'The AI check is queued but could not be started now. It can be run again from here.'));
        else if (r.status === 'failed') toast('info', tl(lang, 'The AI could not read this slip. A person has to check it.'));
        else toast('success', tl(lang, 'The AI check was run'));
      } catch (x) { toast('error', reviewErrorText(lang, x)); }
      await load(); await onRefresh();
    });
  };

  const off = !!busy;
  const footer = mode === 'view' && canAct && (e.status === 'submitted' || e.status === 'confirmed' || e.status === 'more_evidence' || room > 0) ? (
    <>
      {(e.status === 'submitted' || e.status === 'confirmed' || e.status === 'more_evidence') && <Button variant="danger" disabled={off} onClick={() => thenDone(rejectOne(g))}><XCircle size={15} /> <Tx>Reject</Tx></Button>}
      {(e.status === 'submitted' || e.status === 'confirmed') && !staffEntry && <Button disabled={off} onClick={() => { setMessage(''); setMode('more'); }}><Tx>Request more evidence</Tx></Button>}
      {inv.invoice_status === 'open' && room > 0 && <Button disabled={off} onClick={() => onRecord({ invoiceId: inv.id, invoiceNo: inv.invoice_no, customer: d.customer.name, outstanding: inv.outstanding, confirmedPending: inv.confirmed_pending })}><Plus size={15} /> <Tx>Record payment</Tx></Button>}
      {e.status === 'submitted' && <Button variant={canPostNow ? undefined : 'primary'} disabled={off} onClick={() => openConfirm('confirm')}><Tx>Confirm</Tx></Button>}
      {e.status === 'submitted' && canPostNow && <Button variant="primary" disabled={off} onClick={() => openConfirm('post')}><Tx>Confirm & Post</Tx></Button>}
      {e.status === 'confirmed' && canPostNow && <Button variant="primary" disabled={off} onClick={() => thenDone(postOne(g))}><CheckCircle2 size={15} /> <Tx>Post Invoice</Tx></Button>}
    </>
  ) : undefined;

  return (
    <Modal size="xl" title={tl(lang, 'Payment · {n}', { n: label })} desc={[d.customer.name, d.customer.phone].filter(Boolean).join(' · ')} onClose={onClose} footer={footer}>
      <div className="col gap-12">
        <div className="row wrap gap-6">
          <Badge tone={stage.tone} dot>{L(stage)}</Badge><Badge><Tx>{METHOD_LABEL[e.method ?? 'transfer']}</Tx></Badge>
          {staffEntry && <Badge tone="info"><Tx>Recorded by staff</Tx></Badge>}
        </div>
        {e.status === 'more_evidence' && <Banner tone="warn">{tl(lang, 'More evidence was requested: “{m}”', { m: e.request_message ?? '' })}</Banner>}
        {e.status === 'rejected' && <Banner tone="bad">{tl(lang, 'Rejected: “{m}”', { m: e.reject_reason ?? '' })}</Banner>}
        {e.status === 'confirmed' && <Banner tone="info">{tl(lang, 'Confirmed as {a}. It is not money yet: it counts once it is posted.', { a: money(e.confirmed_amount ?? 0) })}</Banner>}
        {e.status === 'confirmed' && e.method === 'cash' && canAct && !canPostNow && <div data-note="cash-manager"><Banner tone="warn"><Tx>A cash payment is posted by a manager. Ask a manager to post it.</Tx></Banner></div>}
        {e.status === 'verified' && <Banner tone="good">{tl(lang, 'Posted {a}', { a: money(e.verified_amount ?? e.confirmed_amount ?? 0) })}{e.posted_at ? ` · ${dayText(e.posted_at)} ${timeText(e.posted_at)}` : ''}</Banner>}

        <div className="rv-split">
          <div>
            <h3 className="rv-h"><Tx>Slip</Tx></h3>
            {!e.file_path ? <div className="muted"><Tx>No slip file (recorded by staff)</Tx></div>
              : !url ? <div className="spinner" />
                : e.file_type === 'application/pdf' ? <a href={url} target="_blank" rel="noreferrer" className="row gap-4"><ExternalLink size={14} /> <Tx>Open the PDF slip</Tx></a>
                  : <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={tl(lang, 'Payment slip')} style={{ width: '100%', maxHeight: 460, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 8 }} /></a>}
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}><Tx>Customer claims</Tx>: {money(e.claimed_amount)}{e.claimed_bank && ` · ${e.claimed_bank}`}{e.claimed_ref && ` · ${e.claimed_ref}`}{e.claimed_transfer_at && ` · ${dayText(e.claimed_transfer_at)} ${timeText(e.claimed_transfer_at)}`}</div>
          </div>
          <div>
            <h3 className="rv-h"><Tx>Order</Tx></h3>
            <KV items={[
              ['Order', o?.order_no ?? '—'], ['Invoice', inv.invoice_no], ['Order date', o ? `${dayText(o.created_at)} ${timeText(o.created_at)}` : '—'],
              ['Invoice amount', money(inv.amount)], ['Paid', money(inv.paid)], ['Outstanding', money(inv.outstanding)], ['Confirmed, waiting to be posted', money(inv.confirmed_pending ?? 0)],
              ['Expected', e.expected_amount ? money(e.expected_amount) : '—'],
            ]} />
            {o && o.items.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 8 }}><table className="t compact"><tbody>
                {o.items.map((x) => <tr key={x.line_no}><td>{x.name}<div className="sub">{x.sku_code}</div></td><td className="num">× {x.qty}</td><td className="num">{money(x.line_total)}</td></tr>)}
                <tr><td colSpan={2} className="muted"><Tx>Shipping</Tx></td><td className="num">{money(o.shipping_fee)}</td></tr>
                <tr className="total"><td colSpan={2}><Tx>Total</Tx></td><td className="num">{money(o.total)}</td></tr>
              </tbody></table></div>
            )}
            {(d.other_evidence.length > 0 || d.receipts.length > 0) && (
              <div style={{ marginTop: 8 }}>
                <div className="muted" style={{ fontSize: 12 }}><Tx>Other payments on this invoice</Tx></div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {d.other_evidence.map((x) => <li key={x.id}>{statusLabel(x.status)} · {money(x.amount ?? 0)} · {dayText(x.created_at)}</li>)}
                  {d.receipts.map((r) => <li key={r.id}>{r.receipt_no} · {money(r.amount)} · {dayText(r.received_at)}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>

        {(d.analyses.length > 0 || canRunAi) && (
          <div>
            <h3 className="rv-h"><Tx>AI reading</Tx></h3>
            <Banner tone="warn"><Tx>AI result is a hint, not proof that money arrived. Check your bank record.</Tx></Banner>
            {newest && (newest.status === 'queued' || newest.status === 'running') && <div style={{ marginTop: 8 }}><Banner tone="info"><Tx>AI check in progress</Tx></Banner></div>}
            {newest?.status === 'failed' && <div style={{ marginTop: 8 }}><Banner tone="bad"><div><Tx>The AI could not read this slip. A person has to check it.</Tx>{newest.error && <div className="mono" style={{ marginTop: 2 }}>{newest.error}</div>}</div></Banner></div>}
            {newest?.status === 'done' && newest.result && (
              <div className="row wrap gap-6" style={{ marginTop: 8 }}>
                <Badge tone={AI_RESULT[newest.result].tone} dot>{L(AI_RESULT[newest.result])}</Badge>
                {newest.result === 'match' && <span className="muted">{L(AI_RESULT.match.hint!)}</span>}
                {newest.overall_confidence != null && <span className="muted"><Tx>Confidence</Tx>: {percent(newest.overall_confidence)}</span>}
              </div>
            )}
            {canRunAi && <div style={{ marginTop: 8 }}><Button size="sm" disabled={off || mode !== 'view'} loading={busy === 'ai'} onClick={runAi}><Play size={13} /> <Tx>Run AI check</Tx></Button></div>}

            {/* a resent transfer's "found" is an internal id, so only its sentence is shown */}
            {info.map((r) => <div key={r.code} style={{ marginTop: 8 }}><Banner tone="info"><div><b>{L(REASON_TEXT(r.code))}</b>{r.code !== 'RESUBMITTED_TRANSFER' && reasonValue(r, r.found) && <div className="muted">{reasonValue(r, r.found)}</div>}</div></Banner></div>)}
            {rest.length > 0 && (
              <ul aria-label={tl(lang, 'Reasons')} className="rv-list">
                {rest.map((r) => (
                  <li key={r.code}>
                    <Badge tone={r.severity === 'high' ? 'bad' : 'warn'}>{tl(lang, r.severity === 'high' ? 'Serious' : 'Please check')}</Badge> <span>{L(REASON_TEXT(r.code))}</span>
                    {(reasonValue(r, r.expected) || reasonValue(r, r.found)) && <div className="muted" style={{ fontSize: 12 }}>
                      {reasonValue(r, r.expected) && <>{tl(lang, 'Expected')}: {reasonValue(r, r.expected)}</>}{reasonValue(r, r.expected) && reasonValue(r, r.found) && ' · '}{reasonValue(r, r.found) && <>{tl(lang, 'Found')}: {reasonValue(r, r.found)}</>}
                    </div>}
                  </li>
                ))}
              </ul>
            )}
            {newest?.signals && newest.signals.length > 0 && (
              <ul aria-label={tl(lang, 'Signs of editing')} className="rv-list">
                {newest.signals.map((s, k) => <li key={k}><Badge tone={s.severity === 'high' ? 'bad' : 'warn'}>{tl(lang, s.severity === 'high' ? 'Serious' : 'Please check')}</Badge> <span>{L(SIGNAL_TEXT(s.code))}</span>{s.detail && <div className="muted" style={{ fontSize: 12 }}>{s.detail}</div>}</li>)}
              </ul>
            )}
          </div>
        )}

        {cmp.length > 0 && (
          <div>
            <h3 className="rv-h"><Tx>Slip compared with the order</Tx></h3>
            <div className="table-wrap"><table className="t compact cmp"><thead><tr><th><Tx>Field</Tx></th><th><Tx>Expected</Tx></th><th><Tx>Found on the slip</Tx></th><th className="r"><Tx>Confidence</Tx></th></tr></thead>
              <tbody>{cmp.map((c) => (
                <tr key={c.field} data-cmp={c.field} data-differs={c.differs}>
                  <td><Tx>{({ amount: 'Amount', date: 'Date', time: 'Time', receiver: 'Receiver', bank: 'Bank', reference: 'Reference' } as const)[c.field]}</Tx></td>
                  <td>{c.expected || '—'}</td>
                  <td>{c.differs ? <span className="bad" style={{ fontWeight: 650 }}>{c.found || tl(lang, 'Not read')} ≠<span className="sr-only"> {tl(lang, '(differs from what the order expects)')}</span></span> : (c.found || <span className="muted"><Tx>Not read</Tx></span>)}</td>
                  <td className="num">{c.confidence != null ? percent(c.confidence) : '—'}</td>
                </tr>))}</tbody></table></div>
          </div>
        )}

        {mode === 'confirm' && (
          <div ref={panel} className="dev-item" data-panel="confirm">
            <h3 className="rv-h" style={{ margin: 0 }}><Tx>Confirm payment</Tx></h3>
            <Banner tone="warn"><Tx>Fill these in from your bank statement or banking app, not from the slip picture alone. A slip can be faked.</Tx></Banner>
            {form.filled.length > 0 && <div className="muted" style={{ fontSize: 12 }} data-note="prefilled">{tl(lang, 'Filled in from what the AI read: {what}. Check every value against your bank record: nothing is sent until you press a button.', { what: form.filled.map((k) => tl(lang, ({ amount: 'the amount', when: 'the transfer date and time' } as const)[k])).join(', ') })}</div>}
            {form.unreadDay && <div className="muted" style={{ fontSize: 12 }} data-note="time-unread">{tl(lang, 'The AI read the date ({d}) but not the time of day. Type the time from your bank record.', { d: form.unreadDay })}</div>}
            {form.aiRef && <div className="muted" style={{ fontSize: 12 }} data-note="ai-ref">{tl(lang, 'AI read from the slip: {r} — type the reference from your bank record.', { r: form.aiRef })}</div>}
            <div className="row wrap gap-8" style={{ alignItems: 'flex-start' }}>
              <Field label="Amount received (฿)"><Input type="number" inputMode="decimal" min={0} step="0.01" value={form.amount} onChange={(x) => setForm({ ...form, amount: x.target.value })} /></Field>
              <Field label="Bank transaction reference" hint={tl(lang, 'Optional')}><Input maxLength={80} value={form.ref} onChange={(x) => setForm({ ...form, ref: x.target.value })} /></Field>
              <Field label="Transfer date and time"><Input type="datetime-local" value={form.when} onChange={(x) => setForm({ ...form, when: x.target.value })} /></Field>
            </div>
            {future && <div className="exp-err" role="status" data-note="future">{tl(lang, 'This time is in the future. Check the date and time.')}</div>}
            {overHint && <div className="muted" style={{ fontSize: 12 }} role="status" data-note="over-owed">{overHint}</div>}
            <Field label="Note (optional)"><Input maxLength={500} value={form.note} onChange={(x) => setForm({ ...form, note: x.target.value })} /></Field>
            <div className="row wrap gap-6">
              <Button variant={intent === 'post' && canPostNow ? undefined : 'primary'} disabled={off || !formOk} loading={busy === 'confirm'} onClick={() => void submitConfirm(false)}><Tx>Confirm</Tx></Button>
              {canPostNow && <Button variant={intent === 'post' ? 'primary' : undefined} disabled={off || !formOk} onClick={() => void submitConfirm(true)}><Tx>Confirm & Post</Tx></Button>}
              <Button variant="ghost" disabled={off} onClick={() => setMode('view')}><Tx>Cancel</Tx></Button>
            </div>
          </div>
        )}
        {mode === 'more' && (
          <div ref={panel} className="dev-item" data-panel="more">
            <h3 className="rv-h" style={{ margin: 0 }}><Tx>Request more evidence</Tx></h3>
            <Field label="Message to the customer" hint="The customer sees this message and can send a new slip. 3 to 300 characters.">
              <Textarea rows={3} maxLength={300} value={message} onChange={(x) => setMessage(x.target.value)} />
            </Field>
            <div className="row wrap gap-6">
              <Button variant="primary" disabled={off || message.trim().length < 3} loading={busy === 'more'} onClick={() => void sendMore()}><Tx>Send request</Tx></Button>
              <Button variant="ghost" disabled={off} onClick={() => setMode('view')}><Tx>Cancel</Tx></Button>
            </div>
          </div>
        )}

        {!canAct && <div className="muted" style={{ fontSize: 12.5 }}><Tx>Your role can view payments but not act on them.</Tx></div>}

        {d.analyses.length > 0 && (
          <div>
            <h3 className="rv-h"><Tx>Analysis history</Tx></h3>
            <div className="table-wrap"><table className="t compact" data-history><thead><tr><th>#</th><th><Tx>Status</Tx></th><th><Tx>AI result</Tx></th><th className="r"><Tx>Confidence</Tx></th><th><Tx>When</Tx></th></tr></thead>
              <tbody>{d.analyses.map((a) => (
                <tr key={a.id}><td>{a.attempt}</td><td><Tx>{({ queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed' } as const)[a.status]}</Tx>{a.error && <div className="sub">{a.error}</div>}</td>
                  <td>{a.result ? L(AI_RESULT[a.result]) : '—'}</td><td className="num">{a.overall_confidence != null ? percent(a.overall_confidence) : '—'}</td><td className="muted">{dayText(a.created_at)} {timeText(a.created_at)}</td></tr>))}</tbody></table></div>
          </div>
        )}
        {d.events.length > 0 && (
          <div>
            <h3 className="rv-h"><Tx>Activity</Tx></h3>
            <ul className="rv-list" style={{ fontSize: 13 }}>{d.events.map((v) => <li key={v.id}>{ACTION_LABEL[v.action] ? tl(lang, ACTION_LABEL[v.action]) : v.action} · {v.actor_email ?? '—'} · {dayText(v.at)} {timeText(v.at)}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ================================================================================================ the five settings (a manager)
function SettingsCard({ settings, onSaved }: { settings: ReviewSettings; onSaved: (s: ReviewSettings) => void }) {
  const lang = useLang();
  const [v, setV] = useState({ ai: settings.ai_review_enabled, mgr: settings.post_requires_manager, conf: String(settings.ai_min_confidence), before: String(settings.slip_window_before_min), after: String(settings.slip_future_tolerance_min) });
  const [busy, setBusy] = useState(false);
  const ok = v.conf.trim() !== '' && v.before.trim() !== '' && v.after.trim() !== '';
  const save = async () => {
    setBusy(true);
    try {
      const s = await review.saveSettings({ ai_review_enabled: v.ai, post_requires_manager: v.mgr, ai_min_confidence: Number(v.conf), slip_window_before_min: Number(v.before), slip_future_tolerance_min: Number(v.after) });
      onSaved(s); setV({ ai: s.ai_review_enabled, mgr: s.post_requires_manager, conf: String(s.ai_min_confidence), before: String(s.slip_window_before_min), after: String(s.slip_future_tolerance_min) });
      toast('success', tl(lang, 'Review settings saved'));
    } catch (e) { toast('error', reviewErrorText(lang, e)); } finally { setBusy(false); }
  };
  return (
    <Card className="review-settings" title="Review settings" sub="Only a manager can change these. They apply from the next slip or action.">
      <div className="col gap-8">
        <div className="row between"><span><Tx>Run the AI reader on every new slip</Tx></span><Switch checked={v.ai} onChange={(x) => setV({ ...v, ai: x })} label="Run the AI reader on every new slip" /></div>
        <div className="row between"><span><Tx>Only a manager may post</Tx></span><Switch checked={v.mgr} onChange={(x) => setV({ ...v, mgr: x })} label="Only a manager may post" /></div>
        <div className="row wrap gap-8" style={{ alignItems: 'flex-start' }}>
          <Field label="Lowest confidence for an AI pass (0 to 1)"><Input type="number" inputMode="decimal" min={0} max={1} step="0.05" value={v.conf} onChange={(e) => setV({ ...v, conf: e.target.value })} /></Field>
          <Field label="Slip may be dated this many minutes before the order"><Input type="number" inputMode="numeric" min={0} max={1440} step="1" value={v.before} onChange={(e) => setV({ ...v, before: e.target.value })} /></Field>
          <Field label="Slip may be dated this many minutes after it arrives"><Input type="number" inputMode="numeric" min={0} max={1440} step="1" value={v.after} onChange={(e) => setV({ ...v, after: e.target.value })} /></Field>
        </div>
        <div><Button variant="primary" loading={busy} disabled={busy || !ok} onClick={save}><Tx>Save settings</Tx></Button></div>
      </div>
    </Card>
  );
}

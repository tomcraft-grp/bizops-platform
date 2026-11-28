// Staff side of the receiver check and the learning loop (migration 20261128150000_slip_recipient_check.sql, guide docs/slip-recipient-check.md):
//   * ReadingVerdict: in a slip's detail, the outcome of the newest reading, who the slip pays, and a verifier's judgement of that reading (feedback).
//   * SlipInsightCard: on the Payment review page, how the check performs measured against what people established (posted after the bank check, rejected, judged),
//     the shop's recipients with the approved spellings, and the spellings PROPOSED from corrections, which only a manager can approve.
// Nothing here confirms, posts or rejects a payment.
import { useCallback, useEffect, useState } from 'react';
import { ThumbsUp, RefreshCw } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { Badge, Banner, Button, Card, Field, Input, Select, Tx, useConfirm } from '../ui/kit';
import { reviewErrorText } from './reviewUi';
import {
  DECISION, decisionOf, RECIPIENT_STATUS, slipLearning, type Bilingual, type Learning, type NameVariant, type Recipients, type SlipAnalysis, type SlipDecision,
} from './review';

const METHOD: Record<string, string> = {
  exact: 'Same name', masked: 'Same name, surname masked by the bank', variant: 'An approved spelling', variant_masked: 'An approved spelling, surname masked', account: 'The account number',
  first_name: 'First name only', distance: 'One or two letters differ', conflict: 'The name and the account number disagree',
};
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

// ================================================================================================ in a slip's detail
export function ReadingVerdict({ a, canJudge, onSaved }: { a: SlipAnalysis; canJudge: boolean; onSaved: () => void }) {
  const lang = useLang();
  const L = (b: Bilingual) => (lang === 'th' ? b.th : b.en);
  const dec = decisionOf(a);
  const rc = a.recipient ?? null;
  const [open, setOpen] = useState(false);
  const [holders, setHolders] = useState<string[] | null>(null);
  const [f, setF] = useState<{ decision: '' | SlipDecision; truth: string; printed: string; note: string }>({ decision: '', truth: '', printed: '', note: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && holders === null) slipLearning.recipients().then((r) => setHolders(r.holders.map((h) => h.holder))).catch(() => setHolders([])); }, [open, holders]);
  if (!dec) return null;
  const send = async (verdict: 'correct' | 'wrong') => {
    setBusy(true);
    try {
      await slipLearning.feedback({ analysisId: a.id, verdict, correctDecision: verdict === 'wrong' ? f.decision || null : null, recipientTruth: verdict === 'wrong' ? f.truth || null : null,
        printedName: verdict === 'wrong' ? f.printed : null, note: f.note });
      toast('success', tl(lang, 'Thank you. The judgement is recorded.')); setOpen(false); setF({ decision: '', truth: '', printed: '', note: '' }); onSaved();
    } catch (e) { toast('error', reviewErrorText(lang, e)); } finally { setBusy(false); }
  };
  const wrongOk = !!f.decision || !!f.truth || f.printed.trim().length >= 3;
  return (
    <div className="col gap-6" data-testid="reading-verdict" data-decision={dec}>
      <div className="row wrap gap-6" style={{ alignItems: 'center' }}>
        <Badge tone={DECISION[dec].tone} dot>{L(DECISION[dec])}</Badge><span className="muted" style={{ fontSize: 12.5 }}>{L(DECISION[dec].hint)}</span>
      </div>
      {rc && (
        <div className="dev-item" data-testid="recipient-check" data-status={rc.status} style={{ fontSize: 13 }}>
          <div className="row wrap gap-6" style={{ alignItems: 'center' }}>
            <b><Tx>Receiver</Tx></b><Badge tone={RECIPIENT_STATUS[rc.status].tone}>{L(RECIPIENT_STATUS[rc.status])}</Badge>
            {rc.holder && <span>{rc.holder}</span>}{rc.method && <span className="muted">· {tl(lang, METHOD[rc.method] ?? rc.method)}</span>}
          </div>
          {rc.candidates.length > 0 && (
            <ul className="rv-list" aria-label={tl(lang, 'What each reading found')} style={{ margin: '4px 0 0' }}>
              {rc.candidates.map((c, k) => (
                <li key={k}><span className="muted">{tl(lang, 'Reading {n}', { n: k + 1 })}:</span> {c.name ?? <span className="muted"><Tx>no name</Tx></span>}{c.account_hint && <span className="mono"> · {c.account_hint}</span>}
                  {' '}<Badge tone={c.verdict === 'match' ? 'info' : c.verdict === 'other' ? 'bad' : 'warn'}>{tl(lang, ({ match: 'ours', other: 'someone else', near: 'close', partial: 'first name only', conflict: 'name and number disagree', none: 'not comparable' } as const)[c.verdict])}</Badge></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {canJudge && a.status === 'done' && !open && (
        <div className="row wrap gap-6" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12.5 }}><Tx>Was this reading right?</Tx></span>
          <Button size="sm" disabled={busy} onClick={() => void send('correct')}><ThumbsUp size={13} /> <Tx>Right</Tx></Button>
          <Button size="sm" disabled={busy} onClick={() => setOpen(true)}><Tx>Wrong, correct it</Tx></Button>
        </div>
      )}
      {open && (
        <div className="dev-item" data-panel="feedback">
          <div className="muted" style={{ fontSize: 12.5 }}><Tx>Your correction is used to measure the check and to propose spellings. It changes nothing on this payment.</Tx></div>
          <div className="row wrap gap-8" style={{ alignItems: 'flex-start' }}>
            <Field label="The right outcome"><Select value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value as '' | SlipDecision })}>
              <option value="">{tl(lang, '(not the outcome)')}</option>{(Object.keys(DECISION) as SlipDecision[]).map((k) => <option key={k} value={k}>{L(DECISION[k])}</option>)}
            </Select></Field>
            <Field label="Who the slip really pays"><Select value={f.truth} onChange={(e) => setF({ ...f, truth: e.target.value })}>
              <option value="">{tl(lang, '(not the receiver)')}</option>{(holders ?? []).map((h) => <option key={h} value={h}>{h}</option>)}<option value="OTHER">{tl(lang, 'Someone else')}</option>
            </Select></Field>
            <Field label="The receiver as the slip prints it" hint={tl(lang, 'Optional')}><Input maxLength={120} value={f.printed} onChange={(e) => setF({ ...f, printed: e.target.value })} /></Field>
          </div>
          <Field label="Note (optional)"><Input maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <div className="row wrap gap-6">
            <Button size="sm" variant="primary" disabled={busy || !wrongOk} loading={busy} onClick={() => void send('wrong')}><Tx>Save correction</Tx></Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}><Tx>Cancel</Tx></Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================================================ on the Payment review page
export function SlipInsightCard({ canManage }: { canManage: boolean }) {
  const lang = useLang();
  const ask = useConfirm();
  const [days, setDays] = useState(90);
  const [rep, setRep] = useState<Learning | null | undefined>(undefined);
  const [rcp, setRcp] = useState<Recipients | null>(null);
  const [busy, setBusy] = useState('');
  const [add, setAdd] = useState<{ holder: string; variant: string; kind: NameVariant['kind'] }>({ holder: '', variant: '', kind: 'english' });
  const load = useCallback(async () => {
    const r = await slipLearning.report(days).catch(() => null); setRep(r);
    if (r) setRcp(await slipLearning.recipients().catch(() => null));
  }, [days]);
  useEffect(() => { void load(); }, [load]);
  if (rep === undefined) return null;
  if (rep === null) return null;                                    // a database without 20261128150000: nothing to show

  const approve = async (holder: string, variant: string, kind: NameVariant['kind'], source: NameVariant['source']) => {
    setBusy('add');
    try {
      const i = await slipLearning.impact(holder, variant);
      const r = await ask({ title: tl(lang, 'Approve “{v}” as a spelling of {h}?', { v: variant, h: holder }),
        body: tl(lang, 'Read on {e} slips before: {p} posted after the bank check, {x} rejected, {o} not decided. From the next reading on, a slip showing this name counts as paid to {h}. You can retire it at any time.', { e: i.evidence, p: i.posted, x: i.rejected, o: i.open, h: holder }),
        confirmLabel: tl(lang, 'Approve') });
      if (!r.ok) return;
      await slipLearning.addVariant(holder, variant, kind, undefined, source);
      toast('success', tl(lang, 'The spelling is approved')); setAdd({ holder: '', variant: '', kind: 'english' }); await load();
    } catch (e) { toast('error', reviewErrorText(lang, e)); } finally { setBusy(''); }
  };
  const retire = async (v: NameVariant) => {
    const r = await ask({ title: tl(lang, 'Retire “{v}”?', { v: v.variant }), body: tl(lang, 'Slips showing this name will be checked by a person again. Readings made before keep what they said.'), confirmLabel: tl(lang, 'Retire') });
    if (!r.ok) return;
    setBusy('retire');
    try { await slipLearning.retireVariant(v.id, 'retired by a manager'); toast('success', tl(lang, 'The spelling is retired')); await load(); }
    catch (e) { toast('error', reviewErrorText(lang, e)); } finally { setBusy(''); }
  };

  const o = rep.outcomes; const decided = o.verified_posted + o.verified_rejected + o.review_posted + o.review_rejected + o.rejected_posted + o.rejected_rejected;
  const tile = (label: string, value: string | number, tone?: string) => <div className="dev-item" style={{ minWidth: 120 }}><div className="muted" style={{ fontSize: 12 }}>{tl(lang, label)}</div><b className={tone}>{value}</b></div>;
  const proposals = rep.corrections.filter((c) => c.proposed);
  return (
    <Card className="slip-insight" title="Receiver check and accuracy" sub="Measured only against what people established: payments posted after the bank check, payments staff rejected, and staff judgements. The check never approves a payment."
      actions={<div className="row gap-6"><Select sm value={String(days)} onChange={(e) => setDays(Number(e.target.value))} aria-label={tl(lang, 'Period')}>
        {[30, 90, 365].map((d) => <option key={d} value={d}>{tl(lang, 'Last {n} days', { n: d })}</option>)}</Select>
        <Button size="sm" icon aria-label={tl(lang, 'Refresh')} onClick={() => void load()}><RefreshCw size={14} /></Button></div>}>
      <div className="col gap-12" data-testid="slip-insight">
        <div className="row wrap gap-8">
          {tile('Slips read', rep.slips)}{tile('Checks passed', rep.decisions.verified)}{tile('Review required', rep.decisions.review_required)}{tile('Failed a critical check', rep.decisions.rejected, rep.decisions.rejected ? 'bad' : '')}
          {tile('Receiver not the shop', rep.recipient.mismatch, rep.recipient.mismatch ? 'bad' : '')}{tile('Receiver unreadable', rep.recipient.unclear)}{tile('Could not be read', rep.unreadable)}{tile('Corrected by staff', rep.feedback.wrong)}
        </div>
        <div>
          <h3 className="rv-h"><Tx>Against what staff finally did</Tx></h3>
          {decided === 0 ? <div className="muted" style={{ fontSize: 13 }}><Tx>No slip read in this period has been posted or rejected yet.</Tx></div> : (
            <div className="table-wrap"><table className="t compact" data-testid="outcomes"><thead><tr><th><Tx>The check said</Tx></th><th className="r"><Tx>Posted after the bank check</Tx></th><th className="r"><Tx>Rejected by staff</Tx></th></tr></thead>
              <tbody>
                <tr><td>{lang === 'th' ? DECISION.verified.th : DECISION.verified.en}</td><td className="num good">{o.verified_posted}</td><td className={`num ${o.verified_rejected ? 'bad' : ''}`}>{o.verified_rejected}</td></tr>
                <tr><td>{lang === 'th' ? DECISION.review_required.th : DECISION.review_required.en}</td><td className="num">{o.review_posted}</td><td className="num">{o.review_rejected}</td></tr>
                <tr><td>{lang === 'th' ? DECISION.rejected.th : DECISION.rejected.en}</td><td className={`num ${o.rejected_posted ? 'bad' : ''}`}>{o.rejected_posted}</td><td className="num good">{o.rejected_rejected}</td></tr>
              </tbody></table></div>
          )}
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {tl(lang, 'Passed but rejected (the dangerous mistake): {a}. Failed but posted: {b}. Not decided yet: {c}.', { a: o.verified_rejected, b: o.rejected_posted, c: o.open })}
            {' '}{tl(lang, 'Amount read right on posted slips: {r} of {n}.', { r: rep.amount_on_posted.right, n: rep.amount_on_posted.right + rep.amount_on_posted.wrong + rep.amount_on_posted.blank })}
            {' '}{tl(lang, 'Share of passed checks that were posted: {p}.', { p: pct(o.verified_posted, o.verified_posted + o.verified_rejected) })}
          </div>
        </div>
        {rep.calibration.length > 0 && (
          <div>
            <h3 className="rv-h"><Tx>Confidence against the bank (posted slips)</Tx></h3>
            <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>Confidence</Tx></th><th className="r"><Tx>Slips</Tx></th><th className="r"><Tx>Amount right</Tx></th><th className="r"><Tx>Amount wrong</Tx></th></tr></thead>
              <tbody>{rep.calibration.map((c) => <tr key={c.band}><td className="mono">{c.band}</td><td className="num">{c.n}</td><td className="num">{c.right}</td><td className={`num ${c.wrong ? 'bad' : ''}`}>{c.wrong}</td></tr>)}</tbody></table></div>
            <div className="muted" style={{ fontSize: 12.5 }}><Tx>If a band has wrong amounts, raise the lowest confidence in Review settings. It is never changed automatically.</Tx></div>
          </div>
        )}
        {rep.weeks.length > 0 && (
          <div>
            <h3 className="rv-h"><Tx>By week</Tx></h3>
            <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>Week of</Tx></th><th className="r"><Tx>Readings</Tx></th><th className="r"><Tx>Checks passed</Tx></th><th className="r"><Tx>Review required</Tx></th><th className="r"><Tx>Failed a critical check</Tx></th></tr></thead>
              <tbody>{rep.weeks.map((w) => <tr key={w.week}><td>{w.week}</td><td className="num">{w.n}</td><td className="num">{w.verified}</td><td className="num">{w.review_required}</td><td className="num">{w.rejected}</td></tr>)}</tbody></table></div>
          </div>
        )}
        <div>
          <h3 className="rv-h"><Tx>Who may be paid</Tx></h3>
          <div className="muted" style={{ fontSize: 12.5 }}><Tx>The names of the shop’s active bank accounts and payment account, and the spellings a manager approved. Change an account name in its own settings.</Tx></div>
          {rcp && (
            <ul className="rv-list" data-testid="recipients" style={{ fontSize: 13 }}>
              {rcp.holders.map((h) => (
                <li key={h.holder}><b>{h.holder}</b> <span className="muted">· {tl(lang, '{n} accounts', { n: h.accounts })}</span>
                  {rcp.variants.filter((v) => v.status === 'active' && v.holder === h.holder).map((v) => (
                    <div key={v.id} className="row gap-6" style={{ alignItems: 'center', marginTop: 2 }}>
                      <span>“{v.variant}”</span><Badge>{tl(lang, ({ english: 'English spelling', spelling: 'Other spelling', ocr: 'What the reader reads' } as const)[v.kind])}</Badge>
                      {v.source === 'learned' && <Badge tone="info"><Tx>From corrections</Tx></Badge>}
                      {canManage && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void retire(v)}><Tx>Retire</Tx></Button>}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {canManage && rcp && (
            <div className="row wrap gap-8" style={{ alignItems: 'flex-end' }}>
              <Field label="Holder"><Select value={add.holder} onChange={(e) => setAdd({ ...add, holder: e.target.value })}><option value="">—</option>{rcp.holders.map((h) => <option key={h.holder} value={h.holder}>{h.holder}</option>)}</Select></Field>
              <Field label="Spelling on slips"><Input maxLength={120} value={add.variant} onChange={(e) => setAdd({ ...add, variant: e.target.value })} /></Field>
              <Field label="Kind"><Select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as NameVariant['kind'] })}>
                <option value="english">{tl(lang, 'English spelling')}</option><option value="spelling">{tl(lang, 'Other spelling')}</option><option value="ocr">{tl(lang, 'What the reader reads')}</option></Select></Field>
              <Button size="sm" disabled={!!busy || !add.holder || add.variant.trim().length < 4} loading={busy === 'add'} onClick={() => void approve(add.holder, add.variant.trim(), add.kind, 'manager')}><Tx>Add spelling</Tx></Button>
            </div>
          )}
        </div>
        <div>
          <h3 className="rv-h"><Tx>Proposed from staff corrections</Tx></h3>
          {rep.corrections.length === 0 ? <div className="muted" style={{ fontSize: 13 }}><Tx>No receiver has been corrected yet.</Tx></div> : (
            <div className="table-wrap"><table className="t compact" data-testid="corrections"><thead><tr><th><Tx>Read as</Tx></th><th><Tx>Really</Tx></th><th className="r"><Tx>Slips</Tx></th><th className="r"><Tx>Posted after the bank check</Tx></th><th className="r"><Tx>Rejected by staff</Tx></th><th></th></tr></thead>
              <tbody>{rep.corrections.map((c) => (
                <tr key={c.read + c.holder}><td>{c.read}</td><td>{c.holder}</td><td className="num">{c.slips}</td><td className="num">{c.posted}</td><td className={`num ${c.rejected ? 'bad' : ''}`}>{c.rejected}</td>
                  <td>{c.proposed ? (canManage ? <Button size="sm" disabled={!!busy} onClick={() => void approve(c.holder, c.read, 'ocr', 'learned')}><Tx>Approve</Tx></Button> : <Badge tone="info"><Tx>Proposed</Tx></Badge>)
                    : <span className="muted" style={{ fontSize: 12 }}><Tx>Not yet: needs two posted slips and no rejected one</Tx></span>}</td></tr>
              ))}</tbody></table></div>
          )}
          {proposals.length > 0 && !canManage && <Banner tone="info"><Tx>A manager can approve the proposed spellings.</Tx></Banner>}
        </div>
      </div>
    </Card>
  );
}

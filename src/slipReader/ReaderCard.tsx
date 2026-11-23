// Staff side of the shop's own slip reader: switch it (a manager), read every slip that waits, and measure it on slips whose real amount is already known from the bank.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, ScanLine } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { reviewErrorText } from '../finance/reviewUi';
import { review } from '../finance/review';
import { t as tl } from '../lib/i18n';
import { Banner, Button, Card, Switch, Tx } from '../ui/kit';
import { readerAvailable, stopReader } from './engine';
import { type Accuracy, isPicture, measure, ownReader, type OwnReaderStatus, readEvidence, type Tally, unread } from './store';

export function ReaderCard({ status, onStatus, onRead }: { status: OwnReaderStatus; onStatus: (s: OwnReaderStatus) => void; onRead: () => Promise<void> }) {
  const lang = useLang();
  const [busy, setBusy] = useState<'' | 'switch' | 'batch' | 'measure'>('');
  const [waiting, setWaiting] = useState<{ id: string; label: string }[] | null>(null);
  const [progress, setProgress] = useState('');
  const [done, setDone] = useState<{ read: number; failed: number } | null>(null);
  const [acc, setAcc] = useState<Accuracy | null>(null);
  const stop = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current = true; stopReader(); }; }, []);
  const count = useCallback(() => unread().then((x) => { if (alive.current) setWaiting(x); }).catch(() => undefined), []);
  useEffect(() => { if (status.enabled && status.can_read) void count(); }, [status.enabled, status.can_read, count]);

  const flip = async (on: boolean) => {
    setBusy('switch');
    try { onStatus(await ownReader.setOn(on)); toast('success', tl(lang, on ? 'The slip reader is on' : 'The slip reader is off')); } catch (e) { toast('error', reviewErrorText(lang, e)); } finally { setBusy(''); }
  };
  const flipCheckout = async (on: boolean) => {
    setBusy('switch');
    try { onStatus(await ownReader.setCheckout(on)); toast('success', tl(lang, on ? 'Customers now see the slip check before ordering' : 'Customers no longer see the slip check')); } catch (e) { toast('error', reviewErrorText(lang, e)); } finally { setBusy(''); }
  };
  const batch = async () => {
    const rows = waiting ?? []; if (!rows.length || busy) return;
    stop.current = false; setBusy('batch'); setDone(null); let read = 0, failed = 0;
    for (const [k, r] of rows.entries()) {
      if (stop.current) break;
      setProgress(`${k + 1}/${rows.length} · ${r.label}`);
      try { const d = await review.detail(r.id); if (!isPicture(d.evidence.file_type)) { failed++; continue; } await readEvidence(d.evidence); read++; } catch { failed++; }       // one that cannot be read stays for a person, the rest go on
    }
    stopReader();
    if (!alive.current) return;
    setBusy(''); setProgress(''); setDone({ read, failed }); await Promise.all([count(), onRead()]);
  };
  const runMeasure = async () => {
    if (busy) return;
    stop.current = false; setBusy('measure'); setAcc(null);
    try { const a = await measure(20, (x, n) => { if (alive.current) { setAcc(x); setProgress(`${x.slips + x.failed}/${n}`); } }, () => stop.current); if (alive.current) setAcc(a); }
    catch (e) { toast('error', reviewErrorText(lang, e)); } finally { stopReader(); if (alive.current) { setBusy(''); setProgress(''); } }
  };
  const row = (label: string, x: Tally) => <tr><td>{tl(lang, label)}</td><td className="num good">{x.right}</td><td className="num">{x.blank}</td><td className={`num ${x.wrong ? 'bad' : ''}`}>{x.wrong}</td></tr>;
  const ok = readerAvailable();
  return (
    <Card className="own-reader" title="Slip reader (no AI)" sub="Reads slips in this browser. The picture is not sent to anyone. The result is a hint: check the bank record before you confirm.">
      <div className="col gap-8" data-testid="own-reader">
        {status.can_manage && <div className="row between"><span><Tx>Use the shop’s own slip reader</Tx></span><Switch checked={status.enabled} onChange={(x) => { if (!busy) void flip(x); }} label="Use the shop’s own slip reader" /></div>}
        {status.can_manage && status.checkout !== undefined && <div className="row between" style={{ gap: 12 }}><span><Tx>Check the slip for the customer before they order</Tx><div className="muted" style={{ fontSize: 12 }}><Tx>On their own phone: shows whether the amount and the date agree. If not, they must confirm before ordering.</Tx></div></span><Switch checked={status.checkout} onChange={(x) => { if (!busy) void flipCheckout(x); }} label="Check the slip for the customer before they order" /></div>}
        {!ok && <Banner tone="warn"><Tx>This browser cannot run the slip reader. Use Chrome or Edge on a computer.</Tx></Banner>}
        {ok && status.can_read && <div className="row wrap gap-6">
          {status.enabled && <Button size="sm" variant="primary" disabled={!!busy || !waiting?.length} loading={busy === 'batch'} onClick={() => void batch()}><ScanLine size={14} /> {tl(lang, 'Read all waiting slips ({n})', { n: waiting?.length ?? 0 })}</Button>}
          <Button size="sm" disabled={!!busy} loading={busy === 'measure'} onClick={() => void runMeasure()}><Gauge size={14} /> <Tx>Measure it on posted slips</Tx></Button>
          {(busy === 'batch' || busy === 'measure') && <Button size="sm" variant="ghost" onClick={() => { stop.current = true; }}><Tx>Stop</Tx></Button>}
          {progress && <span className="muted" role="status" style={{ fontSize: 12.5 }}>{progress}</span>}
        </div>}
        {done && <div role="status" data-testid="reader-done" style={{ fontSize: 13 }}>{tl(lang, '{n} read, {f} could not be read (a person checks them)', { n: done.read, f: done.failed })}</div>}
        {acc && <div data-testid="reader-accuracy">
          <div className="muted" style={{ fontSize: 12.5 }}>{tl(lang, 'Compared with the amount and time staff recorded from the bank. Nothing is stored.')}</div>
          <div className="table-wrap"><table className="t compact"><thead><tr><th>{tl(lang, '{n} slips', { n: acc.slips })}</th><th className="r"><Tx>Read correctly</Tx></th><th className="r"><Tx>Left empty</Tx></th><th className="r"><Tx>Read wrongly</Tx></th></tr></thead>
            <tbody>{row('Amount', acc.amount)}{row('Transfer date', acc.date)}</tbody></table></div>
          <div className="muted" style={{ fontSize: 12.5 }}>{tl(lang, 'Slip QR valid: {q} · could not be opened: {f} · {s} s each', { q: acc.qr, f: acc.failed, s: acc.slips ? (acc.ms / acc.slips / 1000).toFixed(1) : '0' })}</div>
        </div>}
      </div>
    </Card>
  );
}

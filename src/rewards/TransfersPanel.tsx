// Promotions > "Point transfers": the switch and the limits of customer-to-customer points transfers, and the audit list of every transfer.
// What a role may do is enforced by the database on every call (Super Admin changes the settings and cancels a waiting transfer; any staff can read the list); the
// checks in this file only decide what is offered. Nothing is kept in this browser.
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from '../domain/store';
import { cx, dateTimeFmt } from '../lib/util';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, NumInput, Seg, Skeleton, Tx } from '../ui/kit';
import { ReasonForm } from './BoardAdmin';
import { useT } from './RuleEditor';
import { transfersAdmin, type AdminTransfer, type AdminTransferPage, type TransferSettings, type TransferStatus } from './transferApi';
import { adminError, checkLimits, limitsPatch, reasonText, STATUS_LABEL, statusTone, toDraft, type LimitsDraft, type Msg } from './transferView';

type Filter = '' | TransferStatus;
const PAGE = 50;

export default function TransfersPanel({ isSuper }: { isSuper: boolean }) {
  const { T, say } = useT();
  const [settings, setSettings] = useState<TransferSettings | null>(null);
  const [settingsErr, setSettingsErr] = useState<Msg | null>(null);
  const [draft, setDraft] = useState<LimitsDraft | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [limitErr, setLimitErr] = useState<Msg | null>(null);
  const [filter, setFilter] = useState<Filter>('');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [page, setPage] = useState<AdminTransferPage | null>(null);
  const [listErr, setListErr] = useState<Msg | null>(null);
  const [cancelFor, setCancelFor] = useState<AdminTransfer | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const seq = useRef(0);

  const loadSettings = useCallback(async () => {
    try {
      const s = await transfersAdmin.settings();
      setSettings(s); setDraft(toDraft(s)); setSettingsErr(null);
    } catch (e) { setSettingsErr(adminError(e)); }
  }, []);
  const loadList = useCallback(async () => {
    const n = ++seq.current;
    try {
      const p = await transfersAdmin.list(filter || null, search, limit, 0);
      if (n === seq.current) { setPage(p); setListErr(null); }
    } catch (e) { if (n === seq.current) setListErr(adminError(e)); }
  }, [filter, search, limit]);
  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { const h = setTimeout(() => { setSearch(typed.trim()); setLimit(PAGE); }, 350); return () => clearTimeout(h); }, [typed]);

  const save = async (patch: Parameters<typeof transfersAdmin.saveSettings>[0], done: string) => {
    setSaving(true); setLimitErr(null);
    try {
      const s = await transfersAdmin.saveSettings(patch);
      setSettings(s); setDraft(toDraft(s)); setConfirmOn(false);
      toast('success', T(done));
    } catch (e) { setLimitErr(adminError(e)); } finally { setSaving(false); }
  };
  const flip = (next: boolean) => { if (next) setConfirmOn(true); else void save({ transfers_enabled: false }, 'Switched off'); };
  const saveLimits = () => {
    if (!settings || !draft) return;
    const bad = checkLimits(draft);
    if (bad) { setLimitErr(bad); return; }
    const patch = limitsPatch(draft, settings);
    if (Object.keys(patch).length === 0) { toast('info', T('Nothing changed.')); return; }
    void save(patch, 'Limits saved');
  };
  const doCancel = async (reason: string) => {
    if (!cancelFor) return;
    setCancelBusy(true); setCancelErr(null);
    try {
      await transfersAdmin.cancel(cancelFor.id, reason);
      setCancelFor(null); toast('success', T('Transfer cancelled. The held points are free again.')); void loadList();
    } catch (e) {
      setCancelErr(say(adminError(e)));
      if (e instanceof Error && /TRANSFER_NOT_PENDING/.test(e.message)) void loadList();
    } finally { setCancelBusy(false); }
  };

  const field = (k: keyof LimitsDraft, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <NumInput value={draft ? (Number.isNaN(draft[k]) ? '' : draft[k]) : ''} min={1} step={1} disabled={!isSuper || saving} data-testid={`tr-${k}`}
        onChange={(n) => { setDraft((d) => (d ? { ...d, [k]: n } : d)); setLimitErr(null); }} />
    </Field>
  );

  return (
    <div className="col" style={{ gap: 16 }} data-testid="transfers-panel">
      <Card title="Points transfers between customers" sub="Customers send points to each other by member ID. The sender's points are held until the other customer accepts. Off = customers see nothing.">
        {!settings && !settingsErr && <Skeleton h={96} />}
        {settingsErr && (
          <div className="col" style={{ gap: 8 }}>
            <Banner tone="bad">{say(settingsErr)}</Banner>
            <div><Button size="sm" onClick={() => void loadSettings()}><RefreshCw size={14} />{' '}<Tx>Try again</Tx></Button></div>
          </div>
        )}
        {settings && draft && (
          <div className="col" style={{ gap: 14 }}>
            <div className="row top" style={{ gap: 12 }}>
              <button type="button" role="switch" aria-checked={settings.transfers_enabled} aria-label={T('Points transfers')} disabled={!isSuper || saving} data-testid="tr-switch"
                className={cx('switch', settings.transfers_enabled && 'on')} style={!isSuper ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} onClick={() => flip(!settings.transfers_enabled)}><i /></button>
              <div className="grow">
                <div className="row wrap" style={{ gap: 8 }}><b><Tx>Points transfers</Tx></b><Badge tone={settings.transfers_enabled ? 'good' : ''} dot>{settings.transfers_enabled ? 'On' : 'Off'}</Badge></div>
                {!settings.rewards_enabled && <div className="mt8"><Banner tone="warn"><Tx>The points and picks master switch above is off, so transfers stay unavailable to customers even when this switch is on.</Tx></Banner></div>}
                {confirmOn && (
                  <div className="mt8"><Banner tone="warn">
                    <div className="col" style={{ gap: 8 }}>
                      <div><Tx>Switch on for every customer? They will see "Transfer points" in their account and can send points to each other. Points move only when the other customer accepts.</Tx></div>
                      <div className="row">
                        <Button variant="primary" size="sm" disabled={saving} data-testid="tr-switch-yes" onClick={() => void save({ transfers_enabled: true }, 'Switched on')}><Tx>Yes, switch on</Tx></Button>
                        <Button size="sm" onClick={() => setConfirmOn(false)}><Tx>Cancel</Tx></Button>
                      </div>
                    </div>
                  </Banner></div>
                )}
              </div>
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
              {field('min_points', T('Smallest transfer'), T('points'))}
              {field('max_points', T('Largest transfer'), T('points, per transfer'))}
              {field('daily_max_points', T('Daily limit'), T('points one customer can send in 24 hours'))}
              {field('max_pending', T('Waiting transfers'), T('at most this many at once, per customer'))}
              {field('expire_days', T('Days to answer'), T('then it expires and the points are free again'))}
            </div>
            {limitErr && <Banner tone="bad">{say(limitErr)}</Banner>}
            <div className="row wrap" style={{ gap: 8 }}>
              {isSuper && <Button variant="primary" data-testid="tr-save" onClick={saveLimits}><Tx>Save limits</Tx></Button>}
              {!isSuper && <span className="muted" style={{ fontSize: 12.5 }}><Tx>Only a Super Admin can change these.</Tx></span>}
            </div>
          </div>
        )}
      </Card>

      <Card title="Every transfer" sub="The audit list: who sent how many points to whom, and what became of it. An accepted transfer is never undone here; adjust the points with a reason instead.">
        <div className="row wrap" style={{ gap: 10, marginBottom: 12 }}>
          <Seg<Filter> value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE); }} options={[
            { v: '', label: 'All' }, { v: 'pending', label: STATUS_LABEL.pending }, { v: 'accepted', label: STATUS_LABEL.accepted }, { v: 'rejected', label: STATUS_LABEL.rejected },
            { v: 'cancelled', label: STATUS_LABEL.cancelled }, { v: 'expired', label: STATUS_LABEL.expired }]} />
          <input className="input" style={{ maxWidth: 280 }} value={typed} placeholder={T('Transfer no. or name')} aria-label={T('Transfer no. or name')} data-testid="tr-search" onChange={(e) => setTyped(e.target.value)} />
        </div>
        {listErr && <div className="col" style={{ gap: 8 }}><Banner tone="bad">{say(listErr)}</Banner><div><Button size="sm" onClick={() => void loadList()}><RefreshCw size={14} />{' '}<Tx>Try again</Tx></Button></div></div>}
        {!page && !listErr && <Skeleton h={160} />}
        {page && (
          <>
            <DataTable rows={page.items} rowKey={(r) => r.id} pageSize={PAGE} compact
              empty={<Empty title="No transfers yet" hint="When customers send points to each other, every transfer is listed here." />}
              cols={[
                { key: 'n', header: 'Transfer', render: (r) => <><b className="mono">{r.transfer_no}</b><div className="sub">{dateTimeFmt(r.created_at)}</div></> },
                { key: 'f', header: 'From', render: (r) => <>{r.sender ?? '—'}<div className="sub mono">{r.sender_code ?? ''}</div></> },
                { key: 't', header: 'To', render: (r) => <>{r.recipient ?? '—'}<div className="sub mono">{r.recipient_code ?? ''}</div></> },
                { key: 'p', header: 'Points', num: true, render: (r) => r.points },
                { key: 's', header: 'Status', render: (r) => { const why = reasonText(r); return <><Badge tone={statusTone(r.status)} dot>{STATUS_LABEL[r.status]}</Badge>{why && <div className="sub">{say(why)}</div>}{r.decided_at && <div className="sub">{dateTimeFmt(r.decided_at)}</div>}</>; } },
                { key: 'l', header: 'Points ledger', hideSm: true, render: (r) => (r.out_ledger_id != null ? <span className="mono">#{r.out_ledger_id} → #{r.in_ledger_id}</span> : <span className="muted">—</span>) },
                { key: 'a', header: '', right: true, render: (r) => (r.status === 'pending' && isSuper ? <Button size="sm" data-testid="tr-cancel" onClick={() => { setCancelErr(null); setCancelFor(r); }}><Tx>Cancel</Tx></Button> : null) },
              ]} />
            <div className="row wrap" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 12.5 }}>{T('Showing {n} of {total}', { n: page.items.length, total: page.total })}</span>
              {page.items.length < page.total && <Button size="sm" onClick={() => setLimit((l) => l + PAGE)}><Tx>Show more</Tx></Button>}
            </div>
          </>
        )}
      </Card>

      {cancelFor && (
        <Card title={T('Cancel transfer {no}?', { no: cancelFor.transfer_no })} sub={T('{points} points from {from} to {to} are held. Cancelling frees them for {from} at once.', { points: cancelFor.points, from: cancelFor.sender ?? '—', to: cancelFor.recipient ?? '—' })}>
          <ReasonForm confirmLabel={T('Cancel transfer')} danger busy={cancelBusy} error={cancelErr} onSubmit={(r) => void doCancel(r)} onCancel={() => setCancelFor(null)} />
        </Card>
      )}
    </div>
  );
}

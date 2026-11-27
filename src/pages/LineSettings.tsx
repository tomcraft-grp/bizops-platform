// Settings → LINE notifications: connection (switch, write-only credentials, test, webhook URL), the admin group, linking the signed-in staff member's LINE,
// the linked staff, which events are sent, quick approve, reject reasons and the delivery log. Backed by the database (src/lib/lineApi.ts), unlike the rest of
// the Settings page. The server says who may edit (can_edit = SUPER_ADMIN); everyone on staff may read and link their own LINE.
import { useCallback, useEffect, useState } from 'react';
import { toast, useLang } from '../domain/store';
import { useAuth } from '../auth/AuthProvider';
import { t } from '../lib/i18n';
import { isLineMissing, line, lineErrorText, myLinks, parseReasons, validMaxAmount, validReasons, type LineEvent, type LineSettings, type OutboxEntry } from '../lib/lineApi';
import { Badge, Banner, Button, Card, Check, Field, Input, Seg, Switch, Textarea, Tx } from '../ui/kit';

const EVENTS: { k: LineEvent; label: string }[] = [
  { k: 'order_new', label: 'New order' },
  { k: 'slip_new', label: 'New or replaced slip' },
  { k: 'order_status', label: 'Order accepted or cancelled on the web' },
  { k: 'payment_issue', label: 'Payment problem (slip rejected, more evidence, AI check)' },
  { k: 'customer_notify', label: 'Tell the customer on LINE when the order is accepted or cancelled' },
  { k: 'preorder', label: 'Preorder alerts for the group (changes, cancellations, late, waiting for pickup, slot full, large order)' },
  { k: 'preorder_staff', label: 'Tell the assigned employee on LINE about their preorders' },
  { k: 'preorder_customer', label: 'Tell the customer on LINE about their preorder (confirmed, ready, reminder, changes)' },
];
const EVENT_NAME: Record<LineEvent, string> = { order_new: 'New order', slip_new: 'New slip', order_status: 'Order status', payment_issue: 'Payment problem', customer_notify: 'Customer message', preorder: 'Preorder', preorder_staff: 'Preorder (employee)', preorder_customer: 'Preorder (customer)' };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const tone = (s: OutboxEntry['status']) => (s === 'sent' ? 'good' : s === 'dead' ? 'bad' : s === 'failed' ? 'warn' : '');

export function LineSettingsCard() {
  const lang = useLang();
  const { profile } = useAuth();
  const [s, setS] = useState<LineSettings | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cred, setCred] = useState({ secret: '', token: '' });
  const [form, setForm] = useState({ events: {} as Record<LineEvent, boolean>, quick: false, max: '3000', reasons: '' });
  const [formErr, setFormErr] = useState('');
  const [code, setCode] = useState<{ kind: 'staff' | 'group'; code: string } | null>(null);
  const [testMsg, setTestMsg] = useState('');
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const [log, setLog] = useState<OutboxEntry[]>([]);

  const show = useCallback((x: LineSettings) => {
    setS(x);
    setForm({ events: { ...x.events }, quick: x.quick_approve_enabled, max: String(x.quick_approve_max_amount), reasons: x.reject_reasons.join('\n') });
  }, []);
  const loadLog = useCallback(async (f: 'all' | 'failed') => { try { setLog(await line.outbox(f)); } catch { setLog([]); } }, []);
  useEffect(() => {
    line.settings().then(show).catch((e: Error) => { if (isLineMissing(e.message)) setMissing(true); else toast('error', lineErrorText(lang, e)); });
  }, [show, lang]);
  useEffect(() => { if (s) void loadLog(filter); }, [s, filter, loadLog]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (e) { toast('error', lineErrorText(lang, e)); } finally { setBusy(false); }
  };
  const edit = !!s?.can_edit;

  if (missing) return <Card title="LINE notifications"><div data-line-settings><Banner tone="warn"><Tx>The LINE part of the database is not installed yet.</Tx></Banner></div></Card>;
  if (!s) return <Card title="LINE notifications"><div data-line-settings /></Card>;
  const mine = myLinks(s);

  const saveCred = () => run(async () => {
    await line.setCredentials({ secret: cred.secret.trim() || undefined, token: cred.token.trim() || undefined });
    setCred({ secret: '', token: '' });
    show(await line.settings());
    toast('success', 'Credentials saved');
  });
  const saveSettings = () => {
    const reasons = parseReasons(form.reasons);
    if (!validMaxAmount(form.max)) return setFormErr('Enter an amount above 0 with at most 2 decimals.');
    if (!validReasons(reasons)) return setFormErr('Give 1 to 10 reasons of at most 80 characters.');
    setFormErr('');
    void run(async () => {
      show(await line.save({ events: form.events, quick_approve_enabled: form.quick, quick_approve_max_amount: Number(form.max), reject_reasons: reasons }));
      toast('success', 'Settings saved');
    });
  };
  const credLine = (k: 'secret' | 'token') => {
    const set = k === 'secret' ? s.secret_set : s.token_set;
    const at = k === 'secret' ? s.secret_set_at : s.token_set_at;
    return <span data-cred={k}><Badge tone={set ? 'good' : 'warn'}>{set ? t(lang, 'Configured') : t(lang, 'Not set')}</Badge>{set && at ? <span className="muted"> {when(at)}</span> : null}</span>;
  };

  return (
    <Card title="LINE notifications" sub="New online orders appear as cards in your admin LINE group. Staff accept, approve or reject them from the card.">
      <div data-line-settings className="col" style={{ gap: 18, minWidth: 0 }}>
        {/* connection */}
        <section className="col" style={{ gap: 10 }}>
          <h3><Tx>Connection</Tx></h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {edit ? <Switch checked={s.enabled} label="LINE notifications on" onChange={(v) => run(async () => { show(await line.save({ enabled: v })); })} />
              : <Badge tone={s.enabled ? 'good' : ''}>{s.enabled ? 'On' : 'Off'}</Badge>}
            <span><Tx>LINE notifications on</Tx></span>
          </div>
          <div className="form-grid">
            <Field label="Channel secret" hint={<>{credLine('secret')} · <Tx>Leave empty to keep the current value</Tx></>}>
              <Input type="password" autoComplete="off" aria-label={t(lang, 'Channel secret')} disabled={!edit} value={cred.secret} onChange={(e) => setCred({ ...cred, secret: e.target.value })} />
            </Field>
            <Field label="Channel access token" hint={credLine('token')}>
              <Input type="password" autoComplete="off" aria-label={t(lang, 'Channel access token')} disabled={!edit} value={cred.token} onChange={(e) => setCred({ ...cred, token: e.target.value })} />
            </Field>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button disabled={!edit || busy || (!cred.secret.trim() && !cred.token.trim())} onClick={saveCred}><Tx>Save credentials</Tx></Button>
            <Button disabled={!edit || busy} onClick={() => run(async () => {
              const r = await line.test();
              setTestMsg(r.ok ? t(lang, 'Connected to {name}', { name: r.name ?? 'LINE' }) : t(lang, 'Connection failed: {error}', { error: r.error ?? '' }));
            })}><Tx>Test connection</Tx></Button>
            {testMsg && <span role="status">{testMsg}</span>}
          </div>
          <Field label="Webhook URL (paste it in the LINE Developers console)">
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <code style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{s.webhook_url}</code>
              <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(s.webhook_url).then(() => toast('success', 'Copied')).catch(() => undefined); }}><Tx>Copy</Tx></Button>
            </div>
          </Field>
        </section>

        {/* admin group */}
        <section className="col" style={{ gap: 8 }}>
          <h3><Tx>Admin group</Tx></h3>
          {s.group ? <div><Tx vars={{ name: s.group.name ?? 'LINE' }}>{'Bound to {name}'}</Tx></div> : <div className="muted"><Tx>No group is bound yet.</Tx></div>}
          {s.group_left_at && !s.group && <Banner tone="warn"><Tx vars={{ date: when(s.group_left_at) }}>{'The bot left the group on {date}. Bind a group again.'}</Tx></Banner>}
          {edit && <div><Button disabled={busy} onClick={() => run(async () => { const c = await line.linkCode('group'); setCode({ kind: 'group', code: c.code }); })}><Tx>Make a group code</Tx></Button></div>}
          {code?.kind === 'group' && <Banner tone="info"><Tx vars={{ code: code.code }}>{'Invite the LINE OA to your admin group, then type this code in the group within 10 minutes: {code}'}</Tx></Banner>}
        </section>

        {/* my LINE */}
        <section className="col" style={{ gap: 8 }}>
          <h3><Tx>My LINE</Tx></h3>
          <div className="muted"><Tx vars={{ name: profile?.display_name || profile?.email || '' }}>{'Signed in as {name}. Every LINE account linked here can accept orders as this staff account.'}</Tx></div>
          {mine.length ? <ul className="col" style={{ gap: 6, margin: 0, paddingLeft: 18 }} data-testid="my-links">
            {mine.map((l, i) => (
              <li key={l.line_user_id ?? i} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Tx vars={{ name: l.display_name ?? 'LINE' }}>{'Linked as {name}'}</Tx>
                <Button size="sm" disabled={busy} onClick={() => run(async () => { if (l.line_user_id) await line.unlinkAccount(l.line_user_id); else await line.unlink(); show(await line.settings()); toast('success', 'Unlinked'); })}><Tx>Unlink</Tx></Button>
              </li>
            ))}
          </ul> : <div className="muted"><Tx>Your LINE is not linked: you cannot act on cards yet.</Tx></div>}
          <div><Button disabled={busy} onClick={() => run(async () => { const c = await line.linkCode('staff'); setCode({ kind: 'staff', code: c.code }); })}><Tx>{mine.length ? 'Add another LINE account' : 'Link my LINE'}</Tx></Button></div>
          {code?.kind === 'staff' && <Banner tone="info"><Tx vars={{ code: code.code, name: profile?.display_name || profile?.email || '' }}>{'This code links a LINE account to the staff account {name}. Add the LINE OA as a friend, then send it this code in a private chat within 10 minutes: {code}'}</Tx><div className="muted"><Tx>{'Someone else should sign in with their own staff account and make their own code, so that their name appears on the orders they accept. A code never removes anybody else\'s link.'}</Tx></div></Banner>}
        </section>

        {edit && s.links && (
          <section className="col" style={{ gap: 8 }}>
            <h3><Tx>Linked staff</Tx></h3>
            {s.links.length === 0 ? <div className="muted"><Tx>Nobody has linked a LINE account yet.</Tx></div> : (
              <ul className="col" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
                {s.links.map((l) => (
                  <li key={l.line_user_id ?? l.profile_id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span>{l.name}</span>{l.line_name && <span className="muted">({l.line_name})</span>}
                    <Button size="sm" disabled={busy} onClick={() => run(async () => { if (l.line_user_id) await line.unlinkAccount(l.line_user_id); else await line.unlink(l.profile_id); show(await line.settings()); toast('success', 'Unlinked'); })}><Tx>Unlink</Tx></Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* events, quick approve, reasons */}
        <section className="col" style={{ gap: 8 }}>
          <h3><Tx>Events</Tx></h3>
          {EVENTS.filter((e) => !e.k.startsWith('preorder') || e.k in s.events).map((e) => (   // a database without the preorder migration has no such switches
            <Check key={e.k} checked={!!form.events[e.k]} onChange={(v) => edit && setForm({ ...form, events: { ...form.events, [e.k]: v } })}>{e.label}</Check>
          ))}
        </section>
        <section className="col" style={{ gap: 8 }}>
          <h3><Tx>Quick approve</Tx></h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {edit ? <Switch checked={form.quick} label='Allow "Accept + approve payment" on the card' onChange={(v) => setForm({ ...form, quick: v })} />
              : <Badge tone={form.quick ? 'good' : ''}>{form.quick ? 'On' : 'Off'}</Badge>}
            <span><Tx>{'Allow "Accept + approve payment" on the card'}</Tx></span>
          </div>
          <div className="muted"><Tx>Only for finance verifiers and managers, only up to the maximum, only when the customer gave the transfer time. The money is official only after Post at the end of the day.</Tx></div>
          <Field label="Maximum amount per order (baht)">
            <Input inputMode="decimal" aria-label={t(lang, 'Maximum amount per order (baht)')} disabled={!edit} value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} />
          </Field>
          <Field label="Reject reasons (one per line)">
            <Textarea rows={4} aria-label={t(lang, 'Reject reasons (one per line)')} disabled={!edit} value={form.reasons} onChange={(e) => setForm({ ...form, reasons: e.target.value })} />
          </Field>
          {formErr && <div role="alert" style={{ color: 'var(--crit)' }}><Tx>{formErr}</Tx></div>}
          <div><Button variant="primary" disabled={!edit || busy} onClick={saveSettings}><Tx>Save settings</Tx></Button></div>
        </section>

        {/* delivery log */}
        <section className="col" style={{ gap: 8, minWidth: 0 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <h3><Tx>Delivery log</Tx></h3>
            <Seg value={filter} onChange={setFilter} options={[{ v: 'all', label: 'All' }, { v: 'failed', label: 'Failed' }]} />
          </div>
          {log.length === 0 ? <div className="muted"><Tx>Nothing has been sent yet.</Tx></div> : (
            <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
              <table className="t">
                <thead><tr><th><Tx>Time</Tx></th><th><Tx>Event</Tx></th><th><Tx>Order</Tx></th><th><Tx>Status</Tx></th><th><Tx>Tries</Tx></th><th><Tx>Error</Tx></th><th /></tr></thead>
                <tbody>
                  {log.map((o) => (
                    <tr key={o.id}>
                      <td>{when(o.created_at)}</td>
                      <td><Tx>{EVENT_NAME[o.event] ?? o.event}</Tx></td>
                      <td>{o.order_no ?? ''}</td>
                      <td><Badge tone={tone(o.status)}>{t(lang, o.status)}</Badge></td>
                      <td>{o.attempts}</td>
                      <td style={{ overflowWrap: 'anywhere', maxWidth: 320 }}>{o.last_error ?? ''}</td>
                      <td>{['failed', 'dead', 'skipped'].includes(o.status) && (
                        <Button size="sm" disabled={busy} onClick={() => run(async () => { await line.resend(o.id); toast('success', 'Queued again'); await loadLog(filter); })}><Tx>Send again</Tx></Button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}

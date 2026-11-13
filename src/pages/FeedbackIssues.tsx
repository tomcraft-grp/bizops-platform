import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, MessageSquarePlus, RefreshCw } from 'lucide-react';
import {
  FEEDBACK_CATEGORIES, FEEDBACK_PRIORITIES, FEEDBACK_STATUSES, FeedbackCategory, FeedbackIssue, FeedbackPriority, FeedbackStatus,
  addFeedbackNote, listFeedback, setFeedbackPriority, setFeedbackStatus,
} from '../lib/feedbackApi';
import { useLang } from '../domain/store';
import { Badge, Banner, Button, Card, DataTable, Drawer, Empty, Field, KV, Kpi, PageHead, Select, Textarea, useHas, Tx } from '../ui/kit';
import { dateTimeFmt } from '../lib/util';
import { t } from '../lib/i18n';
import { useAuth } from '../auth/AuthProvider';

const STATUS_TONE: Record<FeedbackStatus, 'good' | 'warn' | 'bad' | 'info' | 'serious' | ''> = {
  new: 'info', reviewing: 'warn', in_progress: 'warn', need_info: 'serious', completed: 'good', rejected: '',
};
const PRIORITY_TONE: Record<FeedbackPriority, 'good' | 'warn' | 'bad' | 'info' | 'serious' | ''> = {
  low: '', medium: 'info', high: 'warn', critical: 'bad',
};
const statusLabel = (s: FeedbackStatus) => FEEDBACK_STATUSES.find((x) => x.v === s)?.label ?? s;
const priorityLabel = (p: FeedbackPriority) => FEEDBACK_PRIORITIES.find((x) => x.v === p)?.label ?? p;
const categoryLabel = (c: FeedbackCategory) => FEEDBACK_CATEGORIES.find((x) => x.v === c)?.label ?? c;
const CATEGORY_TONE: Record<FeedbackCategory, 'good' | 'warn' | 'bad' | 'info' | 'serious' | ''> = {
  feature_request: 'info', bug: 'bad', ui_ux: 'warn', performance: 'serious', question: '', other: '',
};

// This feedback list is centralized (a real Supabase table, not the local per-browser IndexedDB "DB"
// the rest of this prototype uses) — see src/lib/feedbackApi.ts. It polls rather than subscribing
// live, which is enough for a UAT demo; a manual refresh button covers the rest.
export default function FeedbackIssues() {
  const lang = useLang();
  const [rows, setRows] = useState<FeedbackIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listFeedback().then((r) => { setRows(r); setErr(null); }).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 10_000);
    return () => clearInterval(i);
  }, [refresh]);

  const filtered = useMemo(
    () => rows.filter((f) => (!status || f.status === status) && (!priority || f.priority === priority) && (!category || f.category === category)),
    [rows, status, priority, category],
  );
  const openCount = rows.filter((f) => f.status !== 'completed' && f.status !== 'rejected').length;
  const openIssue = rows.find((f) => f.id === openId) ?? null;

  return (
    <>
      <PageHead title="Feedback & issues" desc="Every issue, idea or requested improvement submitted from the global Feedback button, with the exact page it came from — centralized across every tester, not just this browser."
        actions={<Button onClick={refresh}><RefreshCw size={14} />{' '}<Tx>Refresh</Tx></Button>} />
      {err && <div className="mb16"><Banner tone="bad"><Tx>Could not reach the centralized feedback store:</Tx>{' '}{err}</Banner></div>}
      <div className="grid g4 mb16">
        <Kpi label="Total submitted" value={rows.length} />
        <Kpi label="Open" value={openCount} tone={openCount ? 'bad' : 'good'} />
        <Kpi label="Critical priority" value={rows.filter((f) => f.priority === 'critical' && f.status !== 'completed' && f.status !== 'rejected').length} />
        <Kpi label="Completed" value={rows.filter((f) => f.status === 'completed').length} tone="good" />
      </div>
      <Card flush>
        <DataTable
          rows={filtered} rowKey={(f) => f.id} onRow={(f) => setOpenId(f.id)}
          search={(f) => `${f.description} ${f.remark ?? ''} ${f.page_name} ${f.page_path} ${f.feature_name ?? ''} ${f.module_name ?? ''} ${f.submitter_label} ${categoryLabel(f.category)}`}
          toolbar={
            <div className="row gap-6">
              <Select sm style={{ width: 'auto' }} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">{t(lang, 'All categories')}</option>
                {FEEDBACK_CATEGORIES.map((c) => <option key={c.v} value={c.v}>{t(lang, c.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{t(lang, 'All statuses')}</option>
                {FEEDBACK_STATUSES.map((s) => <option key={s.v} value={s.v}>{t(lang, s.label)}</option>)}
              </Select>
              <Select sm style={{ width: 'auto' }} value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">{t(lang, 'All priorities')}</option>
                {FEEDBACK_PRIORITIES.map((p) => <option key={p.v} value={p.v}>{t(lang, p.label)}</option>)}
              </Select>
            </div>
          }
          empty={<Empty icon={<MessageSquarePlus size={22} />} title={loading ? 'Loading…' : 'No feedback yet'} hint="Submissions from the Feedback button on any page (any tester, any device) will show up here." />}
          cols={[
            { key: 't', header: 'Issue', render: (f) => <div><b>{f.title}</b>{f.remark && <div className="sub">{f.remark.slice(0, 80)}{f.remark.length > 80 ? '…' : ''}</div>}</div> },
            { key: 'cat', header: 'Category', render: (f) => <Badge tone={CATEGORY_TONE[f.category]}>{categoryLabel(f.category)}</Badge>, hideSm: true },
            { key: 'u', header: 'From', render: (f) => f.submitter_label, hideSm: true },
            { key: 'p', header: 'Page', render: (f) => <div>{f.page_name}<div className="sub mono">{f.page_path}</div></div>, hideSm: true },
            { key: 's', header: 'Status', render: (f) => <Badge tone={STATUS_TONE[f.status]} dot>{statusLabel(f.status)}</Badge> },
            { key: 'pr', header: 'Priority', render: (f) => <Badge tone={PRIORITY_TONE[f.priority]}>{priorityLabel(f.priority)}</Badge> },
            { key: 'c', header: 'Submitted', render: (f) => dateTimeFmt(f.created_at), sort: (f) => f.created_at, hideSm: true },
          ]}
          initialSort={{ key: 'c', dir: 'desc' }}
        />
      </Card>
      {openIssue && <IssueDrawer issue={openIssue} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}

function IssueDrawer({ issue: f, onClose, onChanged }: { issue: FeedbackIssue; onClose: () => void; onChanged: () => void }) {
  const lang = useLang();
  const nav = useNavigate();
  const { profile } = useAuth();
  const canManage = useHas('feedback:manage');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const myLabel = `${profile?.display_name || profile?.email || 'unknown'} (${profile?.role ?? '?'})`;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); onChanged(); } catch { /* list refresh/badge state is enough signal; drawer stays open */ }
    finally { setBusy(false); }
  };

  return (
    <Drawer title={f.title} sub={`Submitted by ${f.submitter_label} · ${dateTimeFmt(f.created_at)}`} onClose={onClose}>
      <div className="col gap-16">
        <div className="row wrap" style={{ gap: 8 }}>
          <Badge tone={CATEGORY_TONE[f.category]}>{categoryLabel(f.category)}</Badge>
          <Badge tone={STATUS_TONE[f.status]} dot>{statusLabel(f.status)}</Badge>
          <Badge tone={PRIORITY_TONE[f.priority]}>{t(lang, priorityLabel(f.priority))}{lang === 'th' ? '' : <Tx>{' priority'}</Tx>}</Badge>
        </div>
        <Card title="Description"><div className="text2" style={{ whiteSpace: 'pre-wrap' }}>{f.description}</div></Card>
        {f.remark && <Card title="Remark / additional notes"><div className="text2" style={{ whiteSpace: 'pre-wrap' }}>{f.remark}</div></Card>}
        <Card title="Where this happened">
          <KV items={[
            ['Page', <>{t(lang, f.page_name)} <Button size="sm" variant="ghost" onClick={() => { onClose(); nav(f.page_path); }}><ArrowUpRight size={13} /> {t(lang, 'Open page')}</Button></>],
            ['Route', <span className="mono">{f.page_path}</span>],
            ['Module', f.module_name ?? 'NOT AVAILABLE'],
            ['Feature', f.feature_name ?? 'NOT AVAILABLE'],
            ['Function identifier', f.function_identifier ?? 'NOT AVAILABLE'],
            ['Full URL', <span className="mono" style={{ wordBreak: 'break-all' }}>{f.page_url}</span>],
          ]} />
        </Card>
        <Card title="Context captured automatically">
          <KV items={[
            ['Environment', f.environment],
            ['Browser', <span style={{ wordBreak: 'break-all' }}>{f.browser_info}</span>],
            ['Device / viewport', f.device_info],
            ['Last updated', dateTimeFmt(f.updated_at)],
            ['Resolved at', f.resolved_at ? dateTimeFmt(f.resolved_at) : '–'],
          ]} />
        </Card>
        <Card title="Update">
          <div className="form-grid">
            <Field label="Status">
              <Select disabled={!canManage || busy} value={f.status} onChange={(e) => run(() => setFeedbackStatus(f.id, e.target.value as FeedbackStatus))}>
                {FEEDBACK_STATUSES.map((s) => <option key={s.v} value={s.v}>{t(lang, s.label)}</option>)}
              </Select>
            </Field>
            <Field label="Priority">
              <Select disabled={!canManage || busy} value={f.priority} onChange={(e) => run(() => setFeedbackPriority(f.id, e.target.value as FeedbackPriority))}>
                {FEEDBACK_PRIORITIES.map((p) => <option key={p.v} value={p.v}>{t(lang, p.label)}</option>)}
              </Select>
            </Field>
          </div>
          {!canManage && <div className="muted mt8" style={{ fontSize: 12 }}>{t(lang, 'Your role cannot update issues — ask an Owner or Manager.')}</div>}
        </Card>
        <Card title={`Internal notes (${f.notes.length})`}>
          <div className="col gap-8">
            {f.notes.map((n) => (
              <div key={n.id} className="card card-b" style={{ background: 'var(--surface-2)' }}>
                <div className="muted" style={{ fontSize: 11.5 }}>{n.by} · {dateTimeFmt(n.ts)}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
              </div>
            ))}
            {!f.notes.length && <div className="muted">{t(lang, 'No internal notes yet.')}</div>}
            {canManage && (
              <div className="col gap-6">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t(lang, 'Add an investigation note or internal remark…')} />
                <div><Button size="sm" disabled={!note.trim() || busy} onClick={() => run(() => addFeedbackNote(f, myLabel, note).then(() => setNote('')))}>{t(lang, 'Add note')}</Button></div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </Drawer>
  );
}

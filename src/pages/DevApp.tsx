// DEV APP Customer — self-service designer for customer-facing app layouts.
// Draft → Preview → Apply → Approve → Deploy → Published, with version history and rollback.
// Permissions are enforced by the database (RLS + workflow functions); the UI only mirrors them.
import { DragEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, GripVertical, Monitor, Redo2, Rocket, Save, Smartphone, Tablet, Trash2, Undo2, Upload, CheckCircle2, XCircle, History, ExternalLink, Plus, RotateCcw } from 'lucide-react';
import { useDB, toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { Badge, Banner, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Tabs, Textarea, Tx, useConfirm } from '../ui/kit';
import { AppRole, canDo, CustomerApp, Deployment, devapp, LayoutVersion, StaffRow, Template, VersionStatus } from '../devapp/api';
import { PhonePreview } from '../devapp/Preview';
import {
  defaultLayout, Device, DEVICES, diffLayouts, FieldDef, FONTS, LayoutConfig, newSection, normalizeLayout, Section, SECTION_DEFS, sectionDef,
  ALWAYS_VISIBLE, PropItem, SectionType, TAB_KEYS, Theme, THEME_PRESETS, validateLayout,
} from '../devapp/schema';
import { cx, dateTimeFmt } from '../lib/util';

const STATUS_TONE: Record<VersionStatus, 'good' | 'warn' | 'bad' | 'info' | ''> = { draft: '', applied: 'info', approved: 'warn', published: 'good', superseded: '', rejected: 'bad' };
// Layout statuses get their own Thai words: the generic dictionary already uses 'applied' for promotions (= used).
const STATUS_TH: Record<VersionStatus, string> = { draft: 'ฉบับร่าง', applied: 'รอตรวจ (Apply แล้ว)', approved: 'อนุมัติแล้ว', published: 'เผยแพร่แล้ว', superseded: 'ถูกแทนที่', rejected: 'ถูกปฏิเสธ' };
function StatusText({ s }: { s: VersionStatus }) { const lang = useLang(); return <>{lang === 'th' ? STATUS_TH[s] : s}</>; }
const DEVICE_ICON: Record<Device, ReactNode> = { mobile: <Smartphone size={15} />, tablet: <Tablet size={15} />, desktop: <Monitor size={15} /> };
const ROLES: { v: AppRole; label: string; desc: string }[] = [
  { v: 'viewer', label: 'Viewer', desc: 'View layouts and previews' },
  { v: 'designer', label: 'Designer', desc: 'Create and edit drafts' },
  { v: 'approver', label: 'Approver', desc: 'Review and approve changes' },
  { v: 'publisher', label: 'Publisher', desc: 'Apply and deploy changes' },
  { v: 'admin', label: 'Administrator', desc: 'Full access' },
];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------------------------------------- editor state with undo/redo
function useHistory(initial: LayoutConfig) {
  const [st, setSt] = useState({ stack: [initial], i: 0, lastKey: '', lastAt: 0 });
  const cur = st.stack[st.i];
  const reset = useCallback((c: LayoutConfig) => setSt({ stack: [c], i: 0, lastKey: '', lastAt: 0 }), []);
  // `key` coalesces rapid edits of one field (typing) into a single undo step
  const change = useCallback((fn: (c: LayoutConfig) => void, key = '') => setSt((s) => {
    const next = clone(s.stack[s.i]); fn(next);
    const now = Date.now();
    const merge = key && key === s.lastKey && now - s.lastAt < 1200;
    const base = s.stack.slice(0, merge ? s.i : s.i + 1);
    return { stack: [...base, next].slice(-100), i: Math.min(base.length, 99), lastKey: key, lastAt: now };
  }), []);
  const undo = () => setSt((s) => ({ ...s, i: Math.max(0, s.i - 1), lastKey: '' }));
  const redo = () => setSt((s) => ({ ...s, i: Math.min(s.stack.length - 1, s.i + 1), lastKey: '' }));
  return { cur, change, reset, undo, redo, canUndo: st.i > 0, canRedo: st.i < st.stack.length - 1 };
}

export default function DevApp() {
  const db = useDB();
  const lang = useLang();
  const ask = useConfirm();
  const [role, setRole] = useState<AppRole | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [apps, setApps] = useState<CustomerApp[]>([]);
  const [appId, setAppId] = useState<string>('');
  const [versions, setVersions] = useState<LayoutVersion[]>([]);
  const [deploys, setDeploys] = useState<Deployment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [open, setOpen] = useState<LayoutVersion | null>(null); // version loaded in the editor (null = new unsaved draft)
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string>(''); // JSON of the last saved/loaded config, for the unsaved-changes indicator
  const h = useHistory(defaultLayout(db.org.name.split(' ')[0]));
  const cfg = h.cur;
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>('mobile');
  const [panel, setPanel] = useState<'versions' | 'deployments' | 'templates' | 'issues' | 'access'>('versions');
  const [busy, setBusy] = useState('');
  const [compare, setCompare] = useState<{ a: LayoutConfig; aLabel: string; b: LayoutConfig; bLabel: string } | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [intro, setIntro] = useState(false);
  const [memberId, setMemberId] = useState<string>(() => [...db.customers].sort((a, b) => (b.lineUserId ? 1 : 0) - (a.lineUserId ? 1 : 0))[0]?.id ?? '');

  const app = apps.find((a) => a.id === appId);
  const live = versions.find((v) => v.id === app?.published_version_id) ?? null;
  const editable = !open || open.status === 'draft';
  const canEdit = canDo(role ?? null, 'edit') && editable;
  const dirty = JSON.stringify(cfg) !== saved;
  const issues = useMemo(() => validateLayout(cfg), [cfg]);

  // --------------------------------------------------------------------------------------- loading
  const loadApp = useCallback(async (id: string, keepOpen?: string) => {
    const [vs, ds] = await Promise.all([devapp.versions(id), devapp.deployments(id)]);
    setVersions(vs); setDeploys(ds);
    const as = await devapp.apps(); setApps(as);
    const target = (keepOpen && vs.find((v) => v.id === keepOpen))
      || vs.find((v) => v.status === 'draft') || vs.find((v) => v.id === as.find((a) => a.id === id)?.published_version_id) || null;
    loadInto(target);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadInto = (v: LayoutVersion | null) => {
    const c = v ? normalizeLayout(v.config) : defaultLayout(db.org.name.split(' ')[0]);
    setOpen(v); setName(v?.name ?? 'New layout'); h.reset(c); setSaved(v ? JSON.stringify(c) : ''); setSelected(null);
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await devapp.myRole(); setRole(r);
        if (!r) return;
        const [as, ts] = await Promise.all([devapp.apps(), devapp.templates()]);
        setApps(as); setTemplates(ts);
        if (as[0]) { setAppId(as[0].id); await loadApp(as[0].id); }
      } catch (e) { const m = (e as Error).message;
        // The database part (supabase/migrations/*_customer_app_designer.sql) has not been applied to this project yet
        setErr(/customer_app_my_role|schema cache|does not exist|Could not find the function/i.test(m) ? tl(lang, 'DEV APP Customer is not set up in the database yet. An administrator needs to apply the DEV APP migration in Supabase.') : m);
        setRole(null); }
    })();
  }, [loadApp]);

  const guard = async (fn: () => Promise<void>, label: string) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast('error', (e as Error).message); } finally { setBusy(''); }
  };
  const confirmDiscard = async () => !dirty || (await ask({ title: 'Discard unsaved changes?', body: 'Your changes to this layout have not been saved.', confirmLabel: 'Discard', danger: true })).ok;

  // --------------------------------------------------------------------------------------- actions
  const saveDraft = () => guard(async () => {
    const v = open?.status === 'draft' ? await devapp.saveDraft(open.id, cfg, name) : await devapp.createDraft(appId, cfg, name || 'New layout', open?.id ?? null);
    toast('success', tl(lang, 'Draft v{n} saved', { n: v.version_no }));
    await loadApp(appId, v.id);
  }, 'save');
  const apply = async () => {
    if (!open || open.status !== 'draft' || dirty) return;
    if (issues.length) { setPanel('issues'); return toast('error', tl(lang, 'Fix the {n} problem(s) before applying', { n: issues.length })); }
    const r = await ask({ title: 'Apply this layout?', body: tl(lang, 'Version {n} is validated and locked for review. You can then preview it in the real customer app before it is approved and deployed.', { n: open.version_no }), confirmLabel: 'Apply' });
    if (r.ok) await guard(async () => { await devapp.apply(open.id); toast('success', 'Applied — ready for review'); await loadApp(appId, open.id); }, 'apply');
  };
  const review = async (approve: boolean) => {
    if (!open) return;
    const r = await ask({ title: approve ? 'Approve this layout?' : 'Reject this layout?', body: approve ? 'A publisher can then deploy it to customers.' : 'The version is kept in history but cannot be deployed.', confirmLabel: approve ? 'Approve' : 'Reject', danger: !approve, reason: approve ? false : 'Reason (shown in the version history)' });
    if (r.ok) await guard(async () => { await devapp.review(open.id, approve, r.reason); toast('success', approve ? 'Approved' : 'Rejected'); await loadApp(appId, open.id); }, 'review');
  };
  const deploy = (message: string) => guard(async () => {
    if (!open) return;
    const d = await devapp.deploy(open.id, message);
    setDeployOpen(false);
    if (d.status === 'succeeded') toast('success', tl(lang, 'Deployed — customers now see v{n}', { n: open.version_no }));
    else toast('error', tl(lang, 'Deployment failed: {error}', { error: d.error ?? '' }));
    setPanel('deployments');
    await loadApp(appId, open.id);
  }, 'deploy');
  const rollback = async (v: LayoutVersion) => {
    const r = await ask({ title: tl(lang, 'Restore version {n}?', { n: v.version_no }), body: 'Customers immediately see this earlier published layout. The current live version stays in history and can be restored again.', confirmLabel: 'Restore now', danger: true, reason: 'Reason for the rollback' });
    if (r.ok) await guard(async () => { const d = await devapp.rollback(v.id, r.reason); toast(d.status === 'succeeded' ? 'success' : 'error', d.status === 'succeeded' ? tl(lang, 'Rolled back to v{n}', { n: v.version_no }) : d.error ?? 'Rollback failed'); setPanel('deployments'); await loadApp(appId); }, 'rollback');
  };
  const duplicate = (v: LayoutVersion | null) => guard(async () => {
    if (!(await confirmDiscard())) return;
    const c = v ? normalizeLayout(v.config) : cfg;
    const nv = await devapp.createDraft(appId, c, v ? tl(lang, 'Copy of v{n}', { n: v.version_no }) : name, v?.id ?? null);
    toast('success', tl(lang, 'Draft v{n} created', { n: nv.version_no }));
    await loadApp(appId, nv.id);
  }, 'duplicate');
  const removeDraft = async (v: LayoutVersion) => {
    const r = await ask({ title: tl(lang, 'Delete draft v{n}?', { n: v.version_no }), body: 'Only drafts can be deleted. Applied and published versions are always kept.', confirmLabel: 'Delete', danger: true });
    if (r.ok) await guard(async () => { await devapp.deleteDraft(v.id); await loadApp(appId); }, 'delete');
  };
  const newFrom = async (c: LayoutConfig, label: string) => {
    if (!(await confirmDiscard())) return;
    setOpen(null); setName(label); h.reset(normalizeLayout(clone(c))); setSaved(''); setSelected(null);
  };

  // --------------------------------------------------------------------------------------- section editing
  const sel = cfg.home.find((s) => s.id === selected) ?? null;
  const addSection = (type: SectionType, before?: string) => {
    if (!canEdit) return;
    const s = newSection(type);
    h.change((c) => { const i = before ? c.home.findIndex((x) => x.id === before) : -1; if (i >= 0) c.home.splice(i, 0, s); else c.home.push(s); });
    setSelected(s.id);
  };
  const moveSection = (id: string, before: string | null) => h.change((c) => {
    const i = c.home.findIndex((x) => x.id === id); if (i < 0 || id === before) return;
    const [s] = c.home.splice(i, 1);
    const j = before ? c.home.findIndex((x) => x.id === before) : -1;
    if (j >= 0) c.home.splice(j, 0, s); else c.home.push(s);
  });
  const nudge = (id: string, d: -1 | 1) => h.change((c) => { const i = c.home.findIndex((x) => x.id === id); const j = i + d; if (i < 0 || j < 0 || j >= c.home.length) return; [c.home[i], c.home[j]] = [c.home[j], c.home[i]]; });
  const dupSection = (id: string) => { const src = cfg.home.find((x) => x.id === id); if (!src) return; const s = { ...clone(src), id: newSection(src.type).id }; h.change((c) => { c.home.splice(c.home.findIndex((x) => x.id === id) + 1, 0, s); }); setSelected(s.id); };
  const delSection = (id: string) => { h.change((c) => { c.home = c.home.filter((x) => x.id !== id); }); setSelected(null); };
  const editSection = (fn: (s: Section) => void, key: string) => h.change((c) => { const s = c.home.find((x) => x.id === selected); if (s) fn(s); }, key);

  // keyboard: Ctrl+Z / Ctrl+Y / Delete
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !canEdit) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) h.redo(); else h.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); h.redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); delSection(selected); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // --------------------------------------------------------------------------------------- canvas
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined); // undefined = no drag in progress, null = end
  const onDrop = (e: DragEvent, before: string | null) => {
    e.preventDefault(); e.stopPropagation(); setDropBefore(undefined);
    if (!canEdit) return;
    const data = e.dataTransfer.getData('text/plain');
    if (data.startsWith('new:')) addSection(data.slice(4) as SectionType, before ?? undefined);
    else if (data.startsWith('move:')) moveSection(data.slice(5), before);
  };
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState(600);
  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth - 32)); ro.observe(el); return () => ro.disconnect();
  }, [role]);

  const editor = {
    selected,
    render: (s: Section, content: ReactNode, hiddenHere: boolean) => {
      const on = selected === s.id;
      return (
        <div
          className={cx('dev-sec', on && 'on', hiddenHere && 'hidden-here', dropBefore === s.id && 'drop')}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelected(s.id); }}
          onDragOver={(e) => { if (canEdit) { e.preventDefault(); e.stopPropagation(); setDropBefore(s.id); } }}
          onDrop={(e) => onDrop(e, s.id)}
          tabIndex={0} role="button" aria-label={tl(lang, 'Select {name}', { name: tl(lang, sectionDef(s.type)?.label ?? s.type) })} aria-pressed={on}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(s.id); } }}
        >
          <div className="dev-sec-bar">
            <span className="dev-sec-name"><Tx>{sectionDef(s.type)?.label ?? s.type}</Tx>{hiddenHere && <> · <Tx>hidden on this device</Tx></>}</span>
            {canEdit && <span className="row gap-4" onClick={(e) => e.stopPropagation()}>
              <span draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', 'move:' + s.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDropBefore(undefined)} className="dev-ic" title={tl(lang, 'Drag to move')} aria-hidden><GripVertical size={14} /></span>
              <button type="button" className="dev-ic" onClick={() => nudge(s.id, -1)} aria-label={tl(lang, 'Move up')}><ArrowUp size={13} /></button>
              <button type="button" className="dev-ic" onClick={() => nudge(s.id, 1)} aria-label={tl(lang, 'Move down')}><ArrowDown size={13} /></button>
              <button type="button" className="dev-ic" onClick={() => dupSection(s.id)} aria-label={tl(lang, 'Duplicate')}><Copy size={13} /></button>
              <button type="button" className="dev-ic" onClick={() => delSection(s.id)} aria-label={tl(lang, 'Delete')}><Trash2 size={13} /></button>
            </span>}
          </div>
          {/* sections that render nothing for this member (e.g. no outstanding balance) stay selectable via the placeholder */}
          <div className="dev-sec-body" style={{ pointerEvents: 'none' }} data-empty={tl(lang, '{name} — nothing to show for this member right now', { name: tl(lang, sectionDef(s.type)?.label ?? s.type) })}>{content}</div>
        </div>
      );
    },
  };

  // --------------------------------------------------------------------------------------- render
  if (role === undefined) return <div className="center" style={{ padding: 60 }}><div className="spinner" /></div>;
  if (!role) return (
    <>
      <PageHead title="DEV APP Customer" desc="Design, preview and publish the customer app without code." />
      <Card><Empty title="No access to DEV APP Customer" hint={err ?? 'Ask an administrator to give you a DEV APP role (Viewer, Designer, Approver, Publisher or Administrator).'} /></Card>
    </>
  );
  const st = open?.status ?? 'draft';
  const versionLabel = open ? tl(lang, 'v{n}', { n: open.version_no }) : tl(lang, 'new');

  return (
    <div className="dev-app">
      <PageHead title="DEV APP Customer" desc="Design, preview and publish the customer app without code. Changes reach customers only after Apply → Approve → Deploy."
        actions={<>
          <Select sm style={{ width: 'auto' }} value={appId} aria-label={tl(lang, 'Customer app')} onChange={async (e) => { if (await confirmDiscard()) { setAppId(e.target.value); await guard(() => loadApp(e.target.value), 'load'); } }}>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Badge tone="info"><Tx>{'Your role'}</Tx>: <Tx>{ROLES.find((r) => r.v === role)?.label ?? role}</Tx></Badge>
        </>} />

      {/* ---------------------------------------------------------------- toolbar */}
      <div className="dev-toolbar card">
        <div className="row gap-6 wrap" style={{ minWidth: 0 }}>
          <Input sm value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} aria-label={tl(lang, 'Layout name')} style={{ width: 180 }} />
          <Badge tone={STATUS_TONE[st]} dot><Tx>{versionLabel}</Tx> · <StatusText s={st} /></Badge>
          {open && app?.published_version_id === open.id && <Badge tone="good"><Tx>live</Tx></Badge>}
          {dirty && editable && <Badge tone="warn"><Tx>unsaved changes</Tx></Badge>}
          {live && <span className="muted" style={{ fontSize: 12 }}><Tx vars={{ n: live.version_no }}>{'Live: v{n}'}</Tx></span>}
        </div>
        <div className="row gap-6 wrap">
          <Button size="sm" variant="ghost" icon onClick={h.undo} disabled={!canEdit || !h.canUndo} aria-label={tl(lang, 'Undo')} title={tl(lang, 'Undo') + ' (Ctrl+Z)'}><Undo2 size={16} /></Button>
          <Button size="sm" variant="ghost" icon onClick={h.redo} disabled={!canEdit || !h.canRedo} aria-label={tl(lang, 'Redo')} title={tl(lang, 'Redo') + ' (Ctrl+Y)'}><Redo2 size={16} /></Button>
          {canDo(role, 'edit') && (editable
            ? <Button size="sm" onClick={saveDraft} loading={busy === 'save'} disabled={!!busy || (!dirty && !!open)}><Save size={15} /> <Tx>Save draft</Tx></Button>
            : <Button size="sm" onClick={() => duplicate(open)} disabled={!!busy}><Copy size={15} /> <Tx>Edit as new draft</Tx></Button>)}
          <Button size="sm" onClick={() => setCompare({ a: live ? normalizeLayout(live.config) : defaultLayout(db.org.name.split(' ')[0]), aLabel: live ? tl(lang, 'Live now (v{n})', { n: live.version_no }) : tl(lang, 'Live now (built-in layout)'), b: cfg, bLabel: tl(lang, 'This layout ({v})', { v: versionLabel }) })}><Eye size={15} /> <Tx>Preview</Tx></Button>
          {canDo(role, 'deploy') && st === 'draft' && <Button size="sm" variant="primary" onClick={apply} disabled={!open || dirty || !!busy} title={!open || dirty ? tl(lang, 'Save the draft first') : undefined}><CheckCircle2 size={15} /> <Tx>Apply</Tx></Button>}
          {canDo(role, 'approve') && st === 'applied' && <><Button size="sm" variant="primary" onClick={() => review(true)} disabled={!!busy}><CheckCircle2 size={15} /> <Tx>Approve</Tx></Button><Button size="sm" variant="danger" onClick={() => review(false)} disabled={!!busy}><XCircle size={15} /> <Tx>Reject</Tx></Button></>}
          {canDo(role, 'deploy') && st === 'approved' && <Button size="sm" variant="primary" onClick={() => setDeployOpen(true)} disabled={!!busy}><Rocket size={15} /> <Tx>Deploy</Tx></Button>}
        </div>
      </div>
      <div className="dev-flow" aria-label={tl(lang, 'Workflow')}>
        {(['draft', 'applied', 'approved', 'published'] as VersionStatus[]).map((s, i) => {
          const order = ['draft', 'applied', 'approved', 'published'];
          const at = st === 'superseded' ? 3 : st === 'rejected' ? 1 : order.indexOf(st);
          return <span key={s} className={cx('dev-step', i < at && 'done', i === at && 'cur')}>{i + 1}. <StatusText s={s} /></span>;
        })}
        {open?.review_note && <span className="muted" style={{ fontSize: 12 }}><Tx>Review note</Tx>: {open.review_note}</span>}
        {open && st !== 'draft' && <a className="row gap-4" style={{ fontSize: 12.5, marginLeft: 'auto' }} href={`#/app?layout=${open.id}`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> <Tx>Preview in the real customer app</Tx></a>}
      </div>

      {/* ---------------------------------------------------------------- workspace */}
      <div className="dev-work">
        <aside className="dev-side card" aria-label={tl(lang, 'Components')}>
          <div className="dev-side-h"><Tx>Components</Tx></div>
          {!canEdit && <div className="muted" style={{ fontSize: 12, padding: '0 12px 8px' }}><Tx>{editable ? 'Your role can view layouts only.' : 'This version is locked. Use “Edit as new draft” to change it.'}</Tx></div>}
          {(['Member data', 'Content', 'Layout'] as const).map((g) => (
            <div key={g}>
              <div className="dev-group"><Tx>{g}</Tx></div>
              {SECTION_DEFS.filter((d) => d.group === g).map((d) => (
                <button key={d.type} type="button" className="dev-comp" disabled={!canEdit} draggable={canEdit}
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', 'new:' + d.type); e.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={() => setDropBefore(undefined)}
                  onClick={() => addSection(d.type, undefined)} title={tl(lang, d.desc)}>
                  <Plus size={13} /><span><b><Tx>{d.label}</Tx></b><small><Tx>{d.desc}</Tx></small></span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section className="dev-canvas card" ref={canvasRef}>
          <div className="row between wrap" style={{ gap: 8, marginBottom: 12 }}>
            <div className="seg" role="tablist" aria-label={tl(lang, 'Device')}>
              {DEVICES.map((d) => <button key={d.v} type="button" role="tab" aria-selected={device === d.v} className={cx(device === d.v && 'on')} onClick={() => setDevice(d.v)}>{DEVICE_ICON[d.v]} <Tx>{d.label}</Tx></button>)}
            </div>
            {cfg.onboarding.enabled && <Button size="sm" variant="ghost" onClick={() => setIntro(true)}><Eye size={14} /> <Tx>Show intro pop-up</Tx></Button>}
            <Select sm style={{ width: 'auto', maxWidth: 220 }} value={memberId} onChange={(e) => setMemberId(e.target.value)} aria-label={tl(lang, 'Preview as member')}>
              {db.customers.slice(0, 200).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="dev-stage" onClick={() => setSelected(null)}
            onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDropBefore(null); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropBefore(undefined); }} onDrop={(e) => onDrop(e, null)}>
            <PhonePreview config={cfg} device={device} customerId={memberId || null} editor={editor} fit={canvasW} height={device === 'mobile' ? 760 : 820} intro={intro} onIntroClose={() => setIntro(false)} />
            {dropBefore === null && <div className="dev-drop-end"><Tx>Drop here to add at the end</Tx></div>}
          </div>
          {!cfg.home.length && <div className="muted center" style={{ marginTop: 10 }}><Tx>Drag components from the left onto the phone, or click one to add it.</Tx></div>}
        </section>

        <aside className="dev-props card" aria-label={tl(lang, 'Properties')}>
          {sel ? <SectionProps s={sel} disabled={!canEdit} edit={editSection} onClose={() => setSelected(null)} />
            : <GlobalProps cfg={cfg} disabled={!canEdit} change={h.change} />}
        </aside>
      </div>

      {/* ---------------------------------------------------------------- history / deployments / templates */}
      <Card flush className="mt16">
        <Tabs value={panel} onChange={setPanel} tabs={[
          { v: 'versions', label: 'Versions', count: versions.length }, { v: 'deployments', label: 'Deployments', count: deploys.length },
          { v: 'templates', label: 'Templates', count: templates.length }, { v: 'issues', label: 'Validation', count: issues.length || '' },
          ...(canDo(role, 'admin') ? [{ v: 'access' as const, label: 'Access' }] : []),
        ]} />
        <div style={{ padding: 14 }}>
          {panel === 'versions' && <VersionsPanel versions={versions} liveId={app?.published_version_id ?? null} openId={open?.id ?? null} role={role}
            onOpen={async (v) => { if (await confirmDiscard()) loadInto(v); }} onDuplicate={duplicate} onDelete={removeDraft} onRollback={rollback}
            onCompare={(v) => setCompare({ a: live ? normalizeLayout(live.config) : defaultLayout(db.org.name.split(' ')[0]), aLabel: live ? tl(lang, 'Live now (v{n})', { n: live.version_no }) : tl(lang, 'Live now (built-in layout)'), b: normalizeLayout(v.config), bLabel: tl(lang, 'v{n}', { n: v.version_no }) })}
            onNew={() => newFrom(defaultLayout(db.org.name.split(' ')[0]), tl(lang, 'New layout'))} />}
          {panel === 'deployments' && <DeploymentsPanel deploys={deploys} versions={versions} />}
          {panel === 'templates' && <TemplatesPanel templates={templates} role={role} onUse={(t) => newFrom(t.config, t.name)}
            onSave={(n, d) => guard(async () => { await devapp.saveTemplate(n, d, cfg); setTemplates(await devapp.templates()); toast('success', 'Template saved'); }, 'template')}
            onDelete={(t) => guard(async () => { await devapp.deleteTemplate(t.id); setTemplates(await devapp.templates()); }, 'template')} />}
          {panel === 'issues' && (issues.length
            ? <div className="col gap-6">{issues.map((i, k) => <div key={k} className="row gap-6"><Badge tone="bad">{i.path || 'layout'}</Badge><span><Tx>{i.message}</Tx></span></div>)}</div>
            : <Banner tone="good"><Tx>The layout is valid and can be applied.</Tx></Banner>)}
          {panel === 'access' && canDo(role, 'admin') && <AccessPanel />}
        </div>
      </Card>

      {compare && <CompareModal {...compare} device={device} memberId={memberId} onClose={() => setCompare(null)} />}
      {deployOpen && open && <DeployModal version={open} live={live} cfg={cfg} busy={busy === 'deploy'} onClose={() => setDeployOpen(false)} onDeploy={deploy} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- property panels
function ColorInput({ value, onChange, disabled, allowEmpty, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; allowEmpty?: boolean; label: string }) {
  const lang = useLang();
  return (
    <div className="row gap-6">
      <input type="color" value={value || '#ffffff'} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={tl(lang, label)} style={{ width: 34, height: 30, padding: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'none' }} />
      <Input sm value={value} disabled={disabled} onChange={(e) => onChange(e.target.value.trim())} placeholder={allowEmpty ? tl(lang, 'default') : '#000000'} aria-label={tl(lang, label) + ' (hex)'} style={{ width: 96 }} />
      {allowEmpty && value && !disabled && <Button size="sm" variant="ghost" onClick={() => onChange('')}><Tx>Clear</Tx></Button>}
    </div>
  );
}
function ImageInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const lang = useLang();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="col gap-6">
      {value && <img src={value} alt="" style={{ maxHeight: 70, maxWidth: '100%', objectFit: 'contain', borderRadius: 6, border: '1px solid var(--border)', alignSelf: 'flex-start' }} />}
      <div className="row gap-6">
        <Input sm value={value} disabled={disabled} placeholder="https://…" onChange={(e) => onChange(e.target.value.trim())} aria-label={tl(lang, 'Image link')} />
        <input ref={ref} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
          setBusy(true);
          try { onChange(await devapp.uploadImage(f)); toast('success', 'Image uploaded'); } catch (er) { toast('error', (er as Error).message); } finally { setBusy(false); }
        }} />
        <Button size="sm" disabled={disabled || busy} onClick={() => ref.current?.click()}><Upload size={14} /> <Tx>{busy ? 'Uploading…' : 'Upload'}</Tx></Button>
      </div>
      <span className="hint"><Tx>PNG, JPEG or WebP, up to 2 MB.</Tx></span>
    </div>
  );
}
function PropField({ f, value, onChange, disabled }: { f: FieldDef; value: unknown; onChange: (v: string | number | boolean) => void; disabled: boolean }) {
  const lang = useLang();
  switch (f.kind) {
    case 'boolean': return <label className="check"><input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><Tx>{f.label}</Tx></label>;
    case 'number': return <Field label={f.label}><Input sm type="number" min={f.min} max={f.max} value={typeof value === 'number' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? (f.min ?? 0) : Number(e.target.value))} /></Field>;
    case 'textarea': return <Field label={f.label}><Textarea rows={4} maxLength={f.max_len} value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></Field>;
    case 'image': return <Field label={f.label}><ImageInput value={String(value ?? '')} disabled={disabled} onChange={onChange} /></Field>;
    case 'select': return <Field label={f.label}><Select sm value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{f.options!.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</Select></Field>;
    case 'tab': return <Field label={f.label}><Select sm value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)}><option value="">{tl(lang, '— none —')}</option>{TAB_KEYS.filter((k) => k !== 'profile').map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>;
    case 'items': return <ItemsEditor f={f} items={(Array.isArray(value) ? value : []) as PropItem[]} disabled={disabled} onChange={(v) => onChange(v as unknown as string)} />;
    default: return <Field label={f.label}><Input sm maxLength={f.max_len} value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></Field>;
  }
}
/** List editor for 'items' fields (e.g. carousel cards): add, remove, reorder, edit each item's fields. */
function ItemsEditor({ f, items, disabled, onChange }: { f: FieldDef; items: PropItem[]; disabled: boolean; onChange: (v: PropItem[]) => void }) {
  const blank = (): PropItem => Object.fromEntries((f.item ?? []).map((x) => [x.key, '']));
  const set = (i: number, k: string, v: string | number | boolean) => onChange(items.map((it, j) => (j === i ? { ...it, [k]: String(v) } : it)));
  const move = (i: number, d: -1 | 1) => { const n = [...items]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  return (
    <div className="col gap-8">
      <div className="dev-sub"><Tx>{f.label}</Tx> ({items.length}/{f.max_items ?? 10})</div>
      {items.map((it, i) => (
        <div key={i} className="dev-item">
          <div className="row between"><b>#{i + 1}</b><span className="row gap-4">
            <Button size="sm" variant="ghost" icon disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={13} /></Button>
            <Button size="sm" variant="ghost" icon disabled={disabled || i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={13} /></Button>
            <Button size="sm" variant="ghost" icon disabled={disabled} onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Delete"><Trash2 size={13} /></Button></span></div>
          {(f.item ?? []).map((sf) => <PropField key={sf.key} f={sf} value={it[sf.key] ?? ''} disabled={disabled} onChange={(v) => set(i, sf.key, v)} />)}
        </div>
      ))}
      {!disabled && items.length < (f.max_items ?? 10) && <Button size="sm" onClick={() => onChange([...items, blank()])}><Plus size={14} /> <Tx>Add item</Tx></Button>}
    </div>
  );
}
function SectionProps({ s, disabled, edit, onClose }: { s: Section; disabled: boolean; edit: (fn: (s: Section) => void, key: string) => void; onClose: () => void }) {
  const def = sectionDef(s.type)!;
  return (
    <div className="col gap-12">
      <div className="row between"><div><b><Tx>{def.label}</Tx></b><div className="muted" style={{ fontSize: 12 }}><Tx>{def.desc}</Tx></div></div><Button size="sm" variant="ghost" onClick={onClose}><Tx>Done</Tx></Button></div>
      {def.fields.map((f) => <PropField key={f.key} f={f} value={s.props[f.key]} disabled={disabled} onChange={(v) => edit((x) => { x.props[f.key] = v; }, s.id + f.key)} />)}
      <div className="dev-sub"><Tx>Width (of 12 columns)</Tx></div>
      <div className="row gap-6">{DEVICES.map((d) => (
        <Field key={d.v} label={d.label}><Select sm value={s.span[d.v]} disabled={disabled} onChange={(e) => edit((x) => { x.span[d.v] = Number(e.target.value); }, '')}>{[12, 9, 8, 6, 4, 3].map((n) => <option key={n} value={n}>{n === 12 ? '12 (full)' : n}</option>)}</Select></Field>
      ))}</div>
      <div className="dev-sub"><Tx>Hide on</Tx></div>
      <div className="row gap-12">{DEVICES.map((d) => <label key={d.v} className="check"><input type="checkbox" checked={s.hidden[d.v]} disabled={disabled} onChange={(e) => edit((x) => { x.hidden[d.v] = e.target.checked; }, '')} /><Tx>{d.label}</Tx></label>)}</div>
      <div className="dev-sub"><Tx>Spacing & colours</Tx></div>
      <div className="row gap-6">
        <Field label="Padding"><Input sm type="number" min={0} max={64} value={s.style.padding} disabled={disabled} onChange={(e) => edit((x) => { x.style.padding = Math.max(0, Math.min(64, Number(e.target.value) || 0)); }, s.id + 'pad')} /></Field>
        <Field label="Space above"><Input sm type="number" min={0} max={120} value={s.style.marginTop} disabled={disabled} onChange={(e) => edit((x) => { x.style.marginTop = Math.max(0, Math.min(120, Number(e.target.value) || 0)); }, s.id + 'mt')} /></Field>
        <Field label="Corner radius"><Input sm type="number" min={0} max={40} value={s.style.radius} disabled={disabled} onChange={(e) => edit((x) => { x.style.radius = Math.max(0, Math.min(40, Number(e.target.value) || 0)); }, s.id + 'rad')} /></Field>
      </div>
      <Field label="Background"><ColorInput label="Background" allowEmpty value={s.style.background} disabled={disabled} onChange={(v) => edit((x) => { x.style.background = v; }, s.id + 'bg')} /></Field>
      <Field label="Text colour"><ColorInput label="Text colour" allowEmpty value={s.style.textColor} disabled={disabled} onChange={(v) => edit((x) => { x.style.textColor = v; }, s.id + 'fg')} /></Field>
      <Field label="Alignment"><Select sm value={s.style.align} disabled={disabled} onChange={(e) => edit((x) => { x.style.align = e.target.value as Section['style']['align']; }, '')}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></Select></Field>
    </div>
  );
}
function GlobalProps({ cfg, disabled, change }: { cfg: LayoutConfig; disabled: boolean; change: (fn: (c: LayoutConfig) => void, key?: string) => void }) {
  const [tab, setTab] = useState<'theme' | 'brand' | 'nav' | 'intro'>('theme');
  const color = (k: keyof Theme, label: string) => <Field key={k} label={label}><ColorInput label={label} value={String(cfg.theme[k])} disabled={disabled} onChange={(v) => change((c) => { (c.theme[k] as string) = v; }, 'theme.' + k)} /></Field>;
  const numF = (k: keyof Theme, label: string, lo: number, hi: number) => <Field key={k} label={label}><Input sm type="number" min={lo} max={hi} value={Number(cfg.theme[k])} disabled={disabled} onChange={(e) => change((c) => { (c.theme[k] as number) = Math.max(lo, Math.min(hi, Number(e.target.value) || lo)); }, 'theme.' + k)} /></Field>;
  return (
    <div className="col gap-12">
      <div className="seg" role="tablist">{(['theme', 'brand', 'nav', 'intro'] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={cx(tab === k && 'on')} onClick={() => setTab(k)}><Tx>{k === 'theme' ? 'Theme' : k === 'brand' ? 'Branding' : k === 'nav' ? 'Navigation' : 'Intro'}</Tx></button>)}</div>
      <div className="muted" style={{ fontSize: 12 }}><Tx>Select a section on the phone to edit it. These settings apply to the whole app.</Tx></div>
      {tab === 'theme' && <>
        <div className="dev-sub"><Tx>Start from a preset</Tx></div>
        <div className="row gap-6 wrap">{THEME_PRESETS.map((p) => (
          <Button key={p.v} size="sm" disabled={disabled} onClick={() => change((c) => { const base = defaultLayout(); c.theme = { ...(p.v === 'default' ? base.theme : c.theme), ...p.theme } as Theme; c.brand = { ...c.brand, ...p.brand }; })}>
            <span className="dev-swatch" style={{ background: p.theme.background ?? '#f6f6f3', borderColor: p.theme.primary ?? '#2068c4' }}><i style={{ background: p.theme.primary ?? '#2068c4' }} /></span><Tx>{p.label}</Tx>
          </Button>))}</div>
        <Field label="Bottom menu style"><Select sm value={cfg.theme.navStyle} disabled={disabled} onChange={(e) => change((c) => { c.theme.navStyle = e.target.value as Theme['navStyle']; })}><option value="classic">Classic bar</option><option value="floating">Floating capsule</option></Select></Field>
        {color('primary', 'Primary (buttons)')}{color('primaryText', 'Text on primary')}{color('headerBg', 'Header background')}{color('headerText', 'Header text')}
        {color('navActive', 'Active tab')}{color('background', 'Page background')}{color('surface', 'Cards')}{color('text', 'Text')}{color('muted', 'Secondary text')}
        {color('cardFrom', 'Member card gradient start')}{color('cardTo', 'Member card gradient end')}
        <Field label="Font"><Select sm value={cfg.theme.font} disabled={disabled} onChange={(e) => change((c) => { c.theme.font = e.target.value; })}>{FONTS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}</Select></Field>
        <div className="row gap-6 wrap">{numF('baseSize', 'Text size', 11, 22)}{numF('radius', 'Corner radius', 0, 32)}{numF('gap', 'Space between sections', 0, 40)}{numF('padding', 'Page padding', 0, 40)}</div>
      </>}
      {tab === 'brand' && <>
        <Field label="App title"><Input sm maxLength={40} value={cfg.brand.title} disabled={disabled} onChange={(e) => change((c) => { c.brand.title = e.target.value; }, 'brand.title')} /></Field>
        <Field label="Tagline (top right)"><Input sm maxLength={80} value={cfg.brand.tagline} disabled={disabled} onChange={(e) => change((c) => { c.brand.tagline = e.target.value; }, 'brand.tagline')} /></Field>
        <Field label="Logo"><ImageInput value={cfg.brand.logoUrl} disabled={disabled} onChange={(v) => change((c) => { c.brand.logoUrl = v; })} /></Field>
        <Field label="Header style"><Select sm value={cfg.brand.headerStyle} disabled={disabled} onChange={(e) => change((c) => { c.brand.headerStyle = e.target.value as LayoutConfig['brand']['headerStyle']; })}><option value="classic">Title left</option><option value="centered">Logo centred</option></Select></Field>
        <label className="check"><input type="checkbox" checked={cfg.brand.showIcons} disabled={disabled || cfg.brand.headerStyle !== 'centered'} onChange={(e) => change((c) => { c.brand.showIcons = e.target.checked; })} /><Tx>Show search, favourites and basket buttons</Tx></label>
      </>}
      {tab === 'intro' && <div className="col gap-8">
        <label className="check"><input type="checkbox" checked={cfg.onboarding.enabled} disabled={disabled} onChange={(e) => change((c) => { c.onboarding.enabled = e.target.checked; })} /><Tx>Show an intro pop-up the first time a member opens this version</Tx></label>
        {cfg.onboarding.slides.map((s, i) => (
          <div key={i} className="dev-item">
            <div className="row between"><b><Tx vars={{ n: i + 1 }}>{'Slide {n}'}</Tx></b><Button size="sm" variant="ghost" icon disabled={disabled} onClick={() => change((c) => { c.onboarding.slides.splice(i, 1); })} aria-label="Delete"><Trash2 size={13} /></Button></div>
            <Field label="Title"><Input sm maxLength={60} value={s.title} disabled={disabled} onChange={(e) => change((c) => { c.onboarding.slides[i].title = e.target.value; }, 'ob' + i + 't')} /></Field>
            <Field label="Text"><Textarea rows={3} maxLength={300} value={s.text} disabled={disabled} onChange={(e) => change((c) => { c.onboarding.slides[i].text = e.target.value; }, 'ob' + i + 'x')} /></Field>
            <Field label="Image"><ImageInput value={s.imageUrl} disabled={disabled} onChange={(v) => change((c) => { c.onboarding.slides[i].imageUrl = v; })} /></Field>
          </div>
        ))}
        {!disabled && cfg.onboarding.slides.length < 8 && <Button size="sm" onClick={() => change((c) => { c.onboarding.slides.push({ title: '', text: '', imageUrl: '' }); })}><Plus size={14} /> <Tx>Add slide</Tx></Button>}
      </div>}
      {tab === 'nav' && <div className="col gap-6">
        {cfg.nav.map((n, i) => (
          <div key={n.key} className="row gap-6">
            <label className="check" style={{ width: 28 }}><input type="checkbox" checked={n.visible} disabled={disabled || ALWAYS_VISIBLE.includes(n.key)} onChange={(e) => change((c) => { c.nav[i].visible = e.target.checked; })} aria-label={n.key} /></label>
            <Input sm maxLength={20} value={n.label} disabled={disabled} onChange={(e) => change((c) => { c.nav[i].label = e.target.value; }, 'nav' + i)} aria-label={n.key} />
            <span className="muted mono" style={{ fontSize: 11, width: 56 }}>{n.key}</span>
            <Button size="sm" variant="ghost" icon disabled={disabled || i === 0} onClick={() => change((c) => { [c.nav[i - 1], c.nav[i]] = [c.nav[i], c.nav[i - 1]]; })} aria-label="Move up"><ArrowUp size={13} /></Button>
            <Button size="sm" variant="ghost" icon disabled={disabled || i === cfg.nav.length - 1} onClick={() => change((c) => { [c.nav[i + 1], c.nav[i]] = [c.nav[i], c.nav[i + 1]]; })} aria-label="Move down"><ArrowDown size={13} /></Button>
          </div>
        ))}
        <span className="hint"><Tx>Home and profile always stay visible. “profile” appears only for members signed in with LINE.</Tx></span>
      </div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- bottom panels
function VersionsPanel({ versions, liveId, openId, role, onOpen, onDuplicate, onDelete, onRollback, onCompare, onNew }: {
  versions: LayoutVersion[]; liveId: string | null; openId: string | null; role: AppRole;
  onOpen: (v: LayoutVersion) => void; onDuplicate: (v: LayoutVersion) => void; onDelete: (v: LayoutVersion) => void; onRollback: (v: LayoutVersion) => void; onCompare: (v: LayoutVersion) => void; onNew: () => void;
}) {
  return (
    <div className="col gap-8">
      {canDo(role, 'edit') && <div><Button size="sm" onClick={onNew}><Plus size={14} /> <Tx>New layout from the built-in design</Tx></Button></div>}
      {!versions.length ? <Empty title="No versions yet" hint="Save a draft to start the history. Until something is deployed, customers see the built-in layout." /> : (
        <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>Version</Tx></th><th><Tx>Status</Tx></th><th><Tx>Name</Tx></th><th><Tx>Created by</Tx></th><th><Tx>Updated</Tx></th><th><Tx>Published</Tx></th><th /></tr></thead>
          <tbody>{versions.map((v) => (
            <tr key={v.id} className={cx(v.id === openId && 'sel')}>
              <td><b>v{v.version_no}</b>{v.id === liveId && <> <Badge tone="good"><Tx>live</Tx></Badge></>}</td>
              <td><Badge tone={STATUS_TONE[v.status]} dot><StatusText s={v.status} /></Badge>{v.review_note && <div className="sub">{v.review_note}</div>}</td>
              <td>{v.name}</td><td className="muted">{v.created_by_email ?? '—'}</td><td className="muted">{dateTimeFmt(v.updated_at)}</td><td className="muted">{v.published_at ? dateTimeFmt(v.published_at) : '—'}</td>
              <td><div className="row gap-4 wrap" style={{ justifyContent: 'flex-end' }}>
                <Button size="sm" onClick={() => onOpen(v)} disabled={v.id === openId}><Tx>{v.id === openId ? 'Open' : 'Open in editor'}</Tx></Button>
                <Button size="sm" variant="ghost" onClick={() => onCompare(v)}><Eye size={13} /> <Tx>Compare with live</Tx></Button>
                {canDo(role, 'edit') && <Button size="sm" variant="ghost" onClick={() => onDuplicate(v)}><Copy size={13} /> <Tx>Duplicate</Tx></Button>}
                {canDo(role, 'edit') && v.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => onDelete(v)}><Trash2 size={13} /></Button>}
                {canDo(role, 'deploy') && v.published_at && v.id !== liveId && <Button size="sm" variant="danger" onClick={() => onRollback(v)}><RotateCcw size={13} /> <Tx>Restore</Tx></Button>}
              </div></td>
            </tr>))}</tbody></table></div>
      )}
    </div>
  );
}
function DeploymentsPanel({ deploys, versions }: { deploys: Deployment[]; versions: LayoutVersion[] }) {
  const no = (id: string | null) => (id ? `v${versions.find((v) => v.id === id)?.version_no ?? '?'}` : '—');
  if (!deploys.length) return <Empty icon={<History size={22} />} title="No deployments yet" hint="Deploy an approved version to publish it to customers." />;
  return (
    <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>When</Tx></th><th><Tx>Action</Tx></th><th><Tx>Version</Tx></th><th><Tx>Result</Tx></th><th><Tx>By</Tx></th><th><Tx>Message</Tx></th></tr></thead>
      <tbody>{deploys.map((d) => (
        <tr key={d.id}><td className="muted">{dateTimeFmt(d.created_at)}</td><td><Tx>{d.action}</Tx></td><td>{no(d.from_version_id)} → <b>{no(d.version_id)}</b></td>
          <td>{d.status === 'succeeded' ? <Badge tone="good" dot><Tx>succeeded</Tx></Badge> : <Badge tone="bad" dot><Tx>failed</Tx></Badge>}{d.error && <div className="sub" style={{ color: 'var(--crit-text)' }}>{d.error}</div>}</td>
          <td className="muted">{d.actor_email ?? '—'}</td><td>{d.message ?? ''}</td></tr>))}</tbody></table></div>
  );
}
function TemplatesPanel({ templates, role, onUse, onSave, onDelete }: { templates: Template[]; role: AppRole; onUse: (t: Template) => void; onSave: (name: string, desc: string) => void; onDelete: (t: Template) => void }) {
  const [n, setN] = useState(''); const [d, setD] = useState('');
  return (
    <div className="col gap-12">
      {canDo(role, 'edit') && <div className="row gap-6 wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Template name"><Input sm value={n} maxLength={120} onChange={(e) => setN(e.target.value)} /></Field>
        <Field label="Description"><Input sm value={d} onChange={(e) => setD(e.target.value)} /></Field>
        <Button size="sm" disabled={!n.trim()} onClick={() => { onSave(n.trim(), d); setN(''); setD(''); }}><Save size={14} /> <Tx>Save current layout as template</Tx></Button>
      </div>}
      {!templates.length ? <Empty title="No templates yet" hint="Save a layout as a template to reuse it for another app or campaign." /> : (
        <div className="grid-3">{templates.map((t) => (
          <div key={t.id} className="card" style={{ padding: 12 }}>
            <b>{t.name}</b><div className="muted" style={{ fontSize: 12 }}>{t.description}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{t.created_by_email} · {dateTimeFmt(t.created_at)}</div>
            <div className="row gap-6 mt8">{canDo(role, 'edit') && <Button size="sm" onClick={() => onUse(t)}><Tx>Start a draft from this</Tx></Button>}{canDo(role, 'edit') && <Button size="sm" variant="ghost" onClick={() => onDelete(t)}><Trash2 size={13} /></Button>}</div>
          </div>))}</div>
      )}
    </div>
  );
}
function AccessPanel() {
  const lang = useLang();
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const load = () => devapp.staff().then(setRows).catch((e) => { toast('error', (e as Error).message); setRows([]); });
  useEffect(() => { load(); }, []);
  if (!rows) return <div className="spinner" />;
  return (
    <div className="col gap-8">
      <div className="muted" style={{ fontSize: 12.5 }}><Tx>Roles only grant access to DEV APP Customer — never to source code, the database or infrastructure. A SUPER_ADMIN always has full access.</Tx></div>
      <div className="table-wrap"><table className="t compact"><thead><tr><th><Tx>Employee</Tx></th><th><Tx>Account role</Tx></th><th><Tx>DEV APP role</Tx></th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.user_id}><td>{r.display_name || r.email}<div className="sub">{r.email}</div></td><td className="muted">{r.profile_role}</td>
            <td>{r.profile_role === 'SUPER_ADMIN' ? <Badge tone="good"><Tx>Administrator</Tx></Badge> : (
              <Select sm style={{ width: 'auto' }} value={r.app_role ?? ''} onChange={async (e) => {
                try { await devapp.setRole(r.user_id, (e.target.value || null) as AppRole | null); toast('success', 'Access updated'); load(); } catch (er) { toast('error', (er as Error).message); }
              }} aria-label={tl(lang, 'DEV APP role')}>
                <option value="">{tl(lang, 'No access')}</option>{ROLES.map((x) => <option key={x.v} value={x.v}>{x.label} — {x.desc}</option>)}
              </Select>)}</td></tr>))}</tbody></table></div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- modals
function CompareModal({ a, aLabel, b, bLabel, device: d0, memberId, onClose }: { a: LayoutConfig; aLabel: string; b: LayoutConfig; bLabel: string; device: Device; memberId: string; onClose: () => void }) {
  const [device, setDevice] = useState<Device>(d0);
  const changes = useMemo(() => diffLayouts(a, b), [a, b]);
  const fit = device === 'mobile' ? 390 : 520;
  return (
    <Modal size="xl" title="Preview & compare" desc="Left: what customers see now. Right: the layout you are working on." onClose={onClose}>
      <div className="seg mb8" role="tablist">{DEVICES.map((x) => <button key={x.v} type="button" role="tab" aria-selected={device === x.v} className={cx(device === x.v && 'on')} onClick={() => setDevice(x.v)}>{DEVICE_ICON[x.v]} <Tx>{x.label}</Tx></button>)}</div>
      <div className="row gap-16 wrap" style={{ alignItems: 'flex-start' }}>
        <PhonePreview config={a} device={device} customerId={memberId || null} fit={fit} height={720} label={aLabel} />
        <PhonePreview config={b} device={device} customerId={memberId || null} fit={fit} height={720} label={bLabel} />
        <div className="grow" style={{ minWidth: 220 }}>
          <b><Tx vars={{ n: changes.length }}>{'{n} change(s)'}</Tx></b>
          <div className="col gap-4 mt8" style={{ fontSize: 12.5, maxHeight: 640, overflow: 'auto' }}>{changes.length ? changes.map((c, i) => <div key={i} className="mono" style={{ wordBreak: 'break-word' }}>{c}</div>) : <span className="muted"><Tx>No differences.</Tx></span>}</div>
        </div>
      </div>
    </Modal>
  );
}
function DeployModal({ version, live, cfg, busy, onClose, onDeploy }: { version: LayoutVersion; live: LayoutVersion | null; cfg: LayoutConfig; busy: boolean; onClose: () => void; onDeploy: (msg: string) => void }) {
  const lang = useLang();
  const [msg, setMsg] = useState('');
  const changes = useMemo(() => (live ? diffLayouts(normalizeLayout(live.config), cfg) : []), [live, cfg]);
  return (
    <Modal title={tl(lang, 'Deploy v{n} to customers?', { n: version.version_no })} onClose={onClose}
      footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" loading={busy} disabled={busy} onClick={() => onDeploy(msg)}><Rocket size={15} /> <Tx>{busy ? 'Deploying…' : 'Deploy now'}</Tx></Button></>}>
      <div className="col gap-12">
        <Banner tone="warn"><Tx>Customers see this layout the next time they open the app. The current live version is kept and can be restored from the version history at any time.</Tx></Banner>
        <div><b><Tx>Live now</Tx>:</b> {live ? `v${live.version_no} — ${live.name}` : tl(lang, 'built-in layout')}<br /><b><Tx>New</Tx>:</b> v{version.version_no} — {version.name}</div>
        {live && <div><b><Tx vars={{ n: changes.length }}>{'{n} change(s)'}</Tx></b><div className="col gap-4 mt8 mono" style={{ fontSize: 12, maxHeight: 180, overflow: 'auto' }}>{changes.slice(0, 50).map((c, i) => <div key={i}>{c}</div>)}</div></div>}
        <Field label="Deployment note (optional)"><Input value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={200} /></Field>
      </div>
    </Modal>
  );
}

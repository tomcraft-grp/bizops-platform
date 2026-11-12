import { useMemo, useRef, useState } from 'react';
import { Activity, Download, Lock, Play, RotateCcw, Upload, UserPlus } from 'lucide-react';
import { act, exportBackup, importBackup, resetDemoData, toast, useDB, useStore } from '../domain/store';
import { MODULES, hasPerm } from '../domain/core';
import { runIntegrityChecks, runSelfTests, TestResult } from '../domain/integrity';
import { updateOrg } from '../domain/master';
import { Avatar, Badge, Banner, Button, Card, Check, DataTable, Empty, Field, Input, Kpi, Modal, NumInput, PageHead, Select, Tabs, useConfirm, useHas, useRun } from '../ui/kit';
import { dateTimeFmt, download, cx } from '../lib/util';
import type { ID, Role, User } from '../domain/types';
import { Gate } from '../ui/Shell';
import { audit } from '../domain/core';

// ================= Team & access =================
export function Team() {
  const db = useDB();
  const [tab, setTab] = useState<'users' | 'roles' | 'audit'>('users');
  return (
    <>
      <PageHead title="Team & access" desc="Role-based access with fine-grained permissions by module and action, plus branch scope and financial sensitivity. Switch user (top right) to feel the difference — e.g. a cashier cannot see cost or profit." />
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'users', label: 'Employees', count: db.users.length }, { v: 'roles', label: 'Roles & permissions', count: db.roles.length }, { v: 'audit', label: 'Audit log', count: db.audit.length }]} />
      {tab === 'users' && <Users />}
      {tab === 'roles' && <Roles />}
      {tab === 'audit' && <Audit />}
    </>
  );
}
function Users() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('team:edit');
  const [add, setAdd] = useState(false);
  return (
    <Card flush>
      <DataTable rows={db.users} rowKey={(u) => u.id} toolbar={canEdit && <Button size="sm" variant="primary" onClick={() => setAdd(true)}><UserPlus size={14} /> Add employee</Button>}
        cols={[
          { key: 'n', header: 'Employee', render: (u) => <div className="row"><Avatar name={u.name} color={u.color} /><div><b>{u.name}</b><div className="sub">{u.email}</div></div></div> },
          { key: 'r', header: 'Role', render: (u) => canEdit ? <Select sm style={{ width: 200 }} value={u.roleId} onChange={(e) => run((d, c) => { const x = d.users.find((y) => y.id === u.id)!; x.roleId = e.target.value; audit(d, c, 'team.role', 'user', u.id, `Role of ${x.name} → ${e.target.value}`, 'warn'); }, { ok: 'Role updated (audited)', perm: 'team:edit' })}>{db.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select> : db.roles.find((r) => r.id === u.roleId)?.name },
          { key: 'b', header: 'Branch scope', render: (u) => (u.branchIds.length ? u.branchIds.map((b) => db.branches.find((x) => x.id === b)?.name).join(', ') : <span className="muted">all branches</span>) },
          { key: 's', header: 'Status', render: (u) => (u.id === db.meta.currentUserId ? <Badge tone="info">you</Badge> : <Badge tone={u.active ? 'good' : ''} dot>{u.active ? 'active' : 'disabled'}</Badge>) },
          { key: 'a', header: '', render: (u) => canEdit && u.id !== db.meta.currentUserId && <Button size="sm" variant="ghost" onClick={() => run((d) => { const x = d.users.find((y) => y.id === u.id)!; x.active = !x.active; }, { ok: u.active ? 'Disabled' : 'Enabled' })}>{u.active ? 'Disable' : 'Enable'}</Button> },
        ]} />
      {add && <AddUser onClose={() => setAdd(false)} />}
    </Card>
  );
}
function AddUser({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const run = useRun();
  const [f, setF] = useState({ name: '', email: '', roleId: 'role-cashier', branchId: '' });
  return (
    <Modal title="Add employee" size="sm" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name || !f.email} onClick={() => run((d, c) => { d.users.push({ id: 'U' + (d.users.length + 1), name: f.name, email: f.email, roleId: f.roleId, branchIds: f.branchId ? [f.branchId] : [], active: true, color: '#2a78d6' }); }, { ok: 'Employee added', perm: 'team:edit', onOk: onClose })}>Add</Button></>}>
      <div className="col"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{db.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        <Field label="Branch scope"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All branches</option>{db.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field></div>
    </Modal>
  );
}

function Roles() {
  const db = useDB();
  const run = useRun();
  const canEdit = useHas('team:edit');
  const [rid, setRid] = useState<ID>(db.roles[1].id);
  const role = db.roles.find((r) => r.id === rid)!;
  const all = role.permissions.includes('*');
  const actions = Array.from(new Set(MODULES.flatMap((m) => m.actions)));
  const toggle = (mod: string, action: string, modActions: string[]) => run((d, c) => {
    const r = d.roles.find((x) => x.id === rid)!;
    const p = `${mod}:${action}`;
    const has = hasPerm(r.permissions, p);
    if (has) {
      if (r.permissions.includes(`${mod}:*`)) r.permissions = [...r.permissions.filter((x) => x !== `${mod}:*`), ...modActions.filter((a) => a !== action).map((a) => `${mod}:${a}`)];
      else r.permissions = r.permissions.filter((x) => x !== p);
    } else r.permissions = [...r.permissions, p];
    audit(d, c, 'team.permission', 'role', r.id, `${r.name}: ${p} ${has ? 'revoked' : 'granted'}`, 'warn');
  }, { perm: 'team:edit', ok: 'Permission updated (audited)' });
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,220px) minmax(0,1fr)', gap: 16 }}>
      <Card flush><div className="col gap-4" style={{ padding: 8 }}>{db.roles.map((r) => <button key={r.id} className={cx('menu-item', r.id === rid && 'on')} onClick={() => setRid(r.id)}><div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{db.users.filter((u) => u.roleId === r.id).length} employee(s)</div></div></button>)}</div></Card>
      <Card title={role.name} sub={role.description}>
        {all && <Banner tone="info"><Lock size={14} style={{ verticalAlign: -2 }} /> Owner has every permission and cannot be restricted.</Banner>}
        <div className="table-wrap mt8" role="region" aria-label="Scrollable table" tabIndex={0}><table className="t compact"><thead><tr><th>Module</th>{actions.map((a) => <th key={a} className="center">{a}</th>)}</tr></thead>
          <tbody>{MODULES.map((m) => <tr key={m.key}><td><b>{m.label}</b></td>{actions.map((a) => <td key={a} className="center">{m.actions.includes(a) ? <input type="checkbox" aria-label={`${m.label} ${a}`} checked={hasPerm(role.permissions, `${m.key}:${a}`)} disabled={all || !canEdit} onChange={() => toggle(m.key, a, m.actions)} /> : ''}</td>)}</tr>)}</tbody></table></div>
        <div className="muted mt8" style={{ fontSize: 12.5 }}>“finance: cost / profit” controls financial sensitivity — without them product cost, margins and profit are hidden everywhere. Changes apply immediately and are written to the audit log.</div>
      </Card>
    </div>
  );
}

function Audit() {
  const db = useDB();
  const [sev, setSev] = useState('');
  const rows = useMemo(() => db.audit.slice().reverse().filter((a) => !sev || a.severity === sev), [db.audit, sev]);
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(a) => a.id} pageSize={14} search={(a) => `${a.action} ${a.detail} ${db.users.find((u) => u.id === a.userId)?.name}`} empty={<Empty title="No audit entries yet" hint="Sensitive actions (voids, reversals, manual journals, resets, permission changes) are recorded here." />}
        toolbar={<Select sm style={{ width: 'auto' }} value={sev} onChange={(e) => setSev(e.target.value)}><option value="">All severities</option><option value="info">Info</option><option value="warn">Warning</option><option value="critical">Critical</option></Select>}
        cols={[{ key: 't', header: 'When', render: (a) => dateTimeFmt(a.ts) }, { key: 'u', header: 'User', render: (a) => db.users.find((u) => u.id === a.userId)?.name ?? a.userId }, { key: 'a', header: 'Action', render: (a) => <span className="mono">{a.action}</span> }, { key: 's', header: '', render: (a) => <Badge tone={a.severity === 'critical' ? 'bad' : a.severity === 'warn' ? 'warn' : ''}>{a.severity}</Badge> }, { key: 'd', header: 'Detail', render: (a) => a.detail }]} />
    </Card>
  );
}

// ================= Settings =================
export function SettingsPage() {
  return <Gate perm="settings:view"><SettingsInner /></Gate>;
}
function SettingsInner() {
  const db = useDB();
  const run = useRun();
  const confirm = useConfirm();
  const canEdit = useHas('settings:edit');
  const file = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ name: db.org.name, legalName: db.org.legalName, taxId: db.org.taxId, address: db.org.address, phone: db.org.phone, vatRegistered: db.org.vatRegistered, promptPayId: db.org.promptPayId, allowNegativeStock: db.org.allowNegativeStock, allocateOpex: db.org.allocateOpex });
  return (
    <>
      <PageHead title="Settings" desc="Organization, tax, costing and data controls. Critical settings are restricted to Owners and every change is audited." />
      <div className="grid g2">
        <Card title="Organization & tax">
          <div className="form-grid">
            <Field label="Trading name"><Input value={f.name} disabled={!canEdit} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Legal name"><Input value={f.legalName} disabled={!canEdit} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
            <Field label="Tax ID"><Input value={f.taxId} disabled={!canEdit} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field><Field label="Phone"><Input value={f.phone} disabled={!canEdit} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Address" full><Input value={f.address} disabled={!canEdit} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            <Field label="PromptPay ID (phone / tax ID)"><Input value={f.promptPayId} disabled={!canEdit} onChange={(e) => setF({ ...f, promptPayId: e.target.value })} /></Field>
            <div className="full"><Check checked={f.vatRegistered} onChange={(v) => canEdit && setF({ ...f, vatRegistered: v })}>VAT-registered (prices include VAT; output VAT is posted)</Check></div>
          </div>
          <div className="mt16"><Button variant="primary" disabled={!canEdit} onClick={() => run((d, c) => updateOrg(d, c, { name: f.name, legalName: f.legalName, taxId: f.taxId, address: f.address, phone: f.phone, vatRegistered: f.vatRegistered, promptPayId: f.promptPayId }), { ok: 'Saved (audited). VAT changes apply to new orders only.', perm: 'settings:edit' })}>Save</Button></div>
        </Card>
        <Card title="Costing & inventory policy">
          <div className="col">
            <Field label="Costing method" hint="Weighted average is active. FIFO cost layers are on the roadmap (see Blueprint)."><Select value="WAC" disabled><option value="WAC">Weighted average cost (per product & warehouse)</option></Select></Field>
            <Check checked={f.allowNegativeStock} onChange={(v) => canEdit && setF({ ...f, allowNegativeStock: v })}>Allow selling below zero stock (not recommended)</Check>
            <Field label="Operating-expense allocation in Profit engine"><Select value={f.allocateOpex} disabled={!canEdit} onChange={(e) => setF({ ...f, allocateOpex: e.target.value as 'none' | 'revenue' })}><option value="none">Report at business level only</option><option value="revenue">Allocate by revenue share</option></Select></Field>
            <div><Button variant="primary" disabled={!canEdit} onClick={() => run((d, c) => updateOrg(d, c, { allowNegativeStock: f.allowNegativeStock, allocateOpex: f.allocateOpex }), { ok: 'Policy saved (audited)', perm: 'settings:edit' })}>Save policy</Button></div>
          </div>
        </Card>
        <Card title="Branches & warehouses" flush><table className="t compact"><thead><tr><th>Branch</th><th>Type</th><th>Default warehouse</th></tr></thead><tbody>{db.branches.map((b) => <tr key={b.id}><td><b>{b.name}</b><div className="sub">{b.address}</div></td><td>{b.type}</td><td>{db.warehouses.find((w) => w.id === b.defaultWarehouseId)?.name}</td></tr>)}</tbody></table></Card>
        <Card title="Data & backup">
          <div className="col">
            <div className="muted">All demo data lives in your browser (IndexedDB). Nothing is sent anywhere.</div>
            <div className="row wrap">
              <Button onClick={() => download(`bizops-backup-${new Date().toISOString().slice(0, 10)}.json`, exportBackup(), 'application/json')}><Download size={15} /> Export backup</Button>
              <input ref={file} type="file" accept="application/json" hidden onChange={async (e) => { const fl = e.target.files?.[0]; e.target.value = ''; if (!fl) return; try { await importBackup(await fl.text()); toast('success', 'Backup restored'); } catch (err) { toast('error', (err as Error).message); } }} />
              <Button onClick={() => file.current?.click()}><Upload size={15} /> Restore backup</Button>
              <Button variant="danger" onClick={async () => { const x = await confirm({ title: 'Reset all demo data?', body: 'Everything you created is deleted and the demo business is regenerated from scratch.', typeToConfirm: 'RESET', danger: true, confirmLabel: 'Reset data' }); if (x.ok) { await resetDemoData(); toast('success', 'Demo data regenerated'); } }}><RotateCcw size={15} /> Reset demo data</Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

// ================= System health =================
export function Health() {
  return <Gate perm="system:view"><HealthInner /></Gate>;
}
function HealthInner() {
  const db = useDB();
  const seedErrors = useStore((s) => s.seedErrors);
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const checks = useMemo(() => runIntegrityChecks(db, new Date().toISOString()), [db]);
  const bad = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  return (
    <>
      <PageHead title="System health & integrity" desc="Continuous reconciliation of the ledgers (stock, journal, points, receivables, events) plus executable concurrency tests — the invariants the production database must enforce." actions={<Button variant="primary" onClick={() => setTests(runSelfTests(db, { now: new Date().toISOString(), userId: db.meta.currentUserId }))}><Play size={15} /> Run concurrency self-tests</Button>} />
      <div className="grid g4 mb16">
        <Kpi label="Checks passing" value={`${checks.length - bad - warn}/${checks.length}`} tone={bad ? 'bad' : 'good'} sub={`${warn} warning(s) · ${bad} failing`} />
        <Kpi label="Journals" value={db.journals.length.toLocaleString()} sub="all balanced" />
        <Kpi label="Stock movements" value={db.movements.length.toLocaleString()} sub="append-only" />
        <Kpi label="Audit entries" value={db.audit.length.toLocaleString()} sub={`${db.audit.filter((a) => a.severity === 'critical').length} critical`} />
      </div>
      <div className="col gap-16">
        {tests && (
          <Card title="Concurrency & idempotency self-tests" sub="Run on a throw-away copy of the data — nothing is changed.">
            <div className="col">{tests.map((t) => <div key={t.id} className="row between top card card-b" style={{ background: 'var(--surface-2)' }}><div><b>{t.title}</b><div className="muted" style={{ fontSize: 12.5 }}>Expect: {t.expectation}</div><div style={{ fontSize: 13 }}>{t.detail}</div></div><Badge tone={t.passed ? 'good' : 'bad'} dot>{t.passed ? 'PASS' : 'FAIL'}</Badge></div>)}</div>
            <div className="muted mt8" style={{ fontSize: 12 }}>In production these guarantees come from database constraints, row locks and idempotency keys — not from application code alone.</div>
          </Card>
        )}
        <Card title="Reconciliation checks" flush>
          <table className="t"><thead><tr><th>Check</th><th>Result</th><th /></tr></thead>
            <tbody>{checks.map((c) => <tr key={c.id}><td><b>{c.title}</b><div className="sub">{c.what}</div></td><td>{c.detail}{c.evidence?.length ? <div className="sub bad">{c.evidence.join(' · ')}</div> : null}</td><td><Badge tone={c.status === 'pass' ? 'good' : c.status === 'warn' ? 'warn' : 'bad'} dot>{c.status}</Badge></td></tr>)}</tbody></table>
        </Card>
        {seedErrors.length > 0 && <Banner tone="warn">{seedErrors.length} demo-data generation warning(s): {seedErrors.slice(0, 2).join(' · ')}</Banner>}
      </div>
    </>
  );
}
export const _ad = [Activity, act];

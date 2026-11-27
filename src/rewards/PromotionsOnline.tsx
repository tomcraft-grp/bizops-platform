// Promotions > "Online shop": the master switch, the rules (points and per-bill number picks), the promotion packs and a "try it" simulator.
// Everything here talks to the server (src/rewards/api.ts); nothing is kept in this browser. What a role may do is enforced by the database on every call:
// the permission checks in this file (Super Admin for the master switch, Admin for the rest) only decide what is offered and what is greyed out.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, NumInput, PageHead, Seg, Skeleton, Tabs, Tx } from '../ui/kit';
import { cx } from '../lib/util';
import { shopAdmin } from '../shop/api';
import { rewards, rewardsAdmin, type CartItem, type Pack, type RewardsSettings, type Rule, type RuleKind, type SimLine } from './api';
import { PackEditor } from './PackEditor';
import TransfersPanel from './TransfersPanel';
import { baht, RuleEditor, SkuChip, SkuSearch, useSkuInfo, useT } from './RuleEditor';
import { rewardsErrorMessage, ruleSentences, ruleToForm, simulateAmount, toBangkokDate, type Msg, type RuleTemplate } from './ruleForm';

// ------------------------------------------------------------------------------------------------ loading
interface Load<T> { data: T | null; error: Msg | null; loading: boolean; reload: () => void }
/** Runs `fn` on mount and on `reload()`. `fn` must be a stable reference (the api wrappers are). The newest answer wins. */
function useLoad<T>(fn: () => Promise<T>): Load<T> {
  const [st, setSt] = useState<{ data: T | null; error: Msg | null; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    setSt((s) => ({ ...s, loading: true }));
    fn().then((d) => { if (n === seq.current) setSt({ data: d, error: null, loading: false }); })
      .catch((e) => { if (n === seq.current) setSt((s) => ({ data: s.data, error: rewardsErrorMessage(e), loading: false })); });
  }, [fn]);
  useEffect(() => { load(); return () => { seq.current = -1; }; }, [load]);
  return { ...st, reload: load };
}

/** The kit's on/off switch, plus `disabled` (the kit one cannot be greyed out). A disabled switch is only a hint about the role: the server refuses the call anyway. */
function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const { T } = useT();
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={T(label)} title={T(label)} disabled={disabled} className={cx('switch', checked && 'on')}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(!checked); }}><i /></button>
  );
}

const rewardText = (T: (s: string, v?: Record<string, string | number>) => string, kind: RuleKind, n: number) => T(kind === 'points' ? (n === 1 ? '{n} point' : '{n} points') : (n === 1 ? '{n} pick' : '{n} picks'), { n });

// ================================================================================================ page
export default function PromotionsOnline() {
  const { profile } = useAuth();
  const role = profile?.role;
  const canEdit = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isSuper = role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<'rules' | 'packs' | 'try' | 'transfers'>('rules');
  const [ruleEdit, setRuleEdit] = useState<{ rule: Rule | null; template?: RuleTemplate } | null>(null);
  const [packEdit, setPackEdit] = useState<{ pack: Pack | null } | null>(null);
  const settings = useLoad(rewards.settings);
  const rules = useLoad(rewardsAdmin.rules);
  const packs = useLoad(rewardsAdmin.packs);
  const events = useLoad(rewardsAdmin.events);
  const cats = useLoad(shopAdmin.categories);

  return (
    <>
      <PageHead title="Promotions" desc="Points, number picks and promotion packs for customers of the online shop. Nothing changes for customers until the master switch is on."
        actions={canEdit && tab !== 'try' && tab !== 'transfers' && (tab === 'rules'
          ? <Button variant="primary" onClick={() => setRuleEdit({ rule: null })}><Plus size={15} />{' '}<Tx>New rule</Tx></Button>
          : <Button variant="primary" onClick={() => setPackEdit({ pack: null })}><Plus size={15} />{' '}<Tx>New pack</Tx></Button>)} />
      <MasterSwitch load={settings} isSuper={isSuper} />
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'rules', label: 'Rules', count: rules.data?.length }, { v: 'packs', label: 'Promotion packs', count: packs.data?.length }, { v: 'transfers', label: 'Point transfers' }, { v: 'try', label: 'Try it' }]} />
      {tab === 'rules' && <RulesPanel load={rules} events={events.data ?? []} canEdit={canEdit} onNew={(template) => setRuleEdit({ rule: null, template })} onEdit={(rule) => setRuleEdit({ rule })} />}
      {tab === 'packs' && <PacksPanel load={packs} canEdit={canEdit} onNew={() => setPackEdit({ pack: null })} onEdit={(pack) => setPackEdit({ pack })} />}
      {tab === 'try' && <TryPanel rules={rules} />}
      {tab === 'transfers' && <TransfersPanel isSuper={isSuper} />}
      {ruleEdit && <RuleEditor rule={ruleEdit.rule} template={ruleEdit.template} events={events.data ?? []} eventsFailed={!!events.error && !events.data} categories={cats.data ?? []} categoriesFailed={!!cats.error && !cats.data}
        onClose={() => setRuleEdit(null)} onSaved={() => { setRuleEdit(null); rules.reload(); }} />}
      {packEdit && <PackEditor pack={packEdit.pack} onClose={() => setPackEdit(null)} onSaved={() => { setPackEdit(null); packs.reload(); }} />}
    </>
  );
}

// ================================================================================================ master switch
function MasterSwitch({ load, isSuper }: { load: Load<RewardsSettings>; isSuper: boolean }) {
  const { T, say } = useT();
  const [local, setLocal] = useState<RewardsSettings | null>(null);
  const [confirming, setConfirming] = useState<keyof RewardsSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const s = local ?? load.data;
  useEffect(() => { if (load.data) setLocal(null); }, [load.data]);

  const apply = async (key: keyof RewardsSettings, value: boolean) => {
    setBusy(true);
    try {
      const saved = await rewardsAdmin.saveSettings({ [key]: value });
      setLocal(saved); setConfirming(null);
      toast('success', T(value ? 'Switched on' : 'Switched off'));
    } catch (e) { toast('error', say(rewardsErrorMessage(e))); } finally { setBusy(false); }
  };
  // Turning something OFF is one click (it only stops new rewards). Turning it ON asks once, inline, because customers will see it.
  const flip = (key: keyof RewardsSettings, next: boolean) => { if (next) setConfirming(key); else void apply(key, false); };

  const row = (key: keyof RewardsSettings, title: string, body: string) => (
    <div className="row top" style={{ gap: 12 }}>
      <Toggle checked={!!s?.[key]} label={title} disabled={!isSuper || busy} onChange={(v) => flip(key, v)} />
      <div className="grow">
        <div className="row wrap" style={{ gap: 8 }}><b><Tx>{title}</Tx></b><Badge tone={s?.[key] ? 'good' : ''} dot>{s?.[key] ? 'On' : 'Off'}</Badge></div>
        <div className="muted" style={{ fontSize: 12.5 }}><Tx>{body}</Tx></div>
        {confirming === key && (
          <div className="mt8"><Banner tone="warn">
            <div className="col" style={{ gap: 8 }}>
              <div><Tx>{key === 'enabled' ? 'Switch on for every customer? From now on, paid bills that fit an active rule earn rewards. Bills paid before a rule was created do not earn.' : 'Let customers pick numbers on the event boards?'}</Tx></div>
              <div className="row"><Button variant="primary" size="sm" disabled={busy} onClick={() => void apply(key, true)}><Tx>Yes, switch on</Tx></Button><Button size="sm" onClick={() => setConfirming(null)}><Tx>Cancel</Tx></Button></div>
            </div>
          </Banner></div>
        )}
      </div>
    </div>
  );

  return (
    <div className="mb16">
      <Card title="Master switch" sub="Off = nothing changes for customers: no points, no picks, nothing extra on their screens.">
        {load.loading && !s ? <Skeleton h={64} /> : !s ? (
          <div className="col" style={{ gap: 8 }}>
            <Banner tone="bad">{load.error ? say(load.error) : T('Could not read the master switch.')}</Banner>
            <div><Button size="sm" onClick={load.reload}><RefreshCw size={14} />{' '}<Tx>Try again</Tx></Button></div>
          </div>
        ) : (
          <div className="col" style={{ gap: 14 }}>
            {row('enabled', 'Points and number picks', 'Customers earn from paid bills, following the rules below.')}
            {row('boards_enabled', 'Event boards', 'Customers can use their picks on the event boards.')}
            {!isSuper && <div className="muted" style={{ fontSize: 12.5 }}><Tx>Only a Super Admin can change the master switch.</Tx></div>}
          </div>
        )}
      </Card>
    </div>
  );
}

// ================================================================================================ rules
function RulesPanel({ load, events, canEdit, onNew, onEdit }: { load: Load<Rule[]>; events: { id: string; name: string }[]; canEdit: boolean; onNew: (t: RuleTemplate) => void; onEdit: (r: Rule) => void }) {
  const { T, say } = useT();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rows, setRows] = useState<Rule[] | null>(null);
  useEffect(() => { setRows(load.data); }, [load.data]);

  const toggle = async (r: Rule, active: boolean) => {
    setBusyId(r.id);
    try {
      const saved = await rewardsAdmin.setRuleActive(r.id, active);
      setRows((x) => (x ? x.map((y) => (y.id === saved.id ? saved : y)) : x));
      toast('success', T(active ? 'Rule switched on' : 'Rule switched off'));
    } catch (e) { toast('error', say(rewardsErrorMessage(e))); } finally { setBusyId(null); }
  };

  if (load.error && !rows) return <div className="col" style={{ gap: 8 }}><Banner tone="bad">{say(load.error)}</Banner><div><Button size="sm" onClick={load.reload}><RefreshCw size={14} />{' '}<Tx>Try again</Tx></Button></div></div>;
  if (!rows) return <Skeleton h={160} />;

  const scope = (r: Rule): string[] => {
    const out: string[] = [];
    if (r.category_codes.length) out.push(T('Categories: {n}', { n: r.category_codes.length }));
    if (r.include_skus.length) out.push(T('Products: {n}', { n: r.include_skus.length }));
    if (r.exclude_skus.length) out.push(T('Excluding: {n}', { n: r.exclude_skus.length }));
    if (r.include_packs) out.push(T('Packs count'));
    if (r.only_profile_ids?.length) out.push(T('Customers: {n}', { n: r.only_profile_ids.length }));
    return out;
  };
  return (
    <Card flush>
      {load.error && <div style={{ padding: 12 }}><Banner tone="warn">{say(load.error)}</Banner></div>}
      <DataTable rows={rows} rowKey={(r) => r.id} pageSize={12} search={(r) => r.name} onRow={canEdit ? onEdit : undefined}
        empty={<Empty title="No rules yet" hint="Start from one of the two templates. The common values are filled in for you."
          action={canEdit ? <div className="row wrap" style={{ justifyContent: 'center' }}><Button variant="primary" onClick={() => onNew('board_pick')}><Tx>Number picks per bill</Tx></Button><Button onClick={() => onNew('points')}><Tx>Points per baht spent</Tx></Button></div> : undefined} />}
        cols={[
          { key: 'n', header: 'Rule', sort: (r) => r.name, render: (r) => <><b>{r.name}</b><div className="sub">{ruleSentences(ruleToForm(r)).slice(0, 1).map(say)}</div></> },
          { key: 'k', header: 'Type', render: (r) => <><Badge tone={r.kind === 'board_pick' ? 'info' : 'good'}>{r.kind === 'board_pick' ? 'Number picks' : 'Points'}</Badge>{r.kind === 'board_pick' && <div className="sub">{events.find((e) => e.id === r.event_id)?.name ?? ''}</div>}</> },
          { key: 'c', header: 'What counts', hideSm: true, render: (r) => { const sc = scope(r); return sc.length ? <div className="row wrap" style={{ gap: 4 }}>{sc.map((x) => <span key={x} className="chip">{x}</span>)}</div> : <span className="muted"><Tx>Everything</Tx></span>; } },
          { key: 'w', header: 'When', hideSm: true, render: (r) => (r.starts_at && r.ends_at ? <>{toBangkokDate(r.starts_at)} → {toBangkokDate(r.ends_at)}</> : r.starts_at ? T('From {date}', { date: toBangkokDate(r.starts_at) }) : r.ends_at ? T('Until {date}', { date: toBangkokDate(r.ends_at) }) : <span className="muted"><Tx>Always</Tx></span>) },
          { key: 'u', header: 'Given so far', num: true, sort: (r) => r.stats.granted, render: (r) => <>{rewardText(T, r.kind, r.stats.granted)}<div className="sub">{T('{n} bills', { n: r.stats.bills })}</div></> },
          { key: 'a', header: 'Active', render: (r) => <div className="row" style={{ gap: 8 }}><Toggle checked={r.active} label={`${T('Active')}: ${r.name}`} disabled={!canEdit || busyId === r.id} onChange={(v) => void toggle(r, v)} />{canEdit && <Button size="sm" onClick={(e) => { e.stopPropagation(); onEdit(r); }}><Tx>Edit</Tx></Button>}</div> },
        ]} />
    </Card>
  );
}

// ================================================================================================ packs
function PacksPanel({ load, canEdit, onNew, onEdit }: { load: Load<Pack[]>; canEdit: boolean; onNew: () => void; onEdit: (p: Pack) => void }) {
  const { T, say } = useT();
  const [rows, setRows] = useState<Pack[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setRows(load.data); }, [load.data]);
  const toggle = async (p: Pack, active: boolean) => {
    setBusy(p.pack_sku_code);
    try {
      const saved = await rewardsAdmin.savePack(p.pack_sku_code, { active });
      setRows((x) => (x ? x.map((y) => (y.pack_sku_code === saved.pack_sku_code ? saved : y)) : x));
      toast('success', T(active ? 'Pack switched on' : 'Pack switched off'));
    } catch (e) { toast('error', say(rewardsErrorMessage(e))); } finally { setBusy(null); }
  };
  if (load.error && !rows) return <div className="col" style={{ gap: 8 }}><Banner tone="bad">{say(load.error)}</Banner><div><Button size="sm" onClick={load.reload}><RefreshCw size={14} />{' '}<Tx>Try again</Tx></Button></div></div>;
  if (!rows) return <Skeleton h={160} />;
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(p) => p.pack_sku_code} pageSize={12} search={(p) => `${p.name} ${p.pack_sku_code}`} onRow={canEdit ? onEdit : undefined}
        empty={<Empty title="No packs yet" hint="A pack is one product with its own price that stands for several products, like 4 bottles for ฿300."
          action={canEdit ? <Button variant="primary" onClick={onNew}><Tx>New pack</Tx></Button> : undefined} />}
        cols={[
          { key: 'n', header: 'Pack', sort: (p) => p.name, render: (p) => <><b>{p.name}</b><div className="sub mono">{p.pack_sku_code}</div></> },
          { key: 'p', header: 'Price', num: true, sort: (p) => Number(p.price), render: (p) => baht(Number(p.price)) },
          { key: 'i', header: 'Inside one pack', hideSm: true, render: (p) => <div className="col" style={{ gap: 2 }}>{p.items.map((i) => <div key={i.sku_code}>{i.qty} × {i.name}{i.status === 'inactive' && <> <Badge tone="bad">Inactive</Badge></>}</div>)}</div> },
          { key: 'pt', header: 'Points per pack', num: true, hideSm: true, render: (p) => (p.points_per_pack == null ? <span className="muted">—</span> : p.points_per_pack) },
          { key: 'e', header: 'Eligible value', num: true, hideSm: true, render: (p) => (p.eligible_value == null ? <span className="muted">—</span> : baht(Number(p.eligible_value))) },
          { key: 's', header: 'Sold', num: true, sort: (p) => p.sold_packs, render: (p) => <>{p.sold_packs}{p.sold_packs > 0 && <div className="sub"><Tx>Contents locked</Tx></div>}</> },
          { key: 'a', header: 'On sale', render: (p) => <div className="row" style={{ gap: 8 }}><Toggle checked={p.active} label={`${T('On sale')}: ${p.name}`} disabled={!canEdit || busy === p.pack_sku_code} onChange={(v) => void toggle(p, v)} />{p.status === 'inactive' && <Badge tone="bad">Inactive</Badge>}{canEdit && <Button size="sm" onClick={(e) => { e.stopPropagation(); onEdit(p); }}><Tx>Edit</Tx></Button>}</div> },
        ]} />
    </Card>
  );
}

// ================================================================================================ try it
function SimTable({ lines }: { lines: SimLine[] }) {
  const { T } = useT();
  if (!lines.length) return <Empty title="No rule applies" hint="No active rule counts this cart." />;
  return (
    <DataTable rows={lines} rowKey={(l) => l.rule_id} pageSize={20} compact
      cols={[
        { key: 'r', header: 'Rule', render: (l) => <><b>{l.rule_name}</b>{l.note && <div className="sub">{T(l.note)}</div>}</> },
        { key: 'e', header: 'Counts', num: true, render: (l) => baht(Number(l.eligible_amount)) },
        { key: 'w', header: 'Earns', num: true, render: (l) => <b className={l.reward > 0 ? 'good' : 'muted'}>{rewardText(T, l.kind, l.reward)}</b> },
        { key: 'x', header: 'Next reward', num: true, render: (l) => (l.next_reward_in == null ? <span className="muted">—</span> : T('฿{x} more', { x: l.next_reward_in })) },
      ]} />
  );
}

function TryPanel({ rules }: { rules: Load<Rule[]> }) {
  const { say } = useT();
  const [mode, setMode] = useState<'amount' | 'cart'>('amount');
  return (
    <div className="col" style={{ gap: 12 }}>
      <Seg value={mode} onChange={setMode} options={[{ v: 'amount', label: 'A bill amount' }, { v: 'cart', label: 'A cart' }]} />
      {mode === 'amount' ? <AmountTry rules={rules.data ?? []} loading={rules.loading && !rules.data} error={rules.error ? say(rules.error) : null} /> : <CartTry />}
    </div>
  );
}

function AmountTry({ rules, loading, error }: { rules: Rule[]; loading: boolean; error: string | null }) {
  const [amount, setAmount] = useState<number | ''>(850);
  const lines = useMemo(() => simulateAmount(rules, typeof amount === 'number' && amount >= 0 ? amount : 0), [rules, amount]);
  return (
    <div className="grid g2">
      <Card title="One bill" sub="What would a single bill of this amount earn? Every rule is worked out on its own: bills are never added together.">
        <Field label="Bill amount (฿)"><NumInput value={amount} min={0} onChange={(n) => setAmount(isNaN(n) ? '' : n)} /></Field>
        <div className="muted mt8" style={{ fontSize: 12.5 }}><Tx>Assumes every item on the bill counts. To test a rule that only counts some products, try a cart.</Tx></div>
      </Card>
      <Card title="Result" flush>
        {error ? <div style={{ padding: 12 }}><Banner tone="bad">{error}</Banner></div> : loading ? <Skeleton h={80} /> : typeof amount !== 'number' ? <Empty title="Enter an amount" /> : <SimTable lines={lines} />}
      </Card>
    </div>
  );
}

function CartTry() {
  const { T, say } = useT();
  const [items, setItems] = useState<CartItem[]>([]);
  const [lines, setLines] = useState<SimLine[] | null>(null);
  const [err, setErr] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const { info, remember } = useSkuInfo();
  const seq = useRef(0);
  const valid = items.length > 0 && items.every((i) => Number.isInteger(i.qty) && i.qty >= 1);
  useEffect(() => {
    const n = ++seq.current;
    if (!valid) { setLines(null); setErr(null); setBusy(false); return; }
    setBusy(true);
    const h = setTimeout(() => {
      rewardsAdmin.simulate(items)
        .then((r) => { if (n === seq.current) { setLines(r); setErr(null); } })
        .catch((e) => { if (n === seq.current) { setErr(rewardsErrorMessage(e)); setLines(null); } })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 300);
    return () => clearTimeout(h);
  }, [items, valid]);
  const total = items.reduce((s, i) => s + (info[i.sku_code]?.price ?? 0) * (Number.isInteger(i.qty) ? i.qty : 0), 0);
  return (
    <div className="grid g2">
      <Card title="Cart" sub="Add products or packs. The server works out what this cart would earn once it is paid.">
        <div className="col" style={{ gap: 10 }}>
          {items.map((it) => (
            <div key={it.sku_code} className="row">
              <div className="grow" style={{ minWidth: 0 }}><SkuChip code={it.sku_code} info={info[it.sku_code]} /></div>
              <NumInput style={{ width: 84 }} aria-label={`${T('Quantity of')} ${it.sku_code}`} value={Number.isNaN(it.qty) ? '' : it.qty} min={1} step={1}
                onChange={(n) => setItems(items.map((x) => (x.sku_code === it.sku_code ? { ...x, qty: n } : x)))} />
              <Button variant="ghost" size="sm" onClick={() => setItems(items.filter((x) => x.sku_code !== it.sku_code))}><Tx>Remove</Tx></Button>
            </div>
          ))}
          <SkuSearch label="Search products to add to the cart" remember={remember}
            why={(h) => (h.status !== 'active' ? 'Inactive: cannot be added' : items.some((i) => i.sku_code === h.sku_code) ? 'Already added' : null)}
            onPick={(h) => setItems([...items, { sku_code: h.sku_code, qty: 1 }])} />
          {total > 0 && <div className="row between"><span className="muted"><Tx>Cart total</Tx></span><b>{baht(total)}</b></div>}
        </div>
      </Card>
      <Card title="Result" flush>
        {err ? <div style={{ padding: 12 }}><Banner tone="bad">{say(err)}</Banner></div>
          : !valid ? <Empty title="Nothing to test yet" hint="Add a product to see what the cart would earn." />
            : busy || !lines ? <div style={{ padding: 12 }}><Skeleton h={80} /></div> : <SimTable lines={lines} />}
      </Card>
    </div>
  );
}

// The "New rule / Edit rule" form of Promotions > Online shop, and the SKU search the rule, pack and simulator forms share.
// A new rule starts from one of two templates with the common values filled in (step 300, 1 reward, per bill) and counts from now on (never back in time unless
// staff pick an earlier day); only the fields that matter are shown, the rest sits under "Advanced options". A rule that has already given rewards is read-only
// except its name, on/off and a later end date; "Duplicate" makes an editable copy. Everything checked here is also checked by the server (rw_admin_save_rule); this form only saves a round trip.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { money, money0 } from '../lib/util';
import { Badge, Banner, Button, Check, Field, Input, Modal, NumInput, Seg, Select, Tx } from '../ui/kit';
import type { AdminCategory } from '../shop/api';
import { rewardsAdmin, type CustomerHit, type EventDoc, type Rule, type SkuHit } from './api';
import {
  addToList, customerLabel, duplicateRuleForm, formToPatch, isRuleUsedError, newRuleForm, rewardsErrorMessage, ruleIsUsed, ruleSentences, ruleToForm, toBangkokDate, todayBangkok,
  validateFrozenRuleForm, validateRuleForm, type Msg, type RuleForm, type RuleTemplate,
} from './ruleForm';

type Vars = Record<string, string | number>;
/** Translation helpers for the Online shop screens: `T` for English source text, `say` for a sentence made by ruleForm.ts. */
export function useT() {
  const lang = useLang();
  return useMemo(() => ({ lang, T: (s: string, v?: Vars) => tl(lang, s, v), say: (m: Msg) => tl(lang, m.key, m.vars) }), [lang]);
}
/** ฿300 for a whole amount, ฿299.99 otherwise. */
export const baht = (n: number): string => (Number.isInteger(n) ? money0(n) : money(n));
const errStyle = { color: 'var(--crit-text)' } as const;

// ================================================================================================ SKU search shared by the forms
/** Names and status of the SKUs a form mentions, looked up by code (a saved rule only stores codes). Fresh on every open form. */
export function useSkuInfo() {
  const [info, setInfo] = useState<Record<string, SkuHit>>({});
  const asked = useRef(new Set<string>());
  const remember = useCallback((hits: SkuHit[]) => {
    for (const h of hits) asked.current.add(h.sku_code);
    setInfo((m) => { const n = { ...m }; for (const h of hits) n[h.sku_code] = h; return n; });
  }, []);
  const ensure = useCallback((codes: string[]) => {
    for (const c of codes) {
      if (asked.current.has(c)) continue;
      asked.current.add(c);
      rewardsAdmin.searchSkus(c, false, 5).then((hits) => setInfo((m) => { const n = { ...m }; for (const h of hits) if (h.sku_code === c) n[c] = h; return n; })).catch(() => undefined);
    }
  }, []);
  return { info, remember, ensure };
}

/** Search by SKU code or name (debounced, asks the server). Inactive SKUs are listed and labelled but cannot be added; neither can anything `why` rules out. */
export function SkuSearch({ onPick, remember, why, label }: { onPick: (h: SkuHit) => void; remember: (h: SkuHit[]) => void; why: (h: SkuHit) => string | null; label: string }) {
  const { T, say } = useT();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SkuHit[] | null>(null);
  const [err, setErr] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    const n = ++seq.current;
    if (term.length < 2) { setHits(null); setErr(null); setBusy(false); return; }
    setBusy(true);
    const h = setTimeout(() => {
      rewardsAdmin.searchSkus(term, false, 20)
        .then((r) => { if (n === seq.current) { remember(r); setHits(r); setErr(null); } })
        .catch((e) => { if (n === seq.current) { setErr(rewardsErrorMessage(e)); setHits(null); } })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 250);
    return () => clearTimeout(h);
  }, [q, remember]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="input-icon"><Search /><Input value={q} onChange={(e) => setQ(e.target.value)} aria-label={T(label)} placeholder={T('Search by SKU or name')} autoComplete="off" /></div>
      {err && <div role="alert" style={errStyle}>{say(err)}</div>}
      {q.trim().length > 0 && q.trim().length < 2 && <div className="muted" style={{ fontSize: 12 }}><Tx>Type at least 2 characters.</Tx></div>}
      {busy && <div className="muted" style={{ fontSize: 12 }} role="status"><Tx>Searching…</Tx></div>}
      {hits && !busy && (hits.length === 0
        ? <div className="muted" style={{ fontSize: 12.5 }}><Tx>No product matches.</Tx></div>
        : (
          <div className="card" style={{ maxHeight: 240, overflowY: 'auto' }} role="list" aria-label={T('Search results')}>
            {hits.map((h) => {
              const block = why(h);
              return (
                <div key={h.sku_code} role="listitem" className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', opacity: block ? 0.6 : 1 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div><span className="mono">{h.sku_code}</span> {h.name}</div>
                    <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
                      <Badge tone={h.status === 'active' ? 'good' : 'bad'}>{h.status === 'active' ? 'Active' : 'Inactive'}</Badge>
                      {h.is_pack && <Badge tone="info">Pack</Badge>}
                      {h.price != null && <span className="muted" style={{ fontSize: 12 }}>{baht(h.price)}</span>}
                      {block && <span className="muted" style={{ fontSize: 12 }}>{T(block)}</span>}
                    </div>
                  </div>
                  <Button size="sm" disabled={!!block} onClick={() => onPick(h)} aria-label={`${T('Add')} ${h.sku_code}`}><Tx>Add</Tx></Button>
                </div>
              );
            })}
          </div>))}
    </div>
  );
}

/** One chosen SKU as a removable chip. A SKU that has gone inactive is flagged so it can be taken out before saving. */
export function SkuChip({ code, info, onRemove }: { code: string; info?: SkuHit; onRemove?: () => void }) {
  const { T } = useT();
  return (
    <span className="chip" style={{ gap: 6 }}>
      <span className="mono">{code}</span>{info && <span>{info.name}</span>}
      {info?.status === 'inactive' && <Badge tone="bad">Inactive</Badge>}
      {info?.is_pack && <Badge tone="info">Pack</Badge>}
      {onRemove && <button type="button" className="btn ghost sm icon" onClick={onRemove} aria-label={`${T('Remove')} ${code}`} style={{ padding: 0, minHeight: 0, height: 18, width: 18 }}><X size={12} /></button>}
    </span>
  );
}

/** Chips of the chosen SKUs and the search to add more: a list of codes, each at most once. */
function SkuListField({ codes, onChange, info, remember, label, blockedBy, blockedWhy, packs }: {
  codes: string[]; onChange: (c: string[]) => void; info: Record<string, SkuHit>; remember: (h: SkuHit[]) => void; label: string; blockedBy: string[]; blockedWhy: string; packs?: boolean;
}) {
  return (
    <div className="col" style={{ gap: 8 }}>
      {codes.length > 0 && <div className="row wrap" style={{ gap: 6 }}>{codes.map((c) => <SkuChip key={c} code={c} info={info[c]} onRemove={() => onChange(codes.filter((x) => x !== c))} />)}</div>}
      <SkuSearch label={label} remember={remember} onPick={(h) => onChange(addToList(codes, h.sku_code))}
        why={(h) => (h.status !== 'active' ? 'Inactive: cannot be added' : codes.includes(h.sku_code) ? 'Already added' : blockedBy.includes(h.sku_code) ? blockedWhy : h.is_pack && !packs ? 'A pack: use "Count promotion packs" instead' : null)} />
    </div>
  );
}

// ================================================================================================ customers for the allow-list
/** Search customers by name, phone or e-mail (debounced, 2 characters at least). Staff only: the server returns nothing to anyone else. */
function CustomerSearch({ onPick, remember, why }: { onPick: (h: CustomerHit) => void; remember: (h: CustomerHit[]) => void; why: (h: CustomerHit) => string | null }) {
  const { T, say } = useT();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CustomerHit[] | null>(null);
  const [err, setErr] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    const n = ++seq.current;
    if (term.length < 2) { setHits(null); setErr(null); setBusy(false); return; }
    setBusy(true);
    const h = setTimeout(() => {
      rewardsAdmin.searchCustomers(term, 10)
        .then((r) => { if (n === seq.current) { remember(r); setHits(r); setErr(null); } })
        .catch((e) => { if (n === seq.current) { setErr(rewardsErrorMessage(e)); setHits(null); } })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 250);
    return () => clearTimeout(h);
  }, [q, remember]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="input-icon"><Search /><Input value={q} onChange={(e) => setQ(e.target.value)} aria-label={T('Search customers by name, phone or e-mail')} placeholder={T('Name, phone or e-mail')} autoComplete="off" /></div>
      {err && <div role="alert" style={errStyle}>{say(err)}</div>}
      {q.trim().length > 0 && q.trim().length < 2 && <div className="muted" style={{ fontSize: 12 }}><Tx>Type at least 2 characters.</Tx></div>}
      {busy && <div className="muted" style={{ fontSize: 12 }} role="status"><Tx>Searching…</Tx></div>}
      {hits && !busy && (hits.length === 0
        ? <div className="muted" style={{ fontSize: 12.5 }}><Tx>No customer matches.</Tx></div>
        : (
          <div className="card" style={{ maxHeight: 240, overflowY: 'auto' }} role="list" aria-label={T('Search results')}>
            {hits.map((h) => {
              const lab = customerLabel(h, h.id); const block = why(h);
              return (
                <div key={h.id} role="listitem" className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', opacity: block ? 0.6 : 1 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div>{lab.title}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{[h.phone, h.email].filter(Boolean).join(' · ')}{block && <> · {T(block)}</>}</div>
                  </div>
                  <Button size="sm" disabled={!!block} onClick={() => onPick(h)} aria-label={`${T('Add')} ${lab.title}`}><Tx>Add</Tx></Button>
                </div>
              );
            })}
          </div>))}
    </div>
  );
}

/** The chosen customers as chips, and the search to add more. Only their ids are kept in the rule. */
function CustomerListField({ ids, onChange, people, remember }: { ids: string[]; onChange: (ids: string[]) => void; people: Record<string, CustomerHit>; remember: (h: CustomerHit[]) => void }) {
  const { T } = useT();
  return (
    <div className="col" style={{ gap: 8 }}>
      {ids.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {ids.map((id) => {
            const lab = customerLabel(people[id], id);
            return (
              <span key={id} className="chip" style={{ gap: 6 }} title={id}>
                <b>{lab.title}</b>{lab.detail && <span className="muted">{lab.detail}</span>}
                <button type="button" className="btn ghost sm icon" onClick={() => onChange(ids.filter((x) => x !== id))} aria-label={`${T('Remove')} ${lab.title}`} style={{ padding: 0, minHeight: 0, height: 18, width: 18 }}><X size={12} /></button>
              </span>
            );
          })}
        </div>
      )}
      <CustomerSearch remember={remember} onPick={(h) => onChange(addToList(ids, h.id))} why={(h) => (ids.includes(h.id) ? 'Already added' : null)} />
    </div>
  );
}

// ================================================================================================ the rule form
const TEMPLATES: { v: RuleTemplate; label: string; desc: string }[] = [
  { v: 'points', label: 'Points per baht spent', desc: 'Customers collect points on what they pay.' },
  { v: 'board_pick', label: 'Number picks per bill', desc: 'Each eligible bill earns picks the customer uses on the event boards.' },
];
const SLOTS = [1, 2, 3];
const fieldsetReset = { border: 0, padding: 0, margin: 0, minWidth: 0 } as const;

export interface RuleEditorProps {
  rule: Rule | null; /** which template a NEW rule starts from */ template?: RuleTemplate;
  events: EventDoc[]; eventsFailed: boolean; categories: AdminCategory[]; categoriesFailed: boolean;
  onClose: () => void; onSaved: (r: Rule) => void;
}
const hasAdvanced = (f: RuleForm) => !!(f.endDate || f.maxPerOrder !== '' || f.excludeSkus.length || f.includePacks || f.boardSlots.length || f.customers.length || (f.kind === 'points' && f.basis === 'cumulative'));

export function RuleEditor({ rule, template, events, eventsFailed, categories, categoriesFailed, onClose, onSaved }: RuleEditorProps) {
  const { T, say, lang } = useT();
  const [base, setBase] = useState<Rule | null>(rule);                    // the saved rule being edited; null = a new rule (or a duplicate)
  const [dup, setDup] = useState(false);
  const [serverUsed, setServerUsed] = useState(false);                    // the server said RULE_USED although the list did not know yet
  const isNew = !base;
  const frozen = !!base && (ruleIsUsed(base) || serverUsed);              // a rule that has given rewards: only name, active and a later end date
  const [f, setF] = useState<RuleForm>(() => (rule ? ruleToForm(rule) : newRuleForm(template ?? 'points', T(TEMPLATES.find((x) => x.v === (template ?? 'points'))!.label))));
  const [adv, setAdv] = useState(() => hasAdvanced(f) || (!!rule && ruleIsUsed(rule)));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<Msg | null>(null);
  const set = (p: Partial<RuleForm>) => setF((x) => ({ ...x, ...p }));
  const { info, remember, ensure } = useSkuInfo();
  const [people, setPeople] = useState<Record<string, CustomerHit>>({});
  const rememberPeople = useCallback((hits: CustomerHit[]) => setPeople((m) => { const n = { ...m }; for (const h of hits) n[h.id] = h; return n; }), []);
  useEffect(() => { ensure([...f.includeSkus, ...f.excludeSkus]); }, [f.includeSkus, f.excludeSkus, ensure]);

  const inactive = useMemo(() => new Set(f.includeSkus.filter((c) => info[c]?.status === 'inactive')), [f.includeSkus, info]);
  const errors = useMemo(() => (frozen ? validateFrozenRuleForm(f, base!) : validateRuleForm(f, { inactive })), [f, frozen, base, inactive]);
  const sentences = useMemo(() => ruleSentences(f), [f]);
  const pick = f.kind === 'board_pick';
  const event = events.find((e) => e.id === f.eventId);
  const slotName = (n: number) => event?.boards.find((b) => b.slot === n)?.name ?? `${T('Board')} ${n}`;
  const err = (k: keyof typeof errors, hint?: string) => (tried && errors[k] ? <span style={errStyle}>{say(errors[k]!)}</span> : hint ? T(hint) : undefined);

  const chooseTemplate = (kind: RuleTemplate) => setF((x) => {
    if (x.kind === kind) return x;
    const was = T(TEMPLATES.find((t) => t.v === x.kind)!.label);
    return { ...x, kind, basis: 'per_bill', eventId: kind === 'points' ? '' : x.eventId, name: !x.name.trim() || x.name === was ? T(TEMPLATES.find((t) => t.v === kind)!.label) : x.name };
  });
  const catLabel = (c: AdminCategory) => (lang === 'th' ? c.name_th || c.name_en : c.name_en || c.name_th) || c.code;
  const catList: { code: string; label: string }[] = [
    ...categories.map((c) => ({ code: c.code, label: catLabel(c) })),
    ...f.categories.filter((c) => !categories.some((x) => x.code === c)).map((c) => ({ code: c, label: c })),
  ];
  const toggle = <V,>(arr: V[], v: V) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  /** One click: the same settings as a new, inactive rule named "… (copy)" that starts from now. No second dialog. */
  const duplicate = () => {
    const d = duplicateRuleForm(base!);
    setBase(null); setDup(true); setServerUsed(false); setServerErr(null); setTried(false); setF(d); setAdv(hasAdvanced(d));
  };

  const save = async () => {
    setTried(true); setServerErr(null);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const saved = await rewardsAdmin.saveRule(f.id, formToPatch(f, frozen ? { frozenFrom: base! } : base ? { original: base } : {}));
      toast('success', T(isNew ? 'Rule created' : 'Rule saved'));
      onSaved(saved);
    } catch (e) {
      if (isRuleUsedError(e) && base) {                                   // it gave its first reward while this form was open: turn read-only, keep only what is still editable
        setServerUsed(true); setAdv(true); setTried(false);
        setF((x) => ({ ...ruleToForm(base), name: x.name, active: x.active, endDate: x.endDate }));
      } else setServerErr(rewardsErrorMessage(e));
    } finally { setBusy(false); }
  };

  const endField = (
    <Field label="Ends" hint={err('endDate', frozen ? 'The end date can only be moved later, or removed.' : 'Optional. Bills are matched by the day they were placed.')}>
      <Input type="date" value={f.endDate} min={frozen && base?.ends_at ? toBangkokDate(base.ends_at) : undefined} disabled={frozen && !base?.ends_at} onChange={(e) => set({ endDate: e.target.value })} />
    </Field>
  );

  return (
    <Modal title={isNew ? 'New rule' : 'Edit rule'} size="lg" onClose={onClose}
      footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" disabled={busy} onClick={() => void save()}><Tx>Save rule</Tx></Button></>}>
      <div className="col" style={{ gap: 16 }}>
        {serverErr && <Banner tone="bad">{say(serverErr)}</Banner>}
        {isNew && !dup && (
          <div className="col" style={{ gap: 6 }}>
            <div className="lbl-s"><Tx>Start from</Tx></div>
            <Seg value={f.kind} onChange={chooseTemplate} options={TEMPLATES.map((x) => ({ v: x.v, label: x.label }))} />
            <div className="muted" style={{ fontSize: 12.5 }}>{T(TEMPLATES.find((x) => x.v === f.kind)!.desc)}</div>
          </div>
        )}
        {frozen && (
          <Banner tone="warn">
            <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span>{T('This rule has already given rewards. To change how it works, duplicate it.')}</span>
              <Button size="sm" onClick={duplicate}><Tx>Duplicate</Tx></Button>
            </div>
          </Banner>
        )}

        <Field label="Rule name" hint={err('name')}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} /></Field>

        <fieldset disabled={frozen} style={fieldsetReset}>
          <div className="col" style={{ gap: 16 }}>
            <div className="form-grid">
              <Field label="Every complete (฿)" hint={err('spendStep', 'The bill amount that earns one reward.')}>
                <NumInput value={f.spendStep} min={0} onChange={(n) => set({ spendStep: isNaN(n) ? '' : n })} />
              </Field>
              <Field label={pick ? 'Picks earned' : 'Points earned'} hint={err('rewardAmount', 'Given for each complete step.')}>
                <NumInput value={f.rewardAmount} min={1} step={1} onChange={(n) => set({ rewardAmount: isNaN(n) ? '' : n })} />
              </Field>
              {pick && (
                <Field label="Event" full hint={err('eventId', eventsFailed ? 'The events could not be loaded. Refresh the page.' : events.length ? undefined : 'There is no event yet. Create one in Events, then come back.')}>
                  <Select value={f.eventId} onChange={(e) => set({ eventId: e.target.value, boardSlots: [] })}>
                    <option value="">{T('Choose an event…')}</option>
                    {events.map((e) => <option key={e.id} value={e.id}>{e.name} ({T(e.status === 'draft' ? 'Draft' : e.status === 'active' ? 'Active' : e.status === 'paused' ? 'Paused' : 'Closed')})</option>)}
                  </Select>
                </Field>
              )}
            </div>

            {sentences.length > 0 && (
              <Banner tone="info">
                <div className="col" style={{ gap: 2 }} aria-live="polite">{sentences.map((s, i) => <div key={i} style={i === 0 ? { fontWeight: 650 } : undefined}>{say(s)}</div>)}</div>
              </Banner>
            )}

            <div className="col" style={{ gap: 10 }}>
              <div><div className="lbl-s"><Tx>What counts</Tx></div><div className="muted" style={{ fontSize: 12.5 }}><Tx>Leave empty to count everything in the shop. Shipping never counts.</Tx></div></div>
              <div className="row wrap" role="group" aria-label={T('Categories')}>
                {catList.map((c) => <Check key={c.code} checked={f.categories.includes(c.code)} onChange={() => set({ categories: toggle(f.categories, c.code) })}>{c.label}</Check>)}
                {!catList.length && <span className="muted" style={{ fontSize: 12.5 }}>{T(categoriesFailed ? 'The categories could not be loaded.' : 'No categories yet.')}</span>}
              </div>
              <Field label="Only these products" hint={err('includeSkus', 'Optional. Add products by SKU or name; inactive products cannot be added.')}>
                <SkuListField codes={f.includeSkus} onChange={(c) => set({ includeSkus: c })} info={info} remember={remember} label="Search products to include" blockedBy={f.excludeSkus} blockedWhy="Already in the excluded list" />
              </Field>
            </div>

            <details className="acc" open={adv} onToggle={(e) => setAdv((e.currentTarget as HTMLDetailsElement).open)}>
              <summary><Tx>Advanced options</Tx></summary>
              <div className="form-grid" style={{ marginTop: 8 }}>
                {isNew ? (
                  <div className="field">
                    <span className="lbl-s"><Tx>Starts</Tx></span>
                    <Seg value={f.startDate ? 'date' : 'now'} onChange={(m) => set({ startDate: m === 'now' ? '' : todayBangkok() })} options={[{ v: 'now', label: 'From now' }, { v: 'date', label: 'From a date' }]} />
                    {f.startDate
                      ? <Input type="date" aria-label={T('Start date')} value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} />
                      : <span className="hint"><Tx>Bills paid before this rule exists do not earn.</Tx></span>}
                  </div>
                ) : (
                  <Field label="Start date" hint={err('startDate', 'Bills placed before this day do not earn.')}><Input type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
                )}
                {!frozen && endField}
                {f.basis === 'per_bill' && <Field label="Most per bill" hint={err('maxPerOrder', 'Optional cap on one bill.')}><NumInput value={f.maxPerOrder} min={1} step={1} onChange={(n) => set({ maxPerOrder: isNaN(n) ? '' : n })} /></Field>}
                {!pick && (
                  <Field label="How it counts" hint="Per bill is the usual choice. Total spent adds up everything the customer has paid.">
                    <Select value={f.basis} onChange={(e) => set({ basis: e.target.value as RuleForm['basis'] })}>
                      <option value="per_bill">{T('Each bill on its own')}</option>
                      <option value="cumulative">{T('Total spent by the customer')}</option>
                    </Select>
                  </Field>
                )}
                <Field label="Never count these products" full>
                  <SkuListField codes={f.excludeSkus} onChange={(c) => set({ excludeSkus: c })} info={info} remember={remember} label="Search products to exclude" blockedBy={f.includeSkus} blockedWhy="Already in the included list" />
                </Field>
                <div className="full"><Check checked={f.includePacks} onChange={(v) => set({ includePacks: v })}><Tx>Count promotion packs (at their eligible value)</Tx></Check></div>
                {pick && event && (
                  <Field label="Boards these picks can be used on" full hint="Leave all unticked for any board.">
                    <div className="row wrap" role="group" aria-label={T('Boards')}>{SLOTS.map((n) => <Check key={n} checked={f.boardSlots.includes(n)} onChange={() => set({ boardSlots: toggle(f.boardSlots, n).sort() })}>{slotName(n)}</Check>)}</div>
                  </Field>
                )}
                <Field label="Only these customers" full hint="Optional. Search by name, phone or e-mail. Empty means everyone.">
                  <CustomerListField ids={f.customers} onChange={(c) => set({ customers: c })} people={people} remember={rememberPeople} />
                </Field>
              </div>
            </details>
          </div>
        </fieldset>

        {frozen && <div className="form-grid">{endField}</div>}
        <Check checked={f.active} onChange={(v) => set({ active: v })}><Tx>Active: counts bills as soon as rewards are switched on</Tx></Check>
      </div>
    </Modal>
  );
}

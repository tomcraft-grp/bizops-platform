// Pure logic behind the back-office rule and pack forms (Promotions > Online shop). No React, no network.
// The arithmetic here only PREVIEWS what a rule does while it is being written; the database decides for real
// (supabase rw_rule_amount / rw_settle_profile). Both use the same rule: a bill earns floor(eligible amount / step) x reward, per bill,
// bills are never combined, and the floor is taken on whole satang so 299.99 can never round up to a pick.
import { isRewardsError, type CustomerHit, type Pack, type PackPatch, type Rule, type RuleBasis, type RuleKind, type RulePatch, type SimLine } from './api';
import { ShopError } from '../shop/api';

/** A sentence for the screen: `key` is the English source text (looked up in the Thai dictionary), `vars` fill its {placeholders}. */
export interface Msg { key: string; vars: Record<string, string | number> }
const msg = (key: string, vars: Record<string, string | number> = {}): Msg => ({ key, vars });

export const DEFAULT_STEP = 300;
export const DEFAULT_REWARD = 1;
export type RuleTemplate = RuleKind;

// ------------------------------------------------------------------------------------------------ the sentences the form can show
// Kept in one place so the Thai dictionary (lib/i18n.rewards.ts) and its test can be checked against the list.
const K = {
  everyBillPick1: 'Every complete ฿{step} on one bill = {n} pick.', everyBillPicks: 'Every complete ฿{step} on one bill = {n} picks.',
  everyBillPoint1: 'Every complete ฿{step} on one bill = {n} point.', everyBillPoints: 'Every complete ฿{step} on one bill = {n} points.',
  everyTotalPoint1: 'Every complete ฿{step} spent in total = {n} point.', everyTotalPoints: 'Every complete ฿{step} spent in total = {n} points.',
  exBillPick1: '฿{amount} on one bill → {n} pick.', exBillPicks: '฿{amount} on one bill → {n} picks.',
  exBillPoint1: '฿{amount} on one bill → {n} point.', exBillPoints: '฿{amount} on one bill → {n} points.',
  exTotalPoint1: '฿{amount} spent in total → {n} point.', exTotalPoints: '฿{amount} spent in total → {n} points.',
  neverCombined: 'Bills are never added together: two bills of ฿{amount} earn nothing.',
  capPick1: 'At most {n} pick per bill.', capPicks: 'At most {n} picks per bill.', capPoint1: 'At most {n} point per bill.', capPoints: 'At most {n} points per bill.',
  fromNow: 'Counts bills from now on. Bills paid before this rule exists do not earn.', backdated: 'Also counts bills placed since {date}, once rewards are switched on.',
  startsLater: 'Starts counting on {date}.', countsFrom: 'Counts bills placed from {date}.',
  // validation
  name: 'Give the rule a name.', step: 'The amount per step must be more than ฿0.', reward: 'The reward must be a whole number, at least 1.',
  max: 'The limit per bill must be a whole number, at least 1 (or leave it empty).', event: 'Choose the event these picks are for.',
  basis: 'Number picks are always counted per bill. "Total spent" is for points only.', dates: 'The end date cannot be before the start date.',
  startNeeded: 'Choose the day this rule starts counting.', endOnlyLater: 'The end date can only be moved later, or removed.', inactive: 'Remove inactive SKUs before saving: {list}',
  packName: 'Give the pack a name.', packPrice: 'The pack price must be more than ฿0.', packNone: 'Add at least one product to the pack.',
  packQty: 'Quantities must be whole numbers, at least 1.', packTwice: 'Each product can be in the pack once: change its quantity instead.',
  packPoints: 'Points per pack must be a whole number, 0 or more (or leave it empty).', packValue: 'The eligible value must be 0 or more (or leave it empty).',
  // simulator notes
  noteTotal: "This rule counts a customer's total spend, so one bill cannot show it. Shown as if this were all they spent.",
  noteNarrow: 'This rule only counts some products or customers. Use the cart test for an exact answer.',
  // server errors
  ruleUsed: 'This rule has already given rewards. To change how it works, duplicate it.',
  forbidden: 'You are not allowed to do this. Ask a Super Admin.', inactiveSku: 'SKU {sku} is inactive, so it cannot be added. Remove it, or switch it back to active in Products.',
  inactiveSkuAny: 'A product in this form is inactive, so it cannot be added.', badRule: 'This rule is not valid: {detail}', badRuleAny: 'This rule is not valid.',
  badPack: 'This pack is not valid: {detail}', badPackAny: 'This pack is not valid.', off: 'Rewards are switched off. Use the master switch first.',
  notFound: 'That item no longer exists. Refresh the page.', network: 'No connection. Check the internet and try again.',
  keyReused: 'This request was already sent with different details. Close the form and start again.',
  other: 'Something went wrong: {detail}', otherAny: 'Something went wrong. Please try again.',
} as const;
/** Every sentence this file can produce (the Thai dictionary test walks this list). */
export const RULE_TEXT_KEYS: string[] = Object.values(K);

// ------------------------------------------------------------------------------------------------ money, floored on whole satang
const SATANG_EPS = 1e-6;                       // absorbs binary float noise (0.1 + 0.2) without ever lifting 299.995 to 300
const toSatang = (n: number): number => Math.floor(n * 100 + SATANG_EPS);
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
const posNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v) && v > 0;
const wholeAtLeast = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

/** Rewards one bill earns: floor(eligible / step) x reward, capped by `max` per bill. Rubbish in gives 0. */
export function previewRights(amount: number, step: number, reward: number, max: number | null): number {
  if (!isFinite(amount) || amount <= 0 || !posNum(step) || !posNum(reward)) return 0;
  const stepS = toSatang(step);
  if (stepS < 1) return 0;
  const n = Math.floor(toSatang(amount) / stepS) * reward;
  return max != null && max > 0 ? Math.min(n, max) : n;
}
/** Several bills: each one is worked out on its own and the results are added. Two bills of 200 earn nothing, 700 and 200 earn 2. */
export const previewBills = (amounts: number[], step: number, reward: number, max: number | null): number => amounts.reduce((s, a) => s + previewRights(a, step, reward, max), 0);
/** How much more this bill needs to earn the next reward; null when the rule cannot earn or the cap is reached. */
export function nextRewardIn(amount: number, step: number, reward: number, max: number | null): number | null {
  if (!posNum(step) || !posNum(reward)) return null;
  const stepS = toSatang(step);
  if (stepS < 1) return null;
  if (max != null && max > 0 && previewRights(amount, step, reward, null) >= max) return null;
  const have = isFinite(amount) && amount > 0 ? toSatang(amount) : 0;
  return (stepS - (have % stepS)) / 100;
}

// ------------------------------------------------------------------------------------------------ dates (Bangkok days)
const BKK_MS = 7 * 3600 * 1000;
export const bangkokStart = (day: string): string | null => (day ? `${day}T00:00:00+07:00` : null);
export const bangkokEnd = (day: string): string | null => (day ? `${day}T23:59:59+07:00` : null);
export function toBangkokDate(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  return isFinite(ms) ? new Date(ms + BKK_MS).toISOString().slice(0, 10) : '';
}

/** The Bangkok day it is now (`nowMs` for tests). */
export const todayBangkok = (nowMs: number = Date.now()): string => new Date(nowMs + BKK_MS).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------ the rule form
export interface RuleForm {
  id: string | null; kind: RuleKind; name: string; active: boolean;
  spendStep: number | ''; rewardAmount: number | ''; basis: RuleBasis; maxPerOrder: number | '';
  categories: string[]; includeSkus: string[]; excludeSkus: string[]; includePacks: boolean;
  startDate: string; endDate: string;            // Bangkok days. A NEW rule with no start date counts from the moment it is saved (the server sets it); only a date staff choose reaches back
  customers: string[];                           // ids of the customers chosen for the allow-list, [] = everyone
  eventId: string; boardSlots: number[];         // board picks only; [] = any of the three boards
}
export type RuleField = 'name' | 'spendStep' | 'rewardAmount' | 'maxPerOrder' | 'eventId' | 'basis' | 'endDate' | 'startDate' | 'includeSkus';
export type RuleErrors = Partial<Record<RuleField, Msg>>;

/** The two starting points. Common values are filled in so a new rule is one name and one Save away. */
export function newRuleForm(template: RuleTemplate, name: string): RuleForm {
  return {
    id: null, kind: template, name, active: true, spendStep: DEFAULT_STEP, rewardAmount: DEFAULT_REWARD, basis: 'per_bill', maxPerOrder: '',
    categories: [], includeSkus: [], excludeSkus: [], includePacks: false, startDate: '', endDate: '', customers: [], eventId: '', boardSlots: [],
  };
}
export function ruleToForm(r: Rule): RuleForm {
  return {
    id: r.id, kind: r.kind, name: r.name, active: r.active, spendStep: r.spend_step, rewardAmount: r.reward_amount, basis: r.basis, maxPerOrder: r.max_per_order ?? '',
    categories: [...r.category_codes], includeSkus: [...r.include_skus], excludeSkus: [...r.exclude_skus], includePacks: r.include_packs,
    startDate: toBangkokDate(r.starts_at), endDate: toBangkokDate(r.ends_at), customers: [...(r.only_profile_ids ?? [])],
    eventId: r.event_id ?? '', boardSlots: [...(r.board_slots ?? [])],
  };
}

export const addToList = (list: string[], v: string): string[] => (list.includes(v) ? list : [...list, v]);

/** How a chosen customer reads on a chip: the name, and one thing to tell people apart (phone, else e-mail). An id nobody has looked up shows its first characters. */
export function customerLabel(hit: CustomerHit | undefined, id: string): { title: string; detail: string } {
  const name = hit?.name?.trim() ?? '';
  const rest = [hit?.phone?.trim() ?? '', hit?.email?.trim() ?? ''].filter(Boolean);
  if (name) return { title: name, detail: rest[0] ?? '' };
  if (rest.length) return { title: rest[0], detail: rest[1] ?? '' };
  return { title: '…' + (hit?.id ?? id).slice(0, 8), detail: '' };
}

/** A rule that has already given something is frozen: only its name, active and a later end date may change. To change how it works, duplicate it. */
export const ruleIsUsed = (r: Rule): boolean => r.stats.granted > 0;
/** The server's refusal of a change to a used rule (BAD_RULE: RULE_USED). */
export const isRuleUsedError = (e: unknown): boolean => e instanceof ShopError && e.code === 'BAD_RULE' && /^RULE_USED\b/.test(stripCode(e.message));
/** A new, inactive rule with the same settings and a "(copy)" name. It starts from now, and an end date that has already passed is not carried over. */
export function duplicateRuleForm(r: Rule, today: string = todayBangkok()): RuleForm {
  const f = ruleToForm(r);
  const name = f.name.trim();
  return { ...f, id: null, name: /\(copy\)$/.test(name) ? name : `${name} (copy)`, active: false, startDate: '', endDate: f.endDate && f.endDate < today ? '' : f.endDate };
}
/** Checks for a frozen rule: the name, and an end date that is only moved later or removed (a rule without an end date keeps none). */
export function validateFrozenRuleForm(f: RuleForm, original: Rule): RuleErrors {
  const e: RuleErrors = {};
  if (!f.name.trim()) e.name = msg(K.name);
  const was = toBangkokDate(original.ends_at);
  if (f.endDate !== was && !(f.endDate === '' ? was !== '' : was !== '' && f.endDate >= was)) e.endDate = msg(K.endOnlyLater);
  return e;
}

/** Mirrors the server's checks (rw_admin_save_rule) so most mistakes are caught before the call; the server still has the last word. */
export function validateRuleForm(f: RuleForm, ctx: { inactive?: Set<string> } = {}): RuleErrors {
  const e: RuleErrors = {};
  if (!f.name.trim()) e.name = msg(K.name);
  if (!posNum(f.spendStep)) e.spendStep = msg(K.step);
  if (!wholeAtLeast(f.rewardAmount, 1)) e.rewardAmount = msg(K.reward);
  if (f.maxPerOrder !== '' && !wholeAtLeast(f.maxPerOrder, 1)) e.maxPerOrder = msg(K.max);
  if (f.kind === 'board_pick') {
    if (!f.eventId) e.eventId = msg(K.event);
    if (f.basis !== 'per_bill') e.basis = msg(K.basis);
  }
  if (f.startDate && f.endDate && f.endDate < f.startDate) e.endDate = msg(K.dates);
  if (f.id && !f.startDate) e.startDate = msg(K.startNeeded);       // saving an existing rule with no start would make it count from the beginning
  const bad = f.includeSkus.filter((c) => ctx.inactive?.has(c));
  if (bad.length) e.includeSkus = msg(K.inactive, { list: bad.join(', ') });
  return e;
}

/** What is sent to rw_admin_save_rule. A board pick is always per bill and carries its event; a points rule never carries one. */
export function formToPatch(f: RuleForm, opts: { frozenFrom?: Rule; original?: Rule } = {}): RulePatch {
  if (opts.frozenFrom) {                                              // a used rule: nothing but these three can change, so nothing else is sent
    const patch: RulePatch = { name: f.name.trim(), active: f.active };
    if (f.endDate !== toBangkokDate(opts.frozenFrom.ends_at)) patch.ends_at = bangkokEnd(f.endDate);
    return patch;
  }
  const board = f.kind === 'board_pick';
  const slots = [...new Set(f.boardSlots)].sort();
  const ids = [...new Set(f.customers)];
  const patch: RulePatch = {
    kind: f.kind, name: f.name.trim(), active: f.active, starts_at: bangkokStart(f.startDate), ends_at: bangkokEnd(f.endDate),
    spend_step: num(f.spendStep), reward_amount: num(f.rewardAmount), basis: board ? 'per_bill' : f.basis, max_per_order: f.maxPerOrder === '' ? null : f.maxPerOrder,
    category_codes: [...f.categories], include_skus: [...f.includeSkus], exclude_skus: [...f.excludeSkus], include_packs: f.includePacks,
    only_profile_ids: ids.length ? ids : null, event_id: board ? f.eventId : null, board_slots: board && slots.length > 0 && slots.length < 3 ? slots : null,
  };
  // Editing a SAVED rule: the form only knows the DAY of a stored moment ("from now" is 14:30, the form shows that day). Re-sending the day would move the start back to
  // midnight and make the morning's bills count, so a date the user did not change is not sent at all (an absent key means "unchanged" on the server).
  if (opts.original) {
    if (f.startDate === toBangkokDate(opts.original.starts_at)) delete patch.starts_at;
    if (f.endDate === toBangkokDate(opts.original.ends_at)) delete patch.ends_at;
  }
  return patch;
}

// ------------------------------------------------------------------------------------------------ "what does this do" under the form
/** An example amount that is not an exact multiple of the step: two steps and most of a third (300 -> 850). */
function exampleAmount(step: number): number {
  const rem = Number.isInteger(step) && step >= 10 ? Math.round((step * 0.83) / 10) * 10 : step * 0.5;
  return r2(2 * step + Math.min(Math.max(rem, step * 0.1), step * 0.9));
}
export function ruleSentences(f: RuleForm, today: string = todayBangkok()): Msg[] {
  if (!posNum(f.spendStep) || !wholeAtLeast(f.rewardAmount, 1) || toSatang(f.spendStep) < 1) return [];
  const step = f.spendStep; const n = f.rewardAmount;
  const pick = f.kind === 'board_pick'; const total = !pick && f.basis === 'cumulative';
  const one = (a: string, b: string) => (n === 1 ? a : b);
  const out: Msg[] = [];
  out.push(pick ? msg(one(K.everyBillPick1, K.everyBillPicks), { step, n }) : total ? msg(one(K.everyTotalPoint1, K.everyTotalPoints), { step, n }) : msg(one(K.everyBillPoint1, K.everyBillPoints), { step, n }));
  const amount = exampleAmount(step);
  const got = previewRights(amount, step, n, null);
  const g1 = got === 1;
  out.push(pick ? msg(g1 ? K.exBillPick1 : K.exBillPicks, { amount, n: got }) : total ? msg(g1 ? K.exTotalPoint1 : K.exTotalPoints, { amount, n: got }) : msg(g1 ? K.exBillPoint1 : K.exBillPoints, { amount, n: got }));
  if (!total) {
    const two = Math.floor((step * 2) / 3 / 10) * 10 || Math.floor((step * 2) / 3);
    if (two > 0 && two * 2 >= step && two < step) out.push(msg(K.neverCombined, { amount: two }));
    if (f.maxPerOrder !== '' && wholeAtLeast(f.maxPerOrder, 1)) { const m = f.maxPerOrder; out.push(pick ? msg(m === 1 ? K.capPick1 : K.capPicks, { n: m }) : msg(m === 1 ? K.capPoint1 : K.capPoints, { n: m })); }
  }
  if (!f.startDate) out.push(msg(K.fromNow));
  else if (f.startDate > today) out.push(msg(K.startsLater, { date: f.startDate }));
  else out.push(msg(f.id ? K.countsFrom : K.backdated, { date: f.startDate }));
  return out;
}

// ------------------------------------------------------------------------------------------------ simulator by bill amount
/** "What would a bill of THB X earn?" for every active rule, assuming the whole bill is eligible. The cart test asks the server and applies each rule's scope. */
export function simulateAmount(rules: Rule[], amount: number): SimLine[] {
  return rules.filter((r) => r.active).map((r) => ({
    rule_id: r.id, rule_name: r.name, kind: r.kind, eligible_amount: amount,
    reward: previewRights(amount, r.spend_step, r.reward_amount, r.max_per_order), next_reward_in: nextRewardIn(amount, r.spend_step, r.reward_amount, r.max_per_order),
    note: r.basis === 'cumulative' ? K.noteTotal : r.category_codes.length || r.include_skus.length || r.exclude_skus.length || r.only_profile_ids ? K.noteNarrow : null,
  }));
}

// ------------------------------------------------------------------------------------------------ server errors by code
const stripCode = (m: string): string => m.replace(/^[A-Z][A-Z_]{2,}(?::\s*)?/, '').trim();
/** A sentence for a failed call. The code (ShopError.code) decides; the permission hints in the UI are only hints, the server re-checks every call. */
export function rewardsErrorMessage(e: unknown): Msg {
  if (e instanceof ShopError) {
    const detail = stripCode(e.message);
    if (isRewardsError(e, 'FORBIDDEN')) return msg(K.forbidden);
    if (isRewardsError(e, 'INACTIVE_SKU')) return detail ? msg(K.inactiveSku, { sku: detail }) : msg(K.inactiveSkuAny);
    if (isRuleUsedError(e)) return msg(K.ruleUsed);
    if (isRewardsError(e, 'BAD_RULE')) return detail ? msg(K.badRule, { detail }) : msg(K.badRuleAny);
    if (isRewardsError(e, 'BAD_PACK')) return detail ? msg(K.badPack, { detail }) : msg(K.badPackAny);
    if (isRewardsError(e, 'REWARDS_OFF')) return msg(K.off);
    if (isRewardsError(e, 'NOT_FOUND')) return msg(K.notFound);
    if (isRewardsError(e, 'NETWORK')) return msg(K.network);
    if (isRewardsError(e, 'KEY_REUSED', 'INVALID_KEY')) return msg(K.keyReused);
    return detail ? msg(K.other, { detail }) : msg(K.otherAny);
  }
  if (e instanceof Error && e.message.trim()) return msg(K.other, { detail: e.message.trim() });
  return msg(K.otherAny);
}

// ------------------------------------------------------------------------------------------------ promotion packs
export interface PackItemForm { sku_code: string; qty: number }
export interface PackForm { name: string; price: number | ''; items: PackItemForm[]; pointsPerPack: number | ''; eligibleValue: number | '' }
export type PackField = 'name' | 'price' | 'items' | 'pointsPerPack' | 'eligibleValue';
export type PackErrors = Partial<Record<PackField, Msg>>;

export const newPackForm = (): PackForm => ({ name: '', price: '', items: [], pointsPerPack: '', eligibleValue: '' });
export const packToForm = (p: Pack): PackForm => ({
  name: p.name, price: p.price, items: p.items.map((i) => ({ sku_code: i.sku_code, qty: i.qty })), pointsPerPack: p.points_per_pack ?? '', eligibleValue: p.eligible_value ?? '',
});
/** Contents cannot change once the pack has been sold (a different content is a different pack SKU). */
export const packIsLocked = (p: Pack): boolean => p.sold_packs > 0;

export function validatePackForm(f: PackForm, ctx: { inactive?: Set<string> } = {}): PackErrors {
  const e: PackErrors = {};
  if (!f.name.trim()) e.name = msg(K.packName);
  if (!posNum(f.price)) e.price = msg(K.packPrice);
  if (!f.items.length) e.items = msg(K.packNone);
  else if (f.items.some((i) => !wholeAtLeast(i.qty, 1))) e.items = msg(K.packQty);
  else if (new Set(f.items.map((i) => i.sku_code)).size !== f.items.length) e.items = msg(K.packTwice);
  else {
    const bad = f.items.filter((i) => ctx.inactive?.has(i.sku_code)).map((i) => i.sku_code);
    if (bad.length) e.items = msg(K.inactive, { list: bad.join(', ') });
  }
  if (f.pointsPerPack !== '' && !wholeAtLeast(f.pointsPerPack, 0)) e.pointsPerPack = msg(K.packPoints);
  if (f.eligibleValue !== '' && !(typeof f.eligibleValue === 'number' && isFinite(f.eligibleValue) && f.eligibleValue >= 0)) e.eligibleValue = msg(K.packValue);
  return e;
}
/** Arguments of rewardsAdmin.createPack (the key is made by the editor once per open form so a double click is one pack). */
export function packFormToCreate(f: PackForm): { name: string; price: number; items: { sku_code: string; qty: number }[]; patch: PackPatch } {
  const patch: PackPatch = {};
  if (f.pointsPerPack !== '') patch.points_per_pack = f.pointsPerPack;
  if (f.eligibleValue !== '') patch.eligible_value = f.eligibleValue;
  return { name: f.name.trim(), price: num(f.price), items: f.items.map((i) => ({ sku_code: i.sku_code, qty: i.qty })), patch };
}
const sameItems = (a: { sku_code: string; qty: number }[], b: { sku_code: string; qty: number }[]) => {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((i) => [i.sku_code, i.qty]));
  return b.every((i) => m.get(i.sku_code) === i.qty);
};
/** Only what changed. Items are left out for a pack that has been sold, so a stale form can never ask the server to rewrite sold contents. */
export function packPatchFromForm(p: Pack, f: PackForm): PackPatch {
  const patch: PackPatch = {};
  if (f.name.trim() !== p.name) patch.name = f.name.trim();
  if (posNum(f.price) && f.price !== p.price) patch.price = f.price as number;
  if (packIsLocked(p)) return patch;
  const points = f.pointsPerPack === '' ? null : f.pointsPerPack;
  if (points !== p.points_per_pack) patch.points_per_pack = points;
  const value = f.eligibleValue === '' ? null : f.eligibleValue;
  if (value !== p.eligible_value) patch.eligible_value = value;
  if (!sameItems(p.items, f.items)) patch.items = f.items.map((i) => ({ sku_code: i.sku_code, qty: i.qty }));
  return patch;
}
/** A UUID for rewardsAdmin.createPack (p_key is a uuid column). */
export function newPackKey(): string {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID(); } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
}

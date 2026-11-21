// The pure logic behind the back-office rule and pack forms (src/rewards/ruleForm.ts): the per-bill arithmetic the form PREVIEWS (the server decides
// for real, see supabase/tests/rewards_core.sql), the two starting templates, validation that mirrors the server, the dates, the simulator by bill
// amount, error wording by ShopError.code, and that every sentence the screens can show has a Thai text.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ShopError } from '../../src/shop/api';
import { t, TH } from '../../src/lib/i18n';
import type { CustomerHit, Pack, Rule } from '../../src/rewards/api';
import {
  addToList, bangkokEnd, bangkokStart, customerLabel, DEFAULT_REWARD, DEFAULT_STEP, duplicateRuleForm, formToPatch, isRuleUsedError, newPackForm, newPackKey, newRuleForm, nextRewardIn,
  packFormToCreate, packIsLocked, packPatchFromForm, packToForm, previewBills, previewRights, RULE_TEXT_KEYS, rewardsErrorMessage, ruleIsUsed, ruleSentences, ruleToForm, simulateAmount,
  toBangkokDate, todayBangkok, validateFrozenRuleForm, validatePackForm, validateRuleForm, type PackForm, type RuleForm,
} from '../../src/rewards/ruleForm';

const say = (p: { key: string; vars: Record<string, string | number> }) => t('en', p.key, p.vars);
const form = (over: Partial<RuleForm> = {}): RuleForm => ({ ...newRuleForm('points', 'Spend rule'), ...over });
const boardForm = (over: Partial<RuleForm> = {}): RuleForm => ({ ...newRuleForm('board_pick', 'Pick rule'), eventId: 'ev-1', ...over });
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1', kind: 'board_pick', name: 'Pick rule', active: true, starts_at: null, ends_at: null, spend_step: 300, reward_amount: 1, basis: 'per_bill', max_per_order: null,
  category_codes: [], include_skus: [], exclude_skus: [], include_packs: false, only_profile_ids: null, event_id: 'ev-1', board_slots: null, stats: { bills: 0, granted: 0 }, ...over,
});

describe('a bill earns floor(eligible amount / step) x reward, per bill', () => {
  it.each([[0, 0], [1, 0], [299, 0], [299.99, 0], [300, 1], [300.01, 1], [599, 1], [599.99, 1], [600, 2], [850, 2], [900, 3], [999.99, 3], [1000, 3], [1200, 4]])(
    'THB %s on one bill -> %s pick(s) at step 300 / reward 1', (amount, picks) => { expect(previewRights(amount, 300, 1, null)).toBe(picks); });
  it('the reward amount multiplies the steps', () => { expect(previewRights(600, 300, 2, null)).toBe(4); expect(previewRights(299, 300, 2, null)).toBe(0); });
  it('another step works the same way', () => { expect(previewRights(250, 100, 1, null)).toBe(2); expect(previewRights(49.99, 50, 1, null)).toBe(0); expect(previewRights(50, 50, 1, null)).toBe(1); });
  it('max per bill caps the picks', () => { expect(previewRights(1200, 300, 1, 3)).toBe(3); expect(previewRights(600, 300, 1, 3)).toBe(2); });
  it('never rounds up, even with float noise or more than two decimals', () => {
    expect(previewRights(299.995, 300, 1, null)).toBe(0);
    expect(previewRights(0.1 + 0.2 + 299.7, 300, 1, null)).toBe(1);       // 300.00000000000006 is 300
    expect(previewRights(599.9999999, 300, 1, null)).toBe(1);
  });
  it('rubbish in, nothing out', () => {
    for (const bad of [NaN, -5, Infinity]) expect(previewRights(bad, 300, 1, null)).toBe(0);
    expect(previewRights(900, 0, 1, null)).toBe(0); expect(previewRights(900, -300, 1, null)).toBe(0); expect(previewRights(900, 300, 0, null)).toBe(0);
  });
  it('bills are never combined: two bills of 200 earn nothing, 700 + 200 earn 2', () => {
    expect(previewBills([200, 200], 300, 1, null)).toBe(0);
    expect(previewBills([700, 200], 300, 1, null)).toBe(2);
    expect(previewBills([300, 300, 300], 300, 1, null)).toBe(3);
    expect(previewBills([1200, 1200], 300, 1, 3)).toBe(6);                // the cap is per bill, not in total
  });
});

describe('how much more earns the next reward', () => {
  it.each([[0, 300], [1, 299], [299, 1], [300, 300], [850, 50], [599.5, 0.5], [299.99, 0.01]])('THB %s -> THB %s more', (amount, more) => { expect(nextRewardIn(amount, 300, 1, null)).toBe(more); });
  it('is nothing once the cap is reached', () => { expect(nextRewardIn(600, 300, 1, 2)).toBeNull(); expect(nextRewardIn(850, 300, 1, 2)).toBeNull(); expect(nextRewardIn(599, 300, 1, 2)).toBe(1); });
  it('is nothing for a rule that cannot earn', () => { expect(nextRewardIn(100, 0, 1, null)).toBeNull(); expect(nextRewardIn(100, 300, 0, null)).toBeNull(); expect(nextRewardIn(NaN, 300, 1, null)).toBe(300); });
});

describe('the two templates start with the common values', () => {
  it('"Number picks per bill": step 300, 1 pick, per bill, no event yet, nothing hidden switched on', () => {
    const f = newRuleForm('board_pick', 'Number picks per bill');
    expect(f).toMatchObject({ kind: 'board_pick', name: 'Number picks per bill', spendStep: DEFAULT_STEP, rewardAmount: DEFAULT_REWARD, basis: 'per_bill', maxPerOrder: '', eventId: '', boardSlots: [], includePacks: false, active: true });
    expect(DEFAULT_STEP).toBe(300); expect(DEFAULT_REWARD).toBe(1);
  });
  it('"Points per baht spent": the same values, per bill', () => {
    expect(newRuleForm('points', 'Points per baht spent')).toMatchObject({ kind: 'points', spendStep: 300, rewardAmount: 1, basis: 'per_bill', eventId: '' });
  });
  it('every other list starts empty, so the rule applies to everything until narrowed', () => {
    const f = newRuleForm('board_pick', 'x');
    expect([f.categories, f.includeSkus, f.excludeSkus]).toEqual([[], [], []]);
    expect([f.startDate, f.endDate]).toEqual(['', '']);          // no start date = from now: bills paid before the rule exists do not earn
    expect(f.customers).toEqual([]);
  });
});

describe('the sentence under the form says what the rule does', () => {
  it('board picks: every complete step on ONE bill, with an example and the never-combined reminder', () => {
    const lines = ruleSentences(boardForm()).map(say);
    expect(lines[0]).toBe('Every complete ฿300 on one bill = 1 pick.');
    expect(lines[1]).toBe('฿850 on one bill → 2 picks.');
    expect(lines[2]).toBe('Bills are never added together: two bills of ฿200 earn nothing.');
  });
  it('points, per bill and in total', () => {
    expect(ruleSentences(form()).map(say).slice(0, 2)).toEqual(['Every complete ฿300 on one bill = 1 point.', '฿850 on one bill → 2 points.']);
    const cum = ruleSentences(form({ basis: 'cumulative', spendStep: 100, rewardAmount: 5 })).map(say);
    expect(cum[0]).toBe('Every complete ฿100 spent in total = 5 points.');
    expect(cum.some((l) => /never added together/.test(l))).toBe(false);
  });
  it('says when it starts counting: from now by default, never back in time unless a date was chosen', () => {
    const today = '2026-11-21';
    expect(ruleSentences(boardForm(), today).map(say).at(-1)).toBe('Counts bills from now on. Bills paid before this rule exists do not earn.');
    expect(ruleSentences(boardForm({ startDate: '2026-11-01' }), today).map(say).at(-1)).toBe('Also counts bills placed since 2026-11-01, once rewards are switched on.');
    expect(ruleSentences(boardForm({ startDate: '2026-11-21' }), today).map(say).at(-1)).toBe('Also counts bills placed since 2026-11-21, once rewards are switched on.');
    expect(ruleSentences(boardForm({ startDate: '2026-12-01' }), today).map(say).at(-1)).toBe('Starts counting on 2026-12-01.');
    expect(ruleSentences(boardForm({ id: 'r1', startDate: '2026-11-01' }), today).map(say).at(-1)).toBe('Counts bills placed from 2026-11-01.');   // a saved rule: the start was set when it was created, not chosen
  });
  it('mentions the cap per bill', () => { expect(ruleSentences(boardForm({ maxPerOrder: 3 })).map(say)).toContain('At most 3 picks per bill.'); expect(ruleSentences(form({ maxPerOrder: 1 })).map(say)).toContain('At most 1 point per bill.'); });
  it('the example always agrees with the arithmetic and is never an exact multiple', () => {
    for (const step of [50, 100, 250, 300, 500, 1000]) {
      const [, ex] = ruleSentences(boardForm({ spendStep: step }));
      const amount = Number(/฿(\d+)/.exec(say(ex))![1]); const picks = Number(/→ (\d+)/.exec(say(ex))![1]);
      expect(picks, `step ${step}`).toBe(previewRights(amount, step, 1, null));
      expect(amount % step, `step ${step}`).not.toBe(0);
    }
  });
  it('says nothing while the numbers are not valid', () => { expect(ruleSentences(boardForm({ spendStep: '' }))).toEqual([]); expect(ruleSentences(boardForm({ rewardAmount: 0 }))).toEqual([]); });
  it('every sentence and message in the rule form has a Thai text', () => { for (const k of RULE_TEXT_KEYS) expect(TH[k], k).toBeTruthy(); });
});

describe('validation mirrors the server', () => {
  it('a fresh template with a name and an event is valid', () => { expect(validateRuleForm(boardForm())).toEqual({}); expect(validateRuleForm(form())).toEqual({}); });
  it('needs a name', () => { expect(validateRuleForm(form({ name: '   ' })).name).toBeTruthy(); });
  it('step must be above zero; reward a whole number of at least 1', () => {
    for (const v of ['', 0, -5] as const) expect(validateRuleForm(form({ spendStep: v })).spendStep, String(v)).toBeTruthy();
    for (const v of ['', 0, 1.5, -1] as const) expect(validateRuleForm(form({ rewardAmount: v })).rewardAmount, String(v)).toBeTruthy();
    expect(validateRuleForm(form({ spendStep: 0.5, rewardAmount: 2 }))).toEqual({});
  });
  it('max per bill is empty or a whole number of at least 1', () => {
    expect(validateRuleForm(form({ maxPerOrder: '' })).maxPerOrder).toBeUndefined();
    expect(validateRuleForm(form({ maxPerOrder: 3 })).maxPerOrder).toBeUndefined();
    for (const v of [0, 2.5, -1]) expect(validateRuleForm(form({ maxPerOrder: v })).maxPerOrder, String(v)).toBeTruthy();
  });
  it('board picks need an event, and are only ever per bill', () => {
    expect(validateRuleForm(boardForm({ eventId: '' })).eventId).toBeTruthy();
    expect(validateRuleForm(boardForm({ basis: 'cumulative' })).basis).toBeTruthy();
    expect(validateRuleForm(form({ basis: 'cumulative' })).basis).toBeUndefined();
  });
  it('the end date cannot be before the start date', () => {
    expect(validateRuleForm(form({ startDate: '2026-12-01', endDate: '2026-11-30' })).endDate).toBeTruthy();
    expect(validateRuleForm(form({ startDate: '2026-12-01', endDate: '2026-12-01' })).endDate).toBeUndefined();
    expect(validateRuleForm(form({ startDate: '2026-12-01', endDate: '' }))).toEqual({});
  });
  it('a rule that is being edited keeps a start date (an empty one would mean "from the beginning"); a new rule may leave it empty', () => {
    expect(validateRuleForm(form({ id: null, startDate: '' }))).toEqual({});
    expect(validateRuleForm(form({ id: 'r1', startDate: '' })).startDate).toBeTruthy();
    expect(validateRuleForm(form({ id: 'r1', startDate: '2026-11-21' }))).toEqual({});
  });
  it('the allow-list is a list of chosen customers, empty means everyone', () => {
    expect(validateRuleForm(form({ customers: ['11111111-1111-4111-8111-111111111111'] }))).toEqual({});
    expect(validateRuleForm(form({ customers: [] }))).toEqual({});
  });
  it('an inactive SKU in the include list blocks saving, and the message names it', () => {
    const f = form({ includeSkus: ['FG-000001', 'FG-000002'] });
    expect(say(validateRuleForm(f, { inactive: new Set(['FG-000002']) }).includeSkus!)).toContain('FG-000002');
    expect(validateRuleForm(f, { inactive: new Set() })).toEqual({});
    expect(validateRuleForm(form({ excludeSkus: ['FG-000002'] }), { inactive: new Set(['FG-000002']) })).toEqual({});     // excluding an inactive SKU is harmless
  });
});

describe('what is sent to the server', () => {
  it('board pick: per bill, its event, the boards it may use, trimmed name; nothing else', () => {
    const patch = formToPatch(boardForm({ name: '  Pick rule ', boardSlots: [1, 3], maxPerOrder: 4, includePacks: true }));
    expect(patch).toEqual({
      kind: 'board_pick', name: 'Pick rule', active: true, starts_at: null, ends_at: null, spend_step: 300, reward_amount: 1, basis: 'per_bill', max_per_order: 4,
      category_codes: [], include_skus: [], exclude_skus: [], include_packs: true, only_profile_ids: null, event_id: 'ev-1', board_slots: [1, 3],
    });
  });
  it('all three boards ticked, or none, means "any board" (null)', () => {
    expect(formToPatch(boardForm({ boardSlots: [1, 2, 3] })).board_slots).toBeNull();
    expect(formToPatch(boardForm({ boardSlots: [] })).board_slots).toBeNull();
  });
  it('points: no event, no boards, even if the form still holds some from a template switch', () => {
    const p = formToPatch(form({ eventId: 'ev-1', boardSlots: [2], basis: 'cumulative' }));
    expect(p).toMatchObject({ kind: 'points', basis: 'cumulative', event_id: null, board_slots: null });
  });
  it('a board pick is always sent per bill, whatever the form says', () => { expect(formToPatch(boardForm({ basis: 'cumulative' })).basis).toBe('per_bill'); });
  it('lists are copied, categories and SKUs as chosen; the allow-list is the ids of the chosen customers', () => {
    const p = formToPatch(form({ categories: ['vape'], includeSkus: ['FG-000001'], excludeSkus: ['FG-000009'], customers: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] }));
    expect(p).toMatchObject({ category_codes: ['vape'], include_skus: ['FG-000001'], exclude_skus: ['FG-000009'], only_profile_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] });
  });
  it('the window is Bangkok time, whole days', () => {
    expect(formToPatch(form({ startDate: '2026-12-01', endDate: '2026-12-31' }))).toMatchObject({ starts_at: '2026-12-01T00:00:00+07:00', ends_at: '2026-12-31T23:59:59+07:00' });
  });
  it('editing an existing rule and saving unchanged gives back the same rule', () => {
    const r = rule({ starts_at: '2026-11-30T17:00:00Z', ends_at: '2026-12-31T16:59:59Z', category_codes: ['vape'], include_skus: ['FG-000001'], exclude_skus: ['FG-000009'], board_slots: [1, 2], max_per_order: 5, only_profile_ids: ['11111111-1111-4111-8111-111111111111'] });
    const f = ruleToForm(r);
    expect(f).toMatchObject({ id: 'r1', startDate: '2026-12-01', endDate: '2026-12-31', boardSlots: [1, 2], maxPerOrder: 5, customers: ['11111111-1111-4111-8111-111111111111'], eventId: 'ev-1' });
    const { stats: _s, id: _i, ...fields } = r; void _s; void _i;
    expect(formToPatch(f)).toEqual({ ...fields, starts_at: '2026-12-01T00:00:00+07:00', ends_at: '2026-12-31T23:59:59+07:00' });
  });
  it('no customers chosen sends null (everyone), never an empty list', () => { expect(formToPatch(form({ customers: [] })).only_profile_ids).toBeNull(); });
  it('a points rule loaded for editing stays a points rule', () => { expect(ruleToForm(rule({ kind: 'points', event_id: null, basis: 'cumulative' }))).toMatchObject({ kind: 'points', basis: 'cumulative', eventId: '' }); });
});

describe('dates are Bangkok days', () => {
  it('a day starts at 00:00 and ends at 23:59:59 Bangkok time', () => { expect(bangkokStart('2026-11-21')).toBe('2026-11-21T00:00:00+07:00'); expect(bangkokEnd('2026-11-21')).toBe('2026-11-21T23:59:59+07:00'); expect(bangkokStart('')).toBeNull(); expect(bangkokEnd('')).toBeNull(); });
  it('a timestamp shows as its Bangkok day', () => {
    expect(toBangkokDate('2026-11-20T17:00:00Z')).toBe('2026-11-21');
    expect(toBangkokDate('2026-11-21T16:59:59Z')).toBe('2026-11-21');
    expect(toBangkokDate('2026-11-21T17:00:00Z')).toBe('2026-11-22');
    expect(toBangkokDate(null)).toBe('');
  });
});

describe('today in Bangkok', () => {
  it('rolls over at midnight Bangkok time, not UTC', () => {
    expect(todayBangkok(Date.parse('2026-11-20T16:59:59Z'))).toBe('2026-11-20');
    expect(todayBangkok(Date.parse('2026-11-20T17:00:00Z'))).toBe('2026-11-21');
  });
});

describe('customers chosen for a rule', () => {
  const hit = (over: Partial<CustomerHit> = {}): CustomerHit => ({ id: '11111111-1111-4111-8111-111111111111', name: 'Somchai', phone: '0812345678', email: 'somchai@example.test', ...over });
  it('a chip shows the name and how to tell people apart', () => {
    expect(customerLabel(hit(), 'x')).toEqual({ title: 'Somchai', detail: '0812345678' });
    expect(customerLabel(hit({ phone: null }), 'x')).toEqual({ title: 'Somchai', detail: 'somchai@example.test' });
    expect(customerLabel(hit({ name: null }), 'x')).toEqual({ title: '0812345678', detail: 'somchai@example.test' });
    expect(customerLabel(hit({ name: ' ', phone: null, email: null }), 'x').title).toBe('…11111111');
  });
  it('an id nobody has looked up yet still shows something short and stable', () => { expect(customerLabel(undefined, '22222222-2222-4222-8222-222222222222')).toEqual({ title: '…22222222', detail: '' }); });
});

describe('editing a saved rule that is not used yet never re-sends a date nobody changed (review round 1)', () => {
  // created "From now" at 14:30 Bangkok: the stored start is that moment, and the form can only show its DAY
  const saved = rule({ starts_at: '2026-11-21T07:30:00Z', ends_at: null, stats: { bills: 0, granted: 0 } });
  it('an unchanged start is NOT sent: re-sending the day would move it back to midnight and make the morning bills count', () => {
    const patch = formToPatch({ ...ruleToForm(saved), name: 'Renamed' }, { original: saved });
    expect('starts_at' in patch).toBe(false);
    expect('ends_at' in patch).toBe(false);
    expect(patch.name).toBe('Renamed');
  });
  it('a start the user changed IS sent, and so is an end date they added or removed', () => {
    expect(formToPatch({ ...ruleToForm(saved), startDate: '2026-12-01' }, { original: saved }).starts_at).toBe('2026-12-01T00:00:00+07:00');
    expect(formToPatch({ ...ruleToForm(saved), endDate: '2026-12-31' }, { original: saved }).ends_at).toBe('2026-12-31T23:59:59+07:00');
    const ended = rule({ starts_at: '2026-11-21T07:30:00Z', ends_at: '2026-12-31T16:59:59Z' });
    expect(formToPatch({ ...ruleToForm(ended), endDate: '' }, { original: ended }).ends_at).toBeNull();
  });
  it('a new rule (no original) still sends its dates: empty means "from now" (null) and the server stamps the moment', () => {
    expect(formToPatch(form({ startDate: '' })).starts_at).toBeNull();
    expect(formToPatch(form({ startDate: '2026-12-01' })).starts_at).toBe('2026-12-01T00:00:00+07:00');
  });
});

describe('a rule that has already given rewards is frozen', () => {
  const used = rule({ stats: { bills: 4, granted: 7 }, starts_at: '2026-11-20T17:00:00Z', ends_at: '2026-12-31T16:59:59Z', category_codes: ['vape'] });
  it('used means it has given something; a fresh rule is not', () => {
    expect(ruleIsUsed(used)).toBe(true); expect(ruleIsUsed(rule())).toBe(false); expect(ruleIsUsed(rule({ stats: { bills: 2, granted: 0 } }))).toBe(false);
  });
  it('only the name, active and a later end date are sent; nothing frozen is sent at all', () => {
    const f = ruleToForm(used);
    expect(formToPatch({ ...f, name: ' Renamed ', active: false }, { frozenFrom: used })).toEqual({ name: 'Renamed', active: false });
    expect(formToPatch({ ...f, endDate: '2027-01-31' }, { frozenFrom: used })).toEqual({ name: 'Pick rule', active: true, ends_at: '2027-01-31T23:59:59+07:00' });
    expect(formToPatch({ ...f, endDate: '' }, { frozenFrom: used })).toEqual({ name: 'Pick rule', active: true, ends_at: null });
  });
  it('even if the form was changed on the way, the frozen fields cannot leak into the patch', () => {
    const f = { ...ruleToForm(used), spendStep: 100, categories: [], eventId: 'other' };
    expect(Object.keys(formToPatch(f, { frozenFrom: used })).sort()).toEqual(['active', 'name']);
  });
  it('the end date can only be moved later or removed; a rule with no end date keeps none', () => {
    const f = ruleToForm(used);
    expect(validateFrozenRuleForm(f, used)).toEqual({});
    expect(validateFrozenRuleForm({ ...f, endDate: '2027-01-31' }, used)).toEqual({});
    expect(validateFrozenRuleForm({ ...f, endDate: '' }, used)).toEqual({});
    expect(validateFrozenRuleForm({ ...f, endDate: '2026-12-30' }, used).endDate).toBeTruthy();
    expect(validateFrozenRuleForm({ ...f, name: ' ' }, used).name).toBeTruthy();
    const open = rule({ stats: { bills: 1, granted: 1 } });
    expect(validateFrozenRuleForm({ ...ruleToForm(open), endDate: '2027-01-31' }, open).endDate).toBeTruthy();
  });
  it('the server saying RULE_USED is recognised, and read as a sentence that points to Duplicate', () => {
    const e = new ShopError('BAD_RULE: RULE_USED', 'BAD_RULE');
    expect(isRuleUsedError(e)).toBe(true);
    expect(isRuleUsedError(new ShopError('BAD_RULE: RULE_USED: spend_step', 'BAD_RULE'))).toBe(true);
    expect(isRuleUsedError(new ShopError('BAD_RULE: spend_step must be above 0', 'BAD_RULE'))).toBe(false);
    expect(isRuleUsedError(new ShopError('RULE_USED', 'ERROR'))).toBe(false);
    expect(isRuleUsedError(new Error('x'))).toBe(false);
    expect(say(rewardsErrorMessage(e))).toBe('This rule has already given rewards. To change how it works, duplicate it.');
  });
  it('Duplicate: a new, inactive rule named "(copy)" with the same settings, starting from now', () => {
    const d = duplicateRuleForm(used, '2026-11-21');
    expect(d).toMatchObject({ id: null, name: 'Pick rule (copy)', active: false, startDate: '', endDate: '2026-12-31', kind: 'board_pick', spendStep: 300, categories: ['vape'], eventId: 'ev-1' });
    expect(d.categories).not.toBe(ruleToForm(used).categories);                         // a copy, not the same array
    expect(duplicateRuleForm(rule({ name: 'Pick rule (copy)' }), '2026-11-21').name).toBe('Pick rule (copy)');
    expect(duplicateRuleForm(rule({ ends_at: '2026-10-31T16:59:59Z' }), '2026-11-21').endDate).toBe('');   // an end date already past is not carried over
    expect(duplicateRuleForm(rule({ only_profile_ids: ['11111111-1111-4111-8111-111111111111'] }), '2026-11-21').customers).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(validateRuleForm(d)).toEqual({});
  });
});

describe('adding to a list', () => {
  it('keeps the order and never adds twice', () => { expect(addToList(['a'], 'b')).toEqual(['a', 'b']); expect(addToList(['a', 'b'], 'a')).toEqual(['a', 'b']); });
});

describe('simulator by bill amount', () => {
  const rules = [
    rule({ id: 'a', name: 'Picks', kind: 'board_pick' }),
    rule({ id: 'b', name: 'Points', kind: 'points', event_id: null, spend_step: 100, reward_amount: 2 }),
    rule({ id: 'c', name: 'Total points', kind: 'points', event_id: null, basis: 'cumulative', spend_step: 500 }),
    rule({ id: 'd', name: 'Switched off', active: false }),
  ];
  it('assumes the whole bill is eligible, for every active rule', () => {
    const out = simulateAmount(rules, 850);
    expect(out.map((l) => l.rule_id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toMatchObject({ rule_name: 'Picks', kind: 'board_pick', eligible_amount: 850, reward: 2, next_reward_in: 50 });
    expect(out[1]).toMatchObject({ reward: 16, next_reward_in: 50 });
  });
  it('says so when the rule counts the whole spend (cumulative) or is narrowed to some products', () => {
    const out = simulateAmount([...rules, rule({ id: 'e', name: 'Narrow', category_codes: ['vape'] })], 850);
    expect(out.find((l) => l.rule_id === 'c')!.note).toBeTruthy();
    expect(out.find((l) => l.rule_id === 'e')!.note).toBeTruthy();
    expect(out.find((l) => l.rule_id === 'a')!.note).toBeNull();
  });
  it('a bill under the step earns nothing and shows what is missing', () => { expect(simulateAmount([rules[0]], 299)[0]).toMatchObject({ reward: 0, next_reward_in: 1 }); });
});

describe('errors are explained by their code', () => {
  const err = (code: string, message = code) => new ShopError(message, code);
  it('a permission failure is a plain sentence, however it was raised', () => {
    expect(say(rewardsErrorMessage(err('FORBIDDEN')))).toMatch(/not allowed/i);
  });
  it('an inactive SKU names the SKU', () => {
    const m = rewardsErrorMessage(err('INACTIVE_SKU', 'INACTIVE_SKU: FG-000123'));
    expect(m.vars.sku).toBe('FG-000123'); expect(say(m)).toContain('FG-000123'); expect(say(m)).toMatch(/inactive/i);
  });
  it('a bad rule or pack says what the server did not accept', () => {
    expect(say(rewardsErrorMessage(err('BAD_RULE', 'BAD_RULE: spend_step must be greater than 0')))).toContain('spend_step must be greater than 0');
    expect(say(rewardsErrorMessage(err('BAD_PACK', 'BAD_PACK: contents are locked once sold')))).toContain('contents are locked once sold');
    expect(say(rewardsErrorMessage(err('BAD_RULE')))).not.toContain('{detail}');
  });
  it('rewards off, not found, network and a repeated key have their own sentence', () => {
    for (const c of ['REWARDS_OFF', 'NOT_FOUND', 'NETWORK', 'KEY_REUSED']) { const s = say(rewardsErrorMessage(err(c))); expect(s, c).not.toMatch(/^[A-Z_]+$/); expect(s, c).not.toContain('{'); }
  });
  it('anything else shows the server text without the code, never an empty message', () => {
    expect(say(rewardsErrorMessage(err('ERROR', 'something odd')))).toContain('something odd');
    expect(say(rewardsErrorMessage(new Error('boom')))).toContain('boom');
    expect(say(rewardsErrorMessage('x'))).toBeTruthy();
  });
});

const pack = (over: Partial<Pack> = {}): Pack => ({ pack_sku_code: 'FG-000900', name: '4 for 300', price: 300, status: 'active', active: true, eligible_value: null, points_per_pack: 3, items: [{ sku_code: 'FG-000001', name: 'Fruit', qty: 4, status: 'active' }], sold_packs: 0, ...over });
const pform = (over: Partial<PackForm> = {}): PackForm => ({ ...newPackForm(), name: '4 for 300', price: 300, items: [{ sku_code: 'FG-000001', qty: 4 }], pointsPerPack: 3, ...over });

describe('promotion packs', () => {
  it('a new pack form is empty and needs a name, a price and at least one component', () => {
    const f = newPackForm();
    expect(f).toMatchObject({ name: '', price: '', items: [], pointsPerPack: '', eligibleValue: '' });
    const e = validatePackForm(f);
    expect(e.name).toBeTruthy(); expect(e.price).toBeTruthy(); expect(e.items).toBeTruthy();
    expect(validatePackForm(pform())).toEqual({});
  });
  it('the price is above zero, the quantities whole numbers of at least 1', () => {
    expect(validatePackForm(pform({ price: 0 })).price).toBeTruthy();
    expect(validatePackForm(pform({ items: [{ sku_code: 'FG-000001', qty: 0 }] })).items).toBeTruthy();
    expect(validatePackForm(pform({ items: [{ sku_code: 'FG-000001', qty: 1.5 }] })).items).toBeTruthy();
    expect(validatePackForm(pform({ items: [{ sku_code: 'FG-000001', qty: 2 }, { sku_code: 'FG-000002', qty: 1 }] }))).toEqual({});
  });
  it('the same SKU twice is refused (add to its quantity instead)', () => { expect(validatePackForm(pform({ items: [{ sku_code: 'FG-000001', qty: 2 }, { sku_code: 'FG-000001', qty: 1 }] })).items).toBeTruthy(); });
  it('points per pack and eligible value are empty or not negative; points are whole', () => {
    expect(validatePackForm(pform({ pointsPerPack: '', eligibleValue: '' }))).toEqual({});
    expect(validatePackForm(pform({ pointsPerPack: 0 }))).toEqual({});                       // 0 = this pack earns no points, and stays out of the points rules
    expect(validatePackForm(pform({ pointsPerPack: -1 })).pointsPerPack).toBeTruthy();
    expect(validatePackForm(pform({ pointsPerPack: 1.5 })).pointsPerPack).toBeTruthy();
    expect(validatePackForm(pform({ eligibleValue: -5 })).eligibleValue).toBeTruthy();
    expect(validatePackForm(pform({ eligibleValue: 280 }))).toEqual({});
  });
  it('an inactive component blocks saving a new pack', () => { expect(say(validatePackForm(pform(), { inactive: new Set(['FG-000001']) }).items!)).toContain('FG-000001'); });
  it('create call: trimmed name, price, [{sku_code, qty}], the optional numbers in the patch', () => {
    expect(packFormToCreate(pform({ name: ' 4 for 300 ', eligibleValue: 280 }))).toEqual({ name: '4 for 300', price: 300, items: [{ sku_code: 'FG-000001', qty: 4 }], patch: { points_per_pack: 3, eligible_value: 280 } });
    expect(packFormToCreate(pform({ pointsPerPack: '', eligibleValue: '' })).patch).toEqual({});
  });
  it('once sold, the contents, the eligible value and the points per pack are locked; name, price and on-sale stay open', () => {
    expect(packIsLocked(pack({ sold_packs: 0 }))).toBe(false); expect(packIsLocked(pack({ sold_packs: 1 }))).toBe(true);
  });
  it('saving an existing pack sends only what changed, and never a locked field once the pack has been sold', () => {
    const p = pack({ sold_packs: 2 });
    expect(packPatchFromForm(p, { ...pform(), name: '4 for 300', price: 300, pointsPerPack: 3, eligibleValue: '', items: [{ sku_code: 'FG-000001', qty: 4 }] })).toEqual({});
    expect(packPatchFromForm(p, pform({ price: 320, pointsPerPack: '', eligibleValue: 250, items: [{ sku_code: 'FG-000001', qty: 6 }] }))).toEqual({ price: 320 });
    expect(packPatchFromForm(p, pform({ name: 'Renamed' }))).toEqual({ name: 'Renamed' });
    const open = pack({ sold_packs: 0 });
    expect(packPatchFromForm(open, pform({ items: [{ sku_code: 'FG-000001', qty: 6 }] }))).toEqual({ items: [{ sku_code: 'FG-000001', qty: 6 }] });
    expect(packPatchFromForm(open, pform({ pointsPerPack: '', eligibleValue: 250 }))).toEqual({ points_per_pack: null, eligible_value: 250 });   // not sold yet: still open
  });
  it('editing a pack starts from what it is now', () => {
    expect(packToForm(pack({ eligible_value: 280, points_per_pack: null }))).toEqual({ name: '4 for 300', price: 300, items: [{ sku_code: 'FG-000001', qty: 4 }], pointsPerPack: '', eligibleValue: 280 });
  });
  it('a pack key is a UUID, and a new one each time', () => {
    const a = newPackKey(); const b = newPackKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i); expect(a).not.toBe(b);
  });
});

describe('every string the Online shop tab shows has a Thai text', () => {
  // Walks the real syntax tree of the new screens and collects every piece of English copy they can show: text between tags, the kit's label props, and any
  // string literal that reads like a sentence (what is passed to T(), Select options, Seg and Tabs). A missing Thai text is a screen that mixes languages.
  const FILES = ['src/rewards/PromotionsOnline.tsx', 'src/rewards/RuleEditor.tsx', 'src/rewards/PackEditor.tsx'];
  const known = (s: string) => s in TH;
  const COPY_PROPS = new Set(['title', 'label', 'desc', 'sub', 'hint', 'placeholder', 'header', 'aria-label']);
  const looksLikeCopy = (q: string) => /^[A-Z฿{0-9]/.test(q) && /[A-Za-z]{3}/.test(q) && !/^\d+(px|em|rem|%)\b/.test(q) && (/ /.test(q) || /^[A-Z][a-z]{2,}$/.test(q)) && !/[;<>]/.test(q);
  const found = (file: string): string[] => {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const out = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isJsxText(n)) { const x = n.text.replace(/\s+/g, ' ').trim(); if (/[A-Za-z]{3}/.test(x)) out.add(x); }
      else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const p = n.parent;
        if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p)) { /* module names and types */ }
        else if (ts.isJsxAttribute(p)) { if (COPY_PROPS.has(p.name.getText())) out.add(n.text.trim()); }
        else if (looksLikeCopy(n.text)) out.add(n.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return [...out];
  };
  it.each(FILES)('%s', (file) => {
    const copy = found(file);
    expect(copy.length, 'the scan found no copy at all: the scanner is broken').toBeGreaterThan(10);
    expect(copy.filter((s) => !known(s))).toEqual([]);
  });
  it('the legacy page keeps its own wording: only the new tab bar is added', () => {
    const src = readFileSync('src/pages/Promotions.tsx', 'utf8');
    for (const s of ['Online shop', 'POS on this device']) expect(known(s), s).toBe(true);
    expect(src).toContain('LegacyPromotions');
  });
});

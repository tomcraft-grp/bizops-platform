// Every text of the preorder screens has its Thai, and the Thai says the same placeholders as the English. Back office: lib/i18n.preorders.ts (English source -> Thai).
// Customer app: shop/i18n.preorder.ts ([Thai, English] pairs), whose keys are also covered by the shop dictionary test.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TH } from '../../src/lib/i18n';
import { TH_PREORDERS } from '../../src/lib/i18n.preorders';
import { PREORDER_D } from '../../src/shop/i18n.preorder';
import { SHOP_KEYS, tr } from '../../src/shop/i18n';

const THAI = /[ก-๿]/;
const FILES = ['src/preorders/PreordersPage.tsx', 'src/preorders/PrepBoard.tsx', 'src/preorders/parts.tsx', 'src/preorders/view.ts'].map((f) => readFileSync(f, 'utf8'));
const unq = (s: string) => s.replace(/\\'/g, "'");

/** The English source strings: every string literal inside a `T(...)` call (also the branches of a ternary), and the string tables of view.ts and PreordersPage.tsx. */
function sourceTexts(): string[] {
  const out = new Set<string>();
  for (const s of FILES) {
    for (let i = 0; (i = s.indexOf('T(', i)) >= 0; i += 2) {
      if (i > 0 && /[A-Za-z0-9_$.]/.test(s[i - 1])) continue;
      let d = 0; let j = i + 2; let arg = '';
      for (; j < s.length; j++) { const c = s[j]; if (c === '(') d++; else if (c === ')') { if (d === 0) break; d--; } else if (c === ',' && d === 0) break; arg += c; }
      for (const m of arg.matchAll(/'((?:[^'\\]|\\.)*)'/g)) out.add(unq(m[1]));
    }
    for (const m of s.matchAll(/(?:label|hint): '((?:[^'\\]|\\.)*)'/g)) out.add(unq(m[1]));
  }
  const view = FILES[3];
  for (const m of view.matchAll(/^\s+\w+: '((?:[^'\\]|\\.)*)',?\s*$/gm)) out.add(unq(m[1]));
  for (const m of view.matchAll(/(?:new|confirmed|preparing|packed|ready|shipped|completed|cancelled|returned): '((?:[^'\\]|\\.)*)'/g)) out.add(unq(m[1]));
  for (const m of FILES[0].matchAll(/\b\w+: '((?:[^'\\]|\\.)*)'/g)) out.add(unq(m[1]));
  return [...out].filter((x) => /[A-Za-z]{2}/.test(x) && !/^[a-z_]+$/.test(x) && !x.startsWith('/') && !/^(2-digit|Asia\/Bangkok)$/.test(x));
}
// words that are the same in both languages or are CSS / data values, not UI copy
const NOT_COPY = new Set(['LINE', 'OK']);

describe('Thai of the back-office preorder screens', () => {
  const texts = sourceTexts();
  it('finds the texts it is meant to check', () => { expect(texts.length).toBeGreaterThan(200); });
  it('every text has Thai', () => { expect(texts.filter((s) => !NOT_COPY.has(s) && !THAI.test(TH[s] ?? ''))).toEqual([]); });
  it('the placeholders are the same in both languages', () => {
    const ph = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join();
    expect(Object.entries(TH_PREORDERS).filter(([en, th]) => ph(en) !== ph(th))).toEqual([]);
  });
  it('a word that another screen already translates means the same here', () => {
    expect(Object.keys(TH_PREORDERS).filter((k) => TH[k] !== TH_PREORDERS[k])).toEqual([]);
  });
});

describe('the customer preorder texts', () => {
  const keys = Object.keys(PREORDER_D) as (keyof typeof PREORDER_D)[];
  it('every key is in the shop dictionary with Thai and English', () => {
    for (const k of keys) { expect(SHOP_KEYS).toContain(k); expect(THAI.test(tr('th', k))).toBe(true); expect(tr('en', k).length).toBeGreaterThan(0); expect(THAI.test(tr('en', k))).toBe(false); }
  });
  it('the Thai and the English use the same placeholders', () => {
    const ph = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join();
    expect(keys.filter((k) => ph(PREORDER_D[k][0]) !== ph(PREORDER_D[k][1]))).toEqual([]);
  });
  it('every coded refusal the database can send has a sentence', () => {
    const codes = ['PREORDER_OFF', 'PREORDER_PICKUP_ONLY', 'SLOT_REQUIRED', 'SLOT_TOO_SOON', 'SLOT_TOO_FAR', 'SLOT_PAST', 'SLOT_CLOSED', 'SLOT_INVALID', 'SLOT_FULL', 'SLOT_UNITS_FULL', 'DAY_UNITS_FULL',
      'RESCHEDULE_LIMIT', 'TOO_LATE_TO_CHANGE', 'NOT_PREORDER', 'ORDER_CLOSED', 'INVALID_MESSAGE', 'TOO_MANY_REQUESTS', 'INVALID_NOTE'];
    for (const c of codes) expect(keys as string[]).toContain(`po.err.${c}`);
  });
  it('every kind of customer notice has a sentence', () => {
    for (const k of ['placed', 'confirmed', 'preparing', 'ready', 'completed', 'rejected', 'cancelled_by_shop', 'rescheduled_by_shop', 'reminder']) expect(keys as string[]).toContain(`po.n.${k}`);
  });
});

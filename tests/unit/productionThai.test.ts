// Every text of the production screens has its Thai (lib/i18n.production.ts), and the Thai says the same placeholders as the English.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TH } from '../../src/lib/i18n';
import { TH_PRODUCTION } from '../../src/lib/i18n.production';
import { bilingualError } from '../../src/lib/errorText';
import { ROLE_DEFS } from '../../src/domain/accounting';

const THAI = /[ก-๿]/;
const FILES = readdirSync('src/production').map((f) => readFileSync(join('src/production', f), 'utf8').replace(/^import .*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
/** Texts are whole sentences or labels: they start with a capital letter. Text between tags is written with T() or inside a kit component that translates it. */
const texts = [...new Set(FILES.flatMap((src) => [
  ...[...src.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")),
  ...[...src.matchAll(/\b(?:title|sub|label|hint|header|placeholder|action)="([^"]+)"/g)].map((m) => m[1]),
  ...[...src.matchAll(/<(?:option value="[^"]*"|Badge(?: tone="\w+")?|Check [^\n]*?\)\})>([A-Za-z][^<{]*)</g)].map((m) => m[1]),
  ...[...src.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")),
]))].filter((s) => /^[A-Z][a-z]/.test(s) && !/^(ArrowDown|ArrowUp|Home|End|Enter|Escape|Tab)$/.test(s) && s !== 'BOM' || /^\{\w+\} (of|good|rejected|still|materials|units|versions|completed|short|in)\b/.test(s) || /^BOM /.test(s) || s === 'BOMs');
const used = [...new Set([...texts, ...FILES.flatMap((src) => [...src.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")))])];

describe('Thai of the production screens', () => {
  it('finds the texts it is meant to check', () => { expect(used.length).toBeGreaterThan(220); });
  it('every text has Thai', () => { expect(used.filter((s) => !THAI.test(TH[s] ?? '') && !bilingualError(s))).toEqual([]); });
  it('the placeholders are the same in both languages', () => {
    const ph = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join();
    expect(Object.entries(TH_PRODUCTION).filter(([en, th]) => ph(en) !== ph(th))).toEqual([]);
  });
  it('a word that another screen already translates means the same here', () => {
    expect(Object.keys(TH_PRODUCTION).filter((k) => TH[k] !== TH_PRODUCTION[k])).toEqual([]);
  });
  it('the posting roles the banner names have Thai', () => {
    for (const k of ['wip', 'inv_materials', 'inv_goods', 'waste', 'conversion_absorbed', 'prod_var_material', 'prod_var_labor', 'prod_var_overhead']) expect(TH[ROLE_DEFS.find((r) => r.key === k)!.label], k).toMatch(THAI);
  });
});

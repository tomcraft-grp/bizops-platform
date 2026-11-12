// Turns the machine-written test results into the evidence documents. Nothing here invents a result: every number is read from
// qa/results/*.json (vitest + Playwright reporters) or from a command executed right now (tsc).
// Run after the suites:  npx vitest run && npx playwright test && npx tsx scripts/perf.ts && npx tsx scripts/qa-evidence.ts
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const rd = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const unit = rd('qa/results/unit.json');
const e2e = rd('qa/results/e2e.json');
const perfE = rd('qa/results/perf-engine.json');
const perfB = rd('qa/results/perf-browser.json');
const sh = (c: string) => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); } catch { return ''; } };

let tscOk = true;
try { execSync('npx tsc --noEmit', { stdio: 'pipe' }); } catch { tscOk = false; }
const commit = sh('git rev-parse --short HEAD');
const dirty = sh('git status --porcelain').length > 0;

type Row = { file: string; group: string; title: string; status: 'passed' | 'failed' | 'skipped'; ms: number; refs: string[] };
const refsOf = (s: string) => Array.from(new Set((s.match(/§\s?[\d.]+(?:[–-][\d.]+)?/g) || []).map((x) => x.replace(/\s/g, ''))));
const rows: Row[] = [];

for (const f of unit?.testResults ?? []) {
  const file = String(f.name).split(/[\\/]/).pop()!;
  for (const a of f.assertionResults) rows.push({ file, group: a.ancestorTitles.join(' › '), title: a.title, status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped', ms: Math.round(a.duration ?? 0), refs: refsOf(a.ancestorTitles.join(' ') + ' ' + a.title) });
}
const walk = (suite: any, trail: string[], file: string) => {
  for (const sp of suite.specs ?? []) {
    const t = sp.tests?.[0];
    const last = t?.results?.[t.results.length - 1];
    const st = sp.ok ? 'passed' : last?.status === 'skipped' || t?.status === 'skipped' ? 'skipped' : 'failed';
    rows.push({ file, group: trail.join(' › '), title: sp.title, status: st, ms: Math.round(last?.duration ?? 0), refs: refsOf(trail.join(' ') + ' ' + sp.title) });
  }
  for (const s of suite.suites ?? []) walk(s, [...trail, s.title], file);
};
for (const s of e2e?.suites ?? []) walk(s, [], String(s.file || s.title).split(/[\\/]/).pop()!);

const kindOf = (r: Row) => (r.file.endsWith('.test.ts') ? 'unit' : r.file.startsWith('journeys') ? 'e2e' : r.file.startsWith('responsive') ? 'responsive' : r.file.startsWith('perf') ? 'perf' : /^axe|^forms/.test(r.title) ? 'a11y' : /^visual/.test(r.title) ? 'visual' : 'e2e');
const agg = (rs: Row[]) => ({ total: rs.length, passed: rs.filter((r) => r.status === 'passed').length, failed: rs.filter((r) => r.status === 'failed').length, skipped: rs.filter((r) => r.status === 'skipped').length });
const kinds = ['unit', 'e2e', 'responsive', 'a11y', 'visual', 'perf'] as const;
const byKind = Object.fromEntries(kinds.map((k) => [k, agg(rows.filter((r) => kindOf(r) === k))]));
const files = Array.from(new Set(rows.map((r) => r.file))).map((f) => ({ file: f, ...agg(rows.filter((r) => r.file === f)) }));

const summary = {
  generatedAt: new Date().toISOString(), commit: commit + (dirty ? '+uncommitted' : ''), typecheck: tscOk ? 'passed' : 'failed',
  totals: agg(rows), byKind, files,
  perf: {
    engine: perfE && { dataset: perfE.dataset, saleP50: perfE.ms.postOnePosSale.p50, saleP95: perfE.ms.postOnePosSale.p95, saleFreezeOffP50: perfE.ms.postOnePosSale_autoFreezeOff_forComparison.p50, seedP50: perfE.ms.seedFullBusiness.p50, integrityP50: perfE.ms.integrityChecks.p50, machine: perfE.machine },
    browser: perfB && { coldStartMs: perfB.coldStartMs, warmReloadMedianMs: perfB.warmReloadMs.median, routeChangeMedianMs: perfB.routeChangeMedianMs, saleClickToConfirmMedianMs: perfB.completeSaleClickToConfirmationMs.median, bundle: perfB.bundle },
  },
};
mkdirSync('src/generated', { recursive: true });
writeFileSync('src/generated/qa-summary.json', JSON.stringify(summary, null, 2));
writeFileSync('qa/results/summary.json', JSON.stringify(summary, null, 2));

// ---------- TEST_CASES/*.md : one traceable table per suite (ID, requirement reference, level, automated location, last result)
mkdirSync('qa/TEST_CASES', { recursive: true });
const ICON = { passed: 'PASSED', failed: 'FAILED', skipped: 'NOT RUN' } as const;
const PREFIX: Record<string, string> = { 'engine.test.ts': 'TC-ENG', 'accounting.test.ts': 'TC-ACC', 'platform.test.ts': 'TC-PLT', 'authz.test.ts': 'TC-AUZ', 'journeys.spec.ts': 'TC-E2E', 'responsive.spec.ts': 'TC-RSP', 'a11y-visual.spec.ts': 'TC-A11', 'perf.spec.ts': 'TC-PRF' };
const TITLE: Record<string, string> = {
  'engine.test.ts': 'Unit & integration — business engine (pricing, promotions, points, payments, inventory, BOM, orders, event numbers)',
  'accounting.test.ts': 'Unit & integration — accounting setup, posting rules, reconciliation (§5.6, §23)',
  'platform.test.ts': 'Unit & integration — authorization, audit trail, dates/time zones, printing, utilities (§6, §10, §15)',
  'authz.test.ts': 'Authorization matrix — engine-level permission enforcement for every guarded operation × every seeded user (§6)',
  'journeys.spec.ts': 'End-to-end — critical business journeys in a real browser (§3.4)',
  'responsive.spec.ts': 'Responsive — 10-viewport matrix × 25 screens, dialogs, touch targets, long content (§4.1, §4.2)',
  'a11y-visual.spec.ts': 'Accessibility (axe-core WCAG 2.x A/AA) and visual regression (§4.3, §4.4)',
  'perf.spec.ts': 'Performance — browser timing measurements (§8)',
};
const md: string[] = [];
for (const [file, title] of Object.entries(TITLE)) {
  const rs = rows.filter((r) => r.file === file);
  if (!rs.length) continue;
  const code = PREFIX[file];
  const a = agg(rs);
  const lines = [`# ${title}`, '', `Source: \`${file.endsWith('.test.ts') ? 'tests/unit/' : 'tests/e2e/'}${file}\` · generated by \`scripts/qa-evidence.ts\` from the last recorded run (${summary.generatedAt.slice(0, 16).replace('T', ' ')} UTC, commit ${summary.commit}).`,
    `Result of that run: **${a.passed} passed · ${a.failed} failed · ${a.skipped} not run** of ${a.total}.`, '', '| ID | Requirement ref. | Group | Test case (title is the executable specification) | Level | Last result |', '|---|---|---|---|---|---|'];
  rs.forEach((r, i) => lines.push(`| ${code}-${String(i + 1).padStart(3, '0')} | ${r.refs.join(', ') || '—'} | ${r.group.replace(/\|/g, '/') || '—'} | ${r.title.replace(/\|/g, '/')} | ${kindOf(r)} | ${ICON[r.status]} |`));
  writeFileSync(`qa/TEST_CASES/${file.replace(/\.(test|spec)\.ts$/, '').toUpperCase()}.md`, lines.join('\n') + '\n');
  md.push(`${code}: ${a.passed}/${a.total}`);
}
console.log(JSON.stringify({ commit: summary.commit, typecheck: summary.typecheck, totals: summary.totals, byKind }, null, 1));
console.log(md.join(' | '));

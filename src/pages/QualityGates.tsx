import summary from '../generated/qa-summary.json';
import { Badge, Banner, Card } from '../ui/kit';

// QA addendum §17, §20: release gates A–F with an honest status. Test numbers come from the recorded runs (src/generated/qa-summary.json,
// written by scripts/qa-evidence.ts from the vitest and Playwright reporters). Everything that was NOT tested is stated as such.
type Gate = 'met' | 'partial' | 'not met';
const TONE: Record<Gate, 'good' | 'warn' | 'bad'> = { met: 'good', partial: 'warn', 'not met': 'bad' };

type K = { total: number; passed: number; failed: number; skipped: number };
const S = summary as unknown as { generatedAt: string; commit: string; typecheck: string; totals: K; byKind: Record<string, K>; perf: { engine?: { saleP50: number; saleFreezeOffP50: number; seedP50: number }; browser?: { coldStartMs: number; warmReloadMedianMs: number; saleClickToConfirmMedianMs: number; bundle: { gzipKB: number } } } };
const anyFailed = S.totals.failed > 0 || S.typecheck !== 'passed';
const k = (n: string) => S.byKind[n] ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
const frac = (x: K) => `${x.passed}/${x.total}`;

const GATES: { id: string; name: string; status: Gate; evidence: string[]; open: string[] }[] = [
  { id: 'A', name: 'Design ready', status: 'partial',
    evidence: ['Requirements, accounting setup (§23) and QA addendum implemented against written acceptance criteria (qa/TEST_CASES, docs/accounting/ACCOUNTING_UAT_CASES.md)', 'Permissions and failure states documented (qa/SECURITY_TEST_CHECKLIST.md)'],
    open: ['§21 decisions not confirmed by an owner: supported browsers, expected load, performance targets, RPO/RTO, release approvers, pen-test requirement, printer models'] },
  { id: 'B', name: 'Implementation ready', status: anyFailed ? 'not met' : 'partial',
    evidence: [`Type-check: ${S.typecheck}`, `Unit + integration + authorization matrix: ${frac(k('unit'))} passed`],
    open: ['No independent code review has happened (single author)', 'No database, so migration validation does not apply yet'] },
  { id: 'C', name: 'Integration ready', status: anyFailed ? 'not met' : 'partial',
    evidence: ['Atomic transactions, idempotency keys, unique-number races and ledger reconciliation are exercised by the engine tests', 'Connectors (LINE, marketplaces, printers) are simulated'],
    open: ['No real API, so no API contract tests', 'No real provider sandbox tested'] },
  { id: 'D', name: 'User-experience ready', status: anyFailed ? 'not met' : 'partial',
    evidence: [`E2E journeys: ${frac(k('e2e'))}`, `Responsive (10 viewports × 25 screens + dialogs): ${frac(k('responsive'))}`, `Accessibility (axe-core, automated): ${frac(k('a11y'))}`, `Visual regression (14 baselines): ${frac(k('visual'))}`],
    open: ['Chrome only (Edge headless could not be launched on the test machine); Safari, Firefox, real Android/iOS devices not tested', 'No manual screen-reader or full keyboard-only audit', 'No usability test with real staff'] },
  { id: 'E', name: 'Business ready', status: 'not met',
    evidence: ['Control accounts reconcile with subledgers on the demo data (automated)'],
    open: ['UAT not performed or signed (qa/UAT_SIGNOFF.md)', 'Chart of accounts, tax set-up and policies NOT reviewed by a qualified Thai accountant', 'Opening balances are demo data'] },
  { id: 'F', name: 'Production ready', status: 'not met',
    evidence: ['Local export/restore journey passes (J18)', 'Engine-level permission checks exist for money/approval/period actions'],
    open: ['No server: permissions are enforced in the browser engine and must be re-enforced server-side', 'No authentication, monitoring, alerts, infrastructure backup/restore evidence, security review or release approval'] },
];

const DEFECTS: [string, string, string, string][] = [
  ['BUG-001', 'High', 'Balance sheet mis-stated contra accounts (sign) — found by the report-reconciliation test', 'Fixed, regression test in accounting.test.ts'],
  ['BUG-002', 'High', 'Money, approval and accounting actions were permission-checked only in the UI', 'Fixed for 70 engine operations; 74-case authorization matrix added. Remaining operations listed in qa/DEFECT_LOG.md (High for production)'],
  ['BUG-003', 'High', 'Every action re-walked the whole ledger (≈173–195 ms per sale, growing with data) because state was not frozen', 'Fixed (≈20 ms); see PERFORMANCE_TEST_REPORT'],
  ['BUG-004', 'Critical', 'The last action could be lost if the page was refreshed within 600 ms (debounced save) — found by journey J6', 'Fixed (saved immediately); J6 + J18 regression'],
  ['BUG-005', 'Medium', 'Horizontal overflow ≤ 430 px on several screens; POS chips and links below 24 px target size', 'Fixed, covered by the responsive suite'],
  ['BUG-006', 'Medium', 'Accessibility: contrast, unlabeled selects, unlinked labels, QR without role, scroll region not focusable', 'Fixed, covered by the axe suite'],
];

export function QualityGates() {
  const gen = new Date(S.generatedAt);
  return (
    <div className="col gap-16">
      <Banner tone={anyFailed ? 'bad' : 'warn'}>
        <b>Not production-ready.</b> This is a prototype. The release target is “no known Critical/High defects”, not “no bugs” — and Gates E and F are not met.
        Evidence snapshot: {gen.toISOString().slice(0, 16).replace('T', ' ')} UTC · commit {S.commit}. The snapshot is embedded when the app is built, so it describes the run just before this build.
      </Banner>
      <div className="grid g4">
        {[['Type-check', S.typecheck === 'passed' ? 'passed' : 'FAILED'], ['Unit & integration', frac(k('unit'))], ['E2E / responsive', `${frac(k('e2e'))} · ${frac(k('responsive'))}`], ['Accessibility / visual', `${frac(k('a11y'))} · ${frac(k('visual'))}`]].map(([a, b]) => (
          <Card key={a}><div className="muted">{a}</div><div style={{ fontSize: 22, fontWeight: 650 }}>{b}</div></Card>
        ))}
      </div>
      <div className="grid g2">
        {GATES.map((g) => (
          <Card key={g.id} title={<span>Gate {g.id} — {g.name}</span>} actions={<Badge tone={TONE[g.status]}>{g.status}</Badge>}>
            <div className="col gap-6">
              <div className="muted"><b>Evidence</b></div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{g.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
              <div className="muted mt8"><b>Still open</b></div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{g.open.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          </Card>
        ))}
      </div>
      <Card title="Defects found and fixed in this QA cycle" sub="Open Critical / High defects known to the author: none. Unknown defects certainly remain — see the limitations.">
        <div className="table-wrap" role="region" aria-label="Scrollable table" tabIndex={0}>
          <table className="t"><thead><tr><th>ID</th><th>Severity</th><th>Defect</th><th>Status</th></tr></thead>
            <tbody>{DEFECTS.map(([id, sev, d, st]) => <tr key={id}><td className="mono">{id}</td><td><Badge tone={sev === 'Critical' ? 'bad' : sev === 'High' ? 'warn' : 'info'}>{sev}</Badge></td><td>{d}</td><td>{st}</td></tr>)}</tbody></table>
        </div>
      </Card>
      {S.perf.engine && S.perf.browser && (
        <Card title="Measured performance" sub="This machine, in-memory engine, one user. Not a load test.">
          <div className="col gap-6">
            <div className="row between"><span className="muted">Post one POS sale (engine, median)</span><b>{S.perf.engine.saleP50.toFixed(0)} ms</b></div>
            <div className="row between"><span className="muted">Same, before the fix</span><span>{S.perf.engine.saleFreezeOffP50.toFixed(0)} ms</span></div>
            <div className="row between"><span className="muted">Cold start incl. seeding the demo business (browser)</span><b>{S.perf.browser.coldStartMs} ms</b></div>
            <div className="row between"><span className="muted">Warm reload (browser, median)</span><b>{S.perf.browser.warmReloadMedianMs} ms</b></div>
            <div className="row between"><span className="muted">“Complete sale” click → confirmation (browser, median)</span><b>{S.perf.browser.saleClickToConfirmMedianMs} ms</b></div>
            <div className="row between"><span className="muted">Single-file bundle (gzip)</span><b>{S.perf.browser.bundle.gzipKB} KB</b></div>
          </div>
        </Card>
      )}
      <Card title="What was NOT tested">
        <ul style={{ margin: 0, paddingLeft: 18 }} className="col gap-6">
          {['Real devices and browsers other than Chrome (Safari/iOS, Android, Firefox, Edge)', 'Real printers, thermal paper, Thai fonts on paper, QR/barcode scanning', 'Real LINE, marketplace, bank or payment-provider integrations', 'Load, soak, concurrency across real users, large datasets (only the ~900-order demo dataset)', 'Penetration test, dependency audit, secrets scan, infrastructure security', 'Backup/restore on infrastructure, monitoring and alerting', 'UAT with real roles; accountant review of accounts, tax and policies'].map((t) => <li key={t}>{t}</li>)}
        </ul>
      </Card>
    </div>
  );
}

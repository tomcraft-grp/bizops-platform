import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, CircleDashed, FlaskConical, Hammer } from 'lucide-react';
import { Badge, Banner, Card, PageHead, Seg, Tabs, Tx } from '../ui/kit';
import { QualityGates } from './QualityGates';

type Status = 'built' | 'partial' | 'simulated' | 'planned';
interface Row { area: string; ref: string; status: Status; built: string; gap?: string; to?: string }

const ROWS: Row[] = [
  { area: 'Accounting setup, chart of accounts & mapping', ref: '§23', status: 'partial', to: '/accounting/setup', built: 'Seven-stage setup checklist, hierarchical COA with Thai names, role-based versioned posting map, effective-dated tax codes, opening balances with source + four-eyes, control-account reconciliation matrix, period lock/reopen, manual-journal approvals, reports that reconcile to each other.', gap: 'Not reviewed by a Thai accountant. No WHT, e-Tax/PP.30 formats, fixed assets, WIP stage, platform-funded discount split, loyalty liability.' },
  { area: 'QA, testing & release governance', ref: 'QA addendum §1–§22', status: 'partial', to: '/blueprint', built: 'Vitest unit/integration/authorization suites, Playwright E2E journeys, 10-viewport responsive matrix, axe accessibility, visual baselines, performance measurements, defect log, release gates (see the Quality & release gates tab).', gap: 'Chrome only; no UAT, real devices/printers, load test, security review or CI; Gates E and F not met.' },
  { area: 'Organization, identity & security', ref: '§5.1, §3', status: 'partial', to: '/team', built: 'Branches, warehouses, employees, RBAC with module × action matrix, branch scope, financial-sensitivity permissions (cost / profit), audit log, role switcher for demos.', gap: 'Real authentication, sessions & device management, LINE Login/LIFF, secrets management, tenant isolation via database constraints (this prototype is single-tenant and client-side).' },
  { area: 'Customer & CRM', ref: '§5.2', status: 'built', to: '/customers', built: 'Profiles, groups, spend-based tiers, purchase history, statements, aging, credit terms & limits, PDPA consent timestamps, customer credit ledger.' },
  { area: 'Product catalog', ref: '§5.3', status: 'partial', to: '/products', built: 'Products, SKUs, barcodes, categories, units, channel-specific prices, status, image gallery with thumbnails, marketplace mappings, bundles (via promotions), cost references and history.', gap: 'Variant matrix and unit-of-measure conversions (each SKU has one unit).' },
  { area: 'Inventory & warehouse', ref: '§5.4', status: 'built', to: '/inventory', built: 'Multi-warehouse movement ledger, balances as a projection that reconciles, receipts, issues, adjustments, transfers with in-transit + partial receipt + close-short, reservations for online orders, stock counts, low-stock alerts, lots & expiry (FEFO view), valuation.' },
  { area: 'POS & order management', ref: '§5.5', status: 'built', to: '/pos', built: 'Touch POS with modifiers, barcode entry, promotions/coupons, VAT-inclusive pricing, split payments, PromptPay QR, pay-on-account, customer credit, receipts, park/recall, returns & credit notes, idempotent checkout, status history.', gap: 'Partial cancellation of an unshipped order (cancel is all-or-nothing; returns can be partial).' },
  { area: 'Omnichannel commerce', ref: '§5.6', status: 'simulated', to: '/channels', built: 'Unified order model; external IDs, timestamps and raw payload preserved; SKU mapping; fee/discount/shipping capture; idempotent imports; error queue; CSV fallback; settlements; sync log.', gap: 'No real Shopee / Lazada / TikTok / LINE MAN API connectors — API access, scopes, approval and terms must be verified per platform. Status push-back to platforms.' },
  { area: 'Purchasing & suppliers', ref: '§5.7', status: 'built', to: '/purchasing', built: 'Suppliers, POs, partial goods receipts, supplier invoices, landed-cost allocation, returns/credit notes, payments, deposits, payables aging, purchase price history, lots & expiry on receipt.' },
  { area: 'BOM, recipes & production', ref: '§5.8', status: 'built', to: '/production', built: 'Manufacturing / recipe / packaging / assembly BOMs, immutable versions with effective dates, yield, labor & overhead, production orders with BOM snapshots, partial output, waste, actual vs standard cost.', gap: 'By-products and multi-level (nested) BOM explosion.' },
  { area: 'Food & beverage', ref: '§5.9', status: 'partial', to: '/kds', built: 'Menu items mapped to recipes, modifiers that change ingredients (extra shot, oat-milk swap), ingredient backflush, kitchen/bar stations, KDS with timers, waste recording, LINE MAN order flow.', gap: 'Real LINE MAN integration; dedicated remake workflow.' },
  { area: 'Payments, receipts & receivables', ref: '§5.10', status: 'built', to: '/receivables', built: 'Receipts separate from allocations; one receipt across many orders; FIFO or manual allocation; partial payments; overpayment → credit; refunds; voids with reversing journals; slip upload & review with duplicate checks; statements; aging.' },
  { area: 'Customer credit (not a wallet)', ref: '§5.11', status: 'built', to: '/receivables?tab=credit', built: 'Non-cash credit ledger derived from receipts; no real-money top-ups by design.', gap: 'Stored-value wallet intentionally NOT enabled until legal review under Thai e-money rules.' },
  { area: 'Loyalty & rewards', ref: '§5.12', status: 'built', to: '/loyalty', built: 'Points ledger (earn/bonus/redeem/expire/reverse/restore), category & tier multipliers, expiry batches, reward catalog with stock, coupon rewards, cancellation with restoration, idempotent redemption.' },
  { area: 'Promotion rule engine', ref: '§5.13', status: 'built', to: '/promotions', built: 'Conditions (value, qty, product/category, group, channel, branch, weekday/time, customer, lifetime spend, code), actions (percent, fixed, bundle, free item, bonus points, event entitlement, coupon), limits, budgets, priority & stacking, simulator that explains why a promotion did not apply.' },
  { area: 'Event: 3 boards, numbers 00–99', ref: '§5.14', status: 'built', to: '/events', built: 'Configurable boards/range, entitlements from promotions, reservation with expiry, unique (event, board, number) enforcement, admin release/reset with preserved history and typed confirmation, winners, occupancy dashboard, customer picking in the LINE app.', gap: 'Legal structure, prize rules and terms must be reviewed under Thai law before launch.' },
  { area: 'Accounting & finance', ref: '§5.15', status: 'partial', to: '/accounting', built: 'Chart of accounts, automatic posting from every module, manual journals, reversals, AR/AP, cash & bank reconciliation, expenses, VAT lines, period lock/reopen, trial balance, P&L, balance sheet, general ledger.', gap: 'Tax-invoice formats, withholding tax, VAT return, loyalty-liability accounting — need a Thai accountant.' },
  { area: 'Costing & real profitability', ref: '§5.16', status: 'partial', to: '/profit', built: 'Weighted-average cost snapshots, BOM roll-up, actual production cost, standard-cost variance, landed cost, channel commission/fees/shipping, returns, business-level expenses, “Provisional vs Final” labelling.', gap: 'FIFO cost layers; allocation of labor/overhead beyond per-batch rates.' },
  { area: 'Reporting & dashboards', ref: '§5.17, §11', status: 'built', to: '/reports', built: 'Executive, channel, inventory, financial, customer/loyalty and event dashboards; Yesterday → Today → Now report from the ledger; sales, aging and valuation reports with CSV export.', gap: 'Native Excel/PDF export (CSV and print-to-PDF are available).' },
  { area: 'Printing & KDS', ref: '§6', status: 'simulated', to: '/printing', built: 'Central print service, routing rules, queue, retry, idempotency keys, reprint with reason, 58/80 mm and A4 templates, real browser printing, HTML save, KDS with printer fallback.', gap: 'The local ESC/POS print agent is simulated; real printers must be tested model by model.' },
  { area: 'Media & documents', ref: '§7', status: 'simulated', to: '/media', built: 'Content-type sniffing, size limits, SHA-256 duplicate detection, thumbnails + WebP variants, quarantine (EICAR test), private-by-default, 60-second signed links with access log, review status for slips.', gap: 'Cloudflare R2, real malware scanning, encryption at rest, retention enforcement jobs.' },
  { area: 'Responsive app / PWA', ref: '§4', status: 'partial', built: 'Responsive layout for phones, tablets and desktops; mobile drawer navigation; touch POS; dark mode; keyboard search (Ctrl K).', gap: 'Installable PWA manifest & service worker, offline sync & conflict resolution, real-device test matrix.' },
];

const IMPROVEMENTS = [
  ['Separate platform receivable', 'Marketplace sales are owed by the platform, not the customer. A distinct account (1120) and a settlement workflow keep customer AR clean and make unsettled revenue visible.'],
  ['Estimated vs actual fees', 'Every platform order carries estimated fees until a settlement arrives; profit reports label themselves Provisional or Final instead of calling an estimate “actual net profit”.'],
  ['No money lost on cancel', 'Cancelling a paid, unshipped order moves the payment onto the customer’s credit balance via a ledger entry, rather than orphaning it.'],
  ['Immutable BOM + snapshots', 'Active BOM versions cannot be edited, and orders/production keep a copy of the version used, so historical cost can never change retroactively.'],
  ['Idempotency everywhere', 'Checkout, channel imports, reward redemption and print jobs use idempotency keys; double taps, webhook retries and re-imports are harmless.'],
  ['Why-not-applied promotion simulator', 'Marketing can see exactly why a promotion did or did not apply to a cart — deterministic and auditable.'],
  ['Integrity dashboard', 'Trial balance, stock-ledger, receivable, credit, points and event-number reconciliations run continuously, plus executable concurrency tests.'],
  ['PromptPay QR', 'POS generates a standards-based PromptPay payload with the exact amount (locally, nothing sent anywhere).'],
  ['Credit instead of wallet', 'A non-cash credit ledger replaces the “wallet” until regulatory review, avoiding an unlicensed stored-value product.'],
  ['Frontline safety rails', 'Typed confirmation for resets, mandatory reasons for voids/reversals/adjustments, period locks, and per-role hiding of cost and profit.'],
];
const GAPS = [
  ['Tax documents undefined', 'The plan never says whether the shop issues abbreviated or full tax invoices, nor how credit notes and VAT on marketplace sales are treated.'],
  ['Loyalty accounting', 'Outstanding points are a liability. The plan has no accounting policy (deferral vs expense); the prototype reports an estimate only.'],
  ['Marketplace clawbacks', 'Returns after a settlement can create a negative platform receivable; the plan needs a policy for deductions from future payouts.'],
  ['Overselling policy', 'Marketplace stock is shared across channels. The plan does not say whether buffers, channel allocation or auto-delist are required.'],
  ['WAC vs FIFO', 'Both are requested without saying which applies to which inventory class; weighted average is implemented first.'],
  ['PDPA vs retention', 'Deletion requests conflict with 7–10 year accounting retention for invoices and slips; a documented anonymisation rule is needed.'],
  ['Offline definition', '“Offline” sales are mentioned but the offline-capable workflows and conflict rules are not defined.'],
  ['Backup / recovery targets', 'No RPO/RTO or disaster-recovery requirements are stated.'],
];
const DECISIONS = [
  ['Wallet regulation', 'Prototype assumption: internal non-cash credit only. Needs legal confirmation before any top-up feature.'],
  ['Thai accounting & tax', 'Prototype assumption: VAT-inclusive prices at 7%, simplified chart. Needs accountant sign-off.'],
  ['Marketplace APIs', 'Assumption: CSV fallback now; connectors only after each platform’s approval, scopes and terms are confirmed.'],
  ['LINE MAN route', 'Unknown — direct API, partner integration or file import must be confirmed.'],
  ['Costing policy', 'Assumption: weighted average per product and warehouse; FIFO later where required.'],
  ['Printer hardware', 'Pick actual models and connections; decide whether a local agent is required per branch.'],
  ['Offline behaviour', 'Decide which workflows (POS sale, stock receive?) must work offline and how conflicts resolve.'],
  ['Branches & stock sharing', 'Assumption: 3 branches, 3 warehouses, stock is warehouse-specific with explicit transfers.'],
  ['Event rules', 'Approve entitlement formula (฿500 per pick), reservation hold (10 min), reset policy, winner rules and legal terms.'],
  ['Media retention', 'Approve the proposed retention table in Media → Security & retention.'],
  ['Profit definition', 'Assumption: contribution after channel costs; opex shown at business level, optional allocation by revenue.'],
  ['SaaS expansion', 'Not built: single organization. Tenant isolation would be added with composite keys and row-level security.'],
];
const OUT = ['Native iOS / Android apps', 'Microservices', 'Full MRP planning', 'Payroll & HR', 'Automated tax filing', 'Unverified marketplace APIs', 'AI forecasting / auto-purchasing', 'Fully offline operation', 'Automated bank feeds'];

const TOUR: { t: string; steps: string[]; to: string }[] = [
  { t: 'Sell a coffee with options', to: '/pos', steps: ['Open POS, tap “Latte (hot)”, pick Oat milk + Extra shot, add a Butter Croissant', 'Notice the ฿119 combo promotion applying automatically', 'Add a customer, charge by PromptPay QR, then look at Print jobs in the confirmation'] },
  { t: 'Pay three orders with one transfer', to: '/receivables', steps: ['Receive payment → pick “Café Mali” (or any customer who owes)', 'Enter part of the balance: FIFO allocates across the oldest orders', 'Switch to Manual allocation to choose differently; overpay to create customer credit'] },
  { t: 'Approve a payment slip', to: '/receivables?tab=slips', steps: ['Open a pending slip, check the duplicate warnings', 'Approve → a receipt is created and allocated to the order', 'Reject another with a reason'] },
  { t: 'Handle a marketplace order end to end', to: '/channels', steps: ['Channels → “Sync now” on Shopee: orders arrive, one SKU is unmapped, one duplicate is ignored', 'Fix the mapping — the parked order imports automatically', 'Orders → advance to Shipped/Completed; Channels → Settlements → create & receive a payout and watch profit turn from provisional to final'] },
  { t: 'Run the lucky-draw event', to: '/events', steps: ['Pick a board, click a free number, select it for a customer with an unused pick', 'Try to claim a taken number — it is rejected', 'Release a number with a reason; try Reset board (typed confirmation) and see the audit log'] },
  { t: 'Change a recipe safely', to: '/production', steps: ['Open the Latte recipe: v1 is locked', 'New version → change milk quantity → activate from today', 'Old orders keep their cost snapshot; new sales use v2'] },
  { t: 'Move stock with a short delivery', to: '/inventory?tab=transfers', steps: ['New transfer from the central warehouse to a store', 'Receive only part of it, then “Close short” with a reason — the loss is posted'] },
  { t: 'See permissions in action', to: '/team', steps: ['Top right → switch to “Mali Srisuk” (Cashier)', 'Cost, profit and accounting disappear; POS still works', 'Switch back to Owner and edit the role matrix'] },
  { t: 'Check the books', to: '/health', steps: ['System health → Run concurrency self-tests', 'Accounting → Periods: period locked; try a back-dated manual journal and read the rejection'] },
  { t: 'Be the customer', to: '/app', steps: ['Open the LINE app simulator, sign in as a member', 'Redeem a reward, upload a transfer slip, pick lucky-draw numbers'] },
];

const ICON: Record<Status, JSX.Element> = { built: <CheckCircle2 size={14} />, partial: <Hammer size={14} />, simulated: <FlaskConical size={14} />, planned: <CircleDashed size={14} /> };
const TONE: Record<Status, 'good' | 'warn' | 'info' | ''> = { built: 'good', partial: 'warn', simulated: 'info', planned: '' };

export default function Blueprint() {
  const [tab, setTab] = useState<'tour' | 'coverage' | 'review' | 'decisions' | 'arch' | 'quality'>('tour');
  const [f, setF] = useState<Status | 'all'>('all');
  const rows = useMemo(() => ROWS.filter((r) => f === 'all' || r.status === f), [f]);
  const counts = (s: Status) => ROWS.filter((r) => r.status === s).length;
  return (
    <>
      <PageHead title="Blueprint & scope" desc="What this prototype covers against the requirements document, what was improved, and what still needs decisions or real integrations. Honest status, not marketing." />
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'tour', label: 'Try these workflows' }, { v: 'coverage', label: 'Requirements coverage' }, { v: 'review', label: 'Improvements & plan gaps' }, { v: 'decisions', label: 'Decisions & scope' }, { v: 'arch', label: 'Architecture' }, { v: 'quality', label: 'Quality & release gates' }]} />
      {tab === 'tour' && (
        <div className="grid g2">
          {TOUR.map((x, i) => (
            <Card key={x.t} title={<span>{i + 1}. <Tx>{x.t}</Tx></span>} actions={<Link to={x.to}><Tx>Open</Tx>{' '}<ArrowRight size={13} style={{ verticalAlign: -2 }} /></Link>}>
              <ol style={{ margin: 0, paddingLeft: 18 }} className="col gap-6">{x.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            </Card>
          ))}
        </div>
      )}
      {tab === 'coverage' && (
        <>
          <div className="row wrap mb16"><Seg value={f} onChange={setF} options={[{ v: 'all', label: `All (${ROWS.length})` }, { v: 'built', label: `Built (${counts('built')})` }, { v: 'partial', label: `Partial (${counts('partial')})` }, { v: 'simulated', label: `Simulated (${counts('simulated')})` }]} />
            <div className="legend"><span><Badge tone="good"><Tx>Built</Tx></Badge>{' '}<Tx>works end-to-end on the data engine</Tx></span><span><Badge tone="warn"><Tx>Partial</Tx></Badge>{' '}<Tx>core works, gaps listed</Tx></span><span><Badge tone="info"><Tx>Simulated</Tx></Badge>{' '}<Tx>needs a real integration</Tx></span></div></div>
          <div className="col">
            {rows.map((r) => (
              <Card key={r.area}>
                <div className="row between top wrap"><div><b>{r.area}</b> <span className="muted">· {r.ref}</span></div><div className="row"><Badge tone={TONE[r.status]}><Tx>{ICON[r.status]}</Tx> {r.status}</Badge>{r.to && <Link to={r.to}><Tx>Open →</Tx></Link>}</div></div>
                <div className="mt8">{r.built}</div>
                {r.gap && <div className="mt8 muted"><b><Tx>Not yet:</Tx></b> {r.gap}</div>}
              </Card>
            ))}
          </div>
        </>
      )}
      {tab === 'review' && (
        <div className="grid g2">
          <Card title="Improvements made beyond the plan"><div className="col">{IMPROVEMENTS.map(([t, d]) => <div key={t}><b>{t}</b><div className="muted">{d}</div></div>)}</div></Card>
          <Card title="Gaps & risks found in the plan"><div className="col">{GAPS.map(([t, d]) => <div key={t}><b>{t}</b><div className="muted">{d}</div></div>)}</div></Card>
        </div>
      )}
      {tab === 'decisions' && (
        <div className="grid g2">
          <Card title="Decisions that need owner approval" sub="Prototype default shown for each"><div className="col">{DECISIONS.map(([t, d]) => <div key={t}><b>{t}</b><div className="muted">{d}</div></div>)}</div></Card>
          <div className="col gap-16">
            <Card title="Out of scope for the first release"><div className="row wrap">{OUT.map((o) => <Badge key={o}>{o}</Badge>)}</div></Card>
            <Banner tone="warn"><b><Tx>Required before real use:</Tx></b>{' '}<Tx>legal review (wallet / events), Thai accounting & tax review, verified marketplace API access, printer hardware tests, backup & restore plan, authentication and database-enforced tenant isolation.</Tx></Banner>
          </div>
        </div>
      )}
      {tab === 'quality' && <QualityGates />}
      {tab === 'arch' && (
        <div className="grid g2">
          <Card title="What this prototype is"><div className="col gap-6"><div><Tx>A TypeScript React single-page app with a</Tx>{' '}<b><Tx>transactional in-browser domain engine</Tx></b><Tx>: every business action runs as one atomic transaction (all-or-nothing), appends to immutable ledgers, and posts balanced journals. Data persists in IndexedDB. The production build is one self-contained HTML file.</Tx></div><div className="muted"><Tx>It proves the workflows, rules and invariants — it is not a multi-user system and has no server.</Tx></div></div></Card>
          <Card title="Target production architecture (from the plan)"><div className="col gap-6">{[['Frontend', 'Next.js + TypeScript (responsive PWA)'], ['Backend', 'NestJS modular monolith, one module per domain'], ['Database', 'PostgreSQL with composite tenant keys, partial unique indexes, row-level security'], ['ORM', 'Prisma + SQL migrations'], ['Jobs', 'Redis + BullMQ (sync, image processing, print jobs)'], ['Storage', 'Cloudflare R2 with signed URLs'], ['Tests', 'Jest + Playwright, concurrency tests for stock, payments, points, event numbers']].map(([a, b]) => <div key={a} className="row between"><span className="muted">{a}</span><span style={{ textAlign: 'right' }}>{b}</span></div>)}</div></Card>
          <Card title="How prototype pieces map to production"><div className="col gap-6">{[['act(): immer transaction', 'Database transaction + SERIALIZABLE / row locks'], ['eventIndex map', 'UNIQUE (event_id, board_id, number) WHERE active'], ['meta.idem keys', 'Unique idempotency-key tables'], ['moveStock()', 'Insert-only stock_movements + trigger-maintained balances'], ['post()', 'Journal header/lines with deferred balance constraint'], ['Period lock', 'Posting-date check in the posting service']].map(([a, b]) => <div key={a} className="row between top"><code className="mono">{a}</code><span style={{ textAlign: 'right' }}>{b}</span></div>)}</div></Card>
          <Card title="Deliverables from Phase 0 not included"><div className="muted"><Tx>Full ERD, data dictionary, complete Prisma schema and SQL migrations, API contracts, and the printer test plan are</Tx>{' '}<b><Tx>not</Tx></b>{' '}<Tx>produced here — the in-app domain model (src/domain/types.ts) is the starting point for them.</Tx></div></Card>
        </div>
      )}
    </>
  );
}

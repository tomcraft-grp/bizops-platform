# Performance Test Report

Addendum §8, §21. **This report contains measurements, not approvals:** no performance targets have been agreed (decision §21 is open), so nothing here is "passed" against a threshold except the deliberately generous smoke guards in `perf.spec.ts`.

## 1. Test conditions
| Item | Value |
|---|---|
| Machine | Developer laptop, Windows 11 (CPU/RAM recorded in `qa/results/perf-engine.json → machine`) |
| Engine benchmark | Node 20, in-process, no network, no database, single user — `npx tsx scripts/perf.ts` |
| Browser benchmark | Google Chrome headless (Playwright), production build served by `vite preview` on localhost — `tests/e2e/perf.spec.ts`; includes Playwright round-trip overhead (tens of ms), so figures are upper bounds |
| Dataset | Seeded demo business: ≈920 orders, ≈1 630 journals, ≈3 900 stock movements, 3.35 MB serialised |
| Build | Single-file production bundle |
| Not included | Real network, real database, concurrent users, low-end phones, throttled CPU/network |

## 2. Results
Raw data: `qa/results/perf-engine.json`, `qa/results/perf-browser.json` (re-generated on every run; the tables below are a copy of the last run at the time of writing — the JSON files are authoritative). Machine: AMD Ryzen 5 7535HS, 12 logical cores, 16 GB RAM, Windows 11.

### Engine (milliseconds, p50 / p95) — last run 2026-11-12 22:07 UTC
| Operation | p50 | p95 |
|---|---:|---:|
| Seed the whole demo business | 365 | 469 |
| Post one POS sale (stock top-up + order + payment + balanced journals), auto-freeze **on** (current setting) | 19 | 26 |
| Same, auto-freeze **off** (previous setting, BUG-003) | 184 | 215 |
| Integrity checks (all invariants) | 40 | 47 |
| Reconciliation matrix (subledger ↔ control) | 22 | 28 |
| Trial balance over all journals | 1.6 | 3.3 |
| Profit engine (all orders) | 2.2 | 7.6 |
| VAT report (90 days) | 1.2 | 2.3 |
| Cash-flow report (90 days) | 3.5 | 5.3 |
| Serialise state for persistence | 31 | 39 |

Run-to-run variation of the small figures is large (the same benchmark gave 9–22 ms for the reconciliation matrix and 24–40 ms for the integrity checks on different runs on the same machine, depending on background load). Treat single-digit differences as noise; the freeze on/off gap (≈ 9–10×) was reproduced in every run.

### Browser — last solo run
| Metric | Measurement |
|---|---|
| Cold start (first load incl. building the demo business) to dashboard heading | 892 ms |
| Warm reload to dashboard heading (median of 3: 172, 174, 183) | 174 ms |
| Route change to new screen rendered, median of 3 (/orders 30 · /receivables 28 · /inventory 28 · /accounting 32 · /accounting/setup 38 · /profit 27 · /reports 30 · /events 23) | 23–38 ms |
| "Complete sale" click → confirmation (runs 190, 91, 84; first run includes first-render cost) | median 91 ms |
| Production bundle (single HTML file) | 856.3 KB raw, 254.5 KB gzip |

The same test also runs inside the full parallel suite (3 workers), where numbers are slightly noisier; the table above is from a solo run (`npx playwright test tests/e2e/perf.spec.ts --workers=1`). The bundle grew from ≈ 845 KB to ≈ 856 KB with the quality-gates page.

## 3. Findings
1. **BUG-003 (fixed):** with immer auto-freeze disabled, every transaction cost ≈ 175–195 ms and would have grown with data volume. Enabling it cut the cost ≈ 9× (≈ 20 ms).
2. **Persistence cost scales with total data:** each transaction serialises the whole database (≈ 35 ms at 3.35 MB) and writes it to IndexedDB. Acceptable for a demo; it is the main reason the prototype is **not** a model for production storage (a real database writes only the changed rows).
3. **Reports are cheap at this size** (about 1–40 ms, the slowest being the full integrity checks and the reconciliation matrix) but are computed over the full journal array in memory; behaviour at 10×–100× data has **not been measured**.

## 4. Not run (and therefore unknown)
Load, stress, soak and spike tests; concurrent users; large datasets (only the ≈920-order demo set was used); low-end Android/iOS devices and throttled networks; real API latency; queue/webhook throughput; report generation at production volume; checkout latency with a real payment provider; Lighthouse/Core Web Vitals on real devices.

## 5. Recommended next step
Agree targets (§21: concurrent users, peak transactions/hour, checkout, key screens, reports), then measure the real backend with a seeded dataset ≥ 10× the demo and record the results here with the same conditions table.

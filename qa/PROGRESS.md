# Working notes — QA & accounting addendum (cycle closed 2026-11-13)

The implementation work for Addendum v1.0 (§3–§6, §18, §23) is finished for the prototype scope. These notes replace the earlier "paused / resume" notes.

**Where things are:** deliverables in `qa/` and `docs/accounting/` (index: `README.md`, `docs/accounting/README.md`); latest results in `qa/results/`; live gate view in the app (*Blueprint → Quality & release gates*).

**Not done (needs people, hardware or a backend — see `qa/RELEASE_CHECKLIST.md`):** UAT, accountant review, other browsers and real devices, real printers, real integrations, load test, security review, CI pipeline, monitoring, infrastructure backup/restore, server-side authorization (residual unguarded operations in `qa/DEFECT_LOG.md` BUG-002).

**Practical notes:**
- E2E needs system Chrome (`PW_CHANNEL=chrome`; Edge headless failed to launch on the dev machine). Don't pass `--reporter` on a run whose JSON you want to keep: the CLI flag replaces the configured JSON reporter.
- Order for a full evidence refresh: `npm run build` → `npm test` → `npm run test:seed` → `npm run test:e2e` → `npm run perf` → solo `npx playwright test tests/e2e/perf.spec.ts --workers=1 --reporter=line` → `npm run qa:evidence` → `npm run build` (embeds the evidence snapshot in the app).
- Patch scripts: write to `scripts/_patchN.cjs`, run, delete that exact file.
- Bump `VERSION` in `src/domain/store.ts` and `version` in `seedData.ts` when seed/shape changes (currently 5). A bump clears stored browser data — needs a real migration before real use.

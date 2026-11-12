# Manual and exploratory test cases

Addendum §3.5, §15, §16. The automated cases are generated into the other files of this folder (`ENGINE.md`, `ACCOUNTING.md`, `PLATFORM.md`, `AUTHZ.md`, `JOURNEYS.md`, `RESPONSIVE.md`, `A11Y-VISUAL.md`, `PERF.md`) by `scripts/qa-evidence.ts`. This file lists what **requires a human or hardware** and has therefore **NOT BEEN RUN**.

| ID | Area | Requirement | Case | Status |
|---|---|---|---|---|
| TC-MAN-001 | Exploratory | §3.5 | Free exploration of POS under interruption: browser back/forward, refresh mid-payment, two tabs open at once (second tab edits the same data) | **Not run** |
| TC-MAN-002 | Exploratory | §3.5 | Unusual data: very long Thai names, emoji, RTL, zero/negative quantities via keyboard, paste of formatted numbers | **Not run** (long names covered automatically at 360 px only) |
| TC-MAN-003 | Devices | §15 | Android Chrome, iOS Safari, iPad, Firefox, Edge: login, POS, orders, customer app | **Not run** |
| TC-MAN-004 | Devices | §4.1 | Real phone in portrait/landscape; on-screen keyboard overlap in dialogs | **Not run** |
| TC-MAN-005 | Printing | §15 | 58 mm and 80 mm thermal and A4: Thai font rendering, wrapping, QR/barcode scan, margins, paper cut | **Blocked** (no hardware) |
| TC-MAN-006 | Printing | §15 | Paper-out, offline, connection loss; duplicate-print prevention on the real agent | **Blocked** (no hardware; simulated in `platform.test.ts`) |
| TC-MAN-007 | Accessibility | §4.4 | Screen reader (NVDA/VoiceOver) through POS, order, receivable flows | **Not run** |
| TC-MAN-008 | Accessibility | §4.4 | Keyboard-only: every action reachable, visible focus, no traps (only partly covered by journey "keyboard and navigation") | **Not run** (partial automation) |
| TC-MAN-009 | Accessibility | §4.4 | 200 % zoom, reduced motion, Windows high-contrast | **Not run** |
| TC-MAN-010 | Usability | §16 | Task-based test with 3+ real staff per role (see `UAT_SIGNOFF.md`) | **Not run** |
| TC-MAN-011 | Integrations | §7 | LINE login/Messaging, marketplace sandbox orders/webhooks, bank/QR statement import | **Blocked** (no credentials; simulated) |
| TC-MAN-012 | Backup | §11 | Restore drill on infrastructure with RPO/RTO measurement | **Not run** (no infrastructure) |
| TC-MAN-013 | Performance | §8 | Load/soak at agreed peak volume; large datasets | **Not run** |
| TC-MAN-014 | Security | §6 | Independent penetration test; dependency and secrets scan | **Not run** |
| TC-MAN-015 | Accounting | §23.12 | Accountant executes `docs/accounting/ACCOUNTING_UAT_CASES.md` on a copy of real data | **Not run** |

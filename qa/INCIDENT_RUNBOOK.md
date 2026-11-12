# Incident Runbook

Addendum §10, §11, §12. **Draft for the future production system.** The prototype has no server, monitoring or on-call; the procedures that can be executed today (local data recovery) are marked ✅. Everything else describes what the team must set up and rehearse — it has **not** been exercised.

## 1. Severity and first response
| Severity | Examples | First action | Target (to be agreed — §21) |
|---|---|---|---|
| **P0 Critical** | Ledger corruption, wrong money posted, unauthorised financial action, data loss, security breach, total outage | Stop the affected operation (disable the module/role; put the app in read-only mode); page the owner; preserve evidence | respond: _tbd_ · restore: _tbd_ |
| **P1 High** | A core workflow unusable or materially wrong (POS, payments, stock, period close) | Declare incident; apply the documented workaround; start a defect record | _tbd_ |
| **P2 Medium** | Partial failure with safe workaround | Ticket and schedule | _tbd_ |
| **P3 Low** | Cosmetic | Backlog | _tbd_ |

## 2. Roles
Incident lead · Communications · Engineer on call · Accountant (for any financial impact) · Business owner. _Names unassigned._

## 3. Triage checklist (any incident)
1. Write down the time, who reported it, what they saw, what they did.
2. Identify blast radius: which module, which branch/tenant/customers, since when.
3. **Do not fix data by hand-editing tables.** Corrections are made through the application (reversal, void, adjustment) so the original record and the audit trail stay intact (Addendum §23.14).
4. Capture safe evidence (screenshots without personal data, order/journal numbers, request IDs, audit entries).
5. Open a defect with `BUG_REPORT_TEMPLATE.md`; add a regression test before closing.

## 4. Playbooks
### 4.1 Reconciliation difference (control account ≠ subledger)
Symptoms: *System health* or *Accounting → Reconciliation* shows `diff`; a failing `recon-*` integrity check.
1. Treat as release-blocking for that workflow (§23.12). Stop period close.
2. Drill into the difference (*Reconciliation → drill-down*) to find the documents that disagree.
3. Find the source: stray manual journal on a control account? duplicate posting? unmapped event? mapping change effective-dated mid-period?
4. Correct with a reversal + correct posting (four-eyes). Never edit history.
5. Add/adjust the invariant test that would have caught it.

### 4.2 Duplicate or missing sale/payment
Check idempotency keys and unique (channel, external id). Void the duplicate receipt or cancel the duplicate order with a reason (audited). Verify the customer statement and stock.

### 4.3 Stock mismatch / negative stock
Compare stock ledger vs balance vs GL (`integrity`). Perform a count, post the count variance (`inv_adjust`), review shrinkage.

### 4.4 Wrong accounting mapping or tax rate
Create a *new effective-dated version* with a reason (four-eyes). Past postings are never rewritten. Re-run ACC suite, reconciliation, VAT report. Escalate to the accountant before closing the period.

### 4.5 Period closed by mistake / correction needed in a closed period
Use *Reopen period* (reason mandatory; audited as critical) by an `accounting:close` holder, post the adjustment, close again. Record why.

### 4.6 Security suspicion (unauthorised action)
Disable the account/role, snapshot the audit log, review actions by that actor, reverse unauthorised financial effects, rotate secrets (production). Notify the owner; follow the legal notification duties for personal data (PDPA) with counsel.

### 4.7 Printer / connector failure
Jobs are queued, retried and reprinted only with a reason (reprint is audited). Switch the station to an alternate printer route; reconcile missed tickets from the order list.

## 5. Data recovery
### ✅ 5.1 Prototype (executable today)
- Backup: *Settings → Data & backup* → export backup (JSON). Restore: *Restore backup*, choose the file. After restore run the *System health* page (integrity checks and the self-tests card) and confirm all integrity checks are green. Rehearsed by automated journey **J18** (export → wipe → restore → verify).
- If browser data was cleared and no backup exists, **the data is gone** (there is no server copy).

### 5.2 Production (to be defined and rehearsed — nothing here is tested)
Backup frequency, point-in-time recovery, file-storage versioning, encryption, access control, retention, **RPO/RTO**, restore owner, restore procedure. *A backup is not reliable until a restore test succeeds and evidence is recorded* (§11); after a restore run database/file consistency checks and the reconciliation matrix.

## 6. After the incident
Post-incident review within a set time: timeline, root cause, what detection failed, fixes, regression tests added, runbook updates. Record in `DEFECT_LOG.md`.

## 7. Monitoring and alerting to build (none exist)
Failed posting / unbalanced-journal attempts, reconciliation differences, failed webhooks/queues, print failures, authentication anomalies, error-rate and latency, storage and backup success.

# Bug Report Template

Copy this block into `qa/DEFECT_LOG.md` (or your tracker). **Every field is mandatory** (Addendum §12). Use "unknown" only when it truly is unknown — never leave a field blank.

```
ID:                     BUG-###
Title:                  <one line, behaviour not guess>
Environment / version:  <browser+version, OS, app version/commit, dataset/seed, role>
Module / role:          <e.g. Receivables / Cashier>
Reproduction steps:     1. …  2. …  3. …
Expected result:        …
Actual result:          …
Severity:               Critical | High | Medium | Low   (definitions below)
Frequency / scope:      always | intermittent (n/N) · one user | all users | one tenant | all tenants
Safe evidence:          <screenshot/video/log excerpt — NO real personal data, tokens or card data>
Logs / request IDs:     <audit entry id, journal no., order no., console error>
Root cause:             <when known>
Fix reference:          <commit / PR>
Retest evidence:        <test name + run id>
Regression test:        <file :: test title>   (required before closing)
Closure approval:       <name, role, date>   (Critical/High: designated owner; no informal waiver)
```

## Severity and release rule (Addendum §12)
| Severity | Definition | Release rule |
|---|---|---|
| **Critical / P0** | Data loss, security breach, unauthorized financial action, widespread outage, corrupted core ledger | **Block release**; stop the affected live operation |
| **High / P1** | Major workflow unusable or materially incorrect, with no safe workaround | **Block release** |
| **Medium / P2** | Partial failure or material usability issue with a safe workaround | Fix where practical; otherwise documented approval + plan |
| **Low / P3** | Cosmetic / minor inconvenience, no material business impact | May be scheduled later |

**Accounting-specific rule (Addendum §23.12):** any unexplained reconciliation difference, wrong account classification, duplicate posting or unbalanced journal is release-blocking for the affected workflow.

No Critical or High defect may be waived informally.

## Defect lifecycle
`New → Reproduced → In fix → Fixed (regression test added) → Retested → Closed (approved)`. A defect that cannot be reproduced stays `Needs info`; it is never closed silently.

## Rules for AI coding agents (Addendum §19)
Reproduce first where possible · add the regression test · fix · re-run the affected suites · never delete, weaken or skip a failing test to get green without an approved written explanation · never fabricate results.

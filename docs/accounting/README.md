# Accounting deliverables (Addendum §23.13)

| File | Purpose | Source of truth |
|---|---|---|
| `ACCOUNTING_SETUP_GUIDE.md` | Guided configuration and approval process | hand-written + generated checklist block |
| `CHART_OF_ACCOUNTS.csv` | Controlled import template (code, name, Thai name, type, normal, parent, posting, FS line, cash-flow, tax code, control, contra) — same columns the in-app importer accepts | generated from the live seed |
| `ACCOUNTING_POLICY_REGISTER.md` | Policies as implemented, with approval columns (blank) | hand-written, verified against code |
| `TAX_CONFIGURATION_REGISTER.md` | Tax codes, rates, treatment, effective dates | hand-written + generated table |
| `TRANSACTION_ACCOUNT_MAPPING.csv` / `.md` | Posting role → account mapping and event → debit/credit | generated + observed journal patterns |
| `OPENING_BALANCE_TEMPLATE.csv` | Opening-balance import template (non-control posting accounts; control balances come from documents) | generated |
| `ACCOUNTING_RECONCILIATION_MATRIX.md` | Subledger ↔ control-account checks, with live result | hand-written + generated table |
| `ACCOUNTING_UAT_CASES.md` | The 20 mandatory scenarios + setup cases, with automated evidence and a blank accountant-run column | hand-written |
| `PERIOD_CLOSE_CHECKLIST.md` | Monthly/period-end close procedure | hand-written |

Regenerate the generated files and blocks: `npx tsx scripts/gen-accounting-docs.ts`.

**Versioning:** all templates are **v1.0** (see the title line of each file; CSV templates carry the version in this README and in git history). Any change to an approved mapping or policy needs authorisation, an effective date, an audit-log entry and regression evidence (§23.13).

**Not approved:** none of these documents has been reviewed or approved by a qualified Thai accountant.

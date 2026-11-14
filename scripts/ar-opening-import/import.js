// Opening AR balance import.
//
// Reads Customer_AR + Customer_Master from the extracted master-data workbook,
// builds the payload and calls public.ar_import_opening on Supabase.
// Default is a DRY RUN (validation + reconciliation report, nothing written).
//
//   npm install
//   SUPABASE_ACCESS_TOKEN=... node import.js "<path>/01_MASTER_DATA.xlsx" [--commit] [--out payload.json]
//
// Env: SUPABASE_ACCESS_TOKEN (Management API token), SUPABASE_PROJECT_REF (default tomcraft_app project)
// Re-running the same file is safe: batch is matched by file SHA-256 and items by source_ref.

const X = require('xlsx');
const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const commit = args.includes('--commit');
const outIdx = args.indexOf('--out');
if (!file) throw new Error('usage: node import.js <01_MASTER_DATA.xlsx> [--commit] [--out payload.json]');

const SHEET_LINE = { 'รายรับรายจ่ายกระท่อม': 'kratom', 'รายรับรายจ่ายพอต': 'pod' };
const SOURCE_WORKBOOK = 'TOM CRAFT จำกัด 2024';

function buildPayload(path) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  const wb = X.readFile(path);
  const rows = (n) => {
    if (!wb.Sheets[n]) throw new Error(`worksheet ${n} not found`);
    return X.utils.sheet_to_json(wb.Sheets[n], { defval: null });
  };
  const ar = rows('Customer_AR');
  const master = rows('Customer_Master');

  const codeByName = new Map();
  for (const c of master) {
    if (codeByName.has(c.Customer_Name_Clean)) throw new Error(`ambiguous customer name ${c.Customer_Name_Clean}`);
    codeByName.set(c.Customer_Name_Clean, c.Migration_Key);
  }
  const isoDate = (serial) => new Date(Math.round((serial - 25569) * 864e5)).toISOString().slice(0, 10);

  const items = ar.map((r) => {
    const line = SHEET_LINE[r.Source_Sheet];
    if (!line) throw new Error(`unknown source sheet ${r.Source_Sheet} (${r.AR_Key})`);
    const flags = [];
    let docDate = typeof r.Doc_Date === 'number' ? isoDate(r.Doc_Date) : null;
    let raw = null;
    if (r.Date_Flag) { flags.push('invalid_doc_date'); raw = r.Date_Raw == null ? null : String(r.Date_Raw); docDate = null; }
    else if (!docDate) flags.push('missing_doc_date');
    if (+r.Paid_Amount > 0) flags.push('partially_paid');
    return {
      source_ref: r.AR_Key,
      customer_code: codeByName.get(r.Customer_Clean) ?? null, // unmatched -> rejected by validation
      register_no: r.Register_No,
      business_line: line,
      doc_date: docDate,
      doc_date_raw: raw,
      original_amount: +r.Original_Amount,
      paid_amount: +(r.Paid_Amount || 0),
      outstanding_amount: +r.Outstanding_Calc, // validated server-side = original - paid
      currency: r.Currency_Assumed || 'THB',
      source_workbook: SOURCE_WORKBOOK,
      source_sheet: r.Source_Sheet,
      source_row: r.Source_Row,
      source_table: r.Source_Table,
      source_status: r.Status_Source_Formula,
      review_flags: flags,
    };
  });

  const used = new Set(items.map((i) => i.customer_code).filter(Boolean));
  const customers = master
    .filter((c) => used.has(c.Migration_Key))
    .map((c) => ({ customer_code: c.Migration_Key, name: c.Customer_Name_Clean, source_ref: '01_MASTER_DATA.xlsx/Customer_Master' }));

  const batch = {
    batch_code: 'AR-OPEN-' + sha.slice(0, 12).toUpperCase(),
    source_file: path.replace(/\\/g, '/').split('/').slice(-2).join('/'),
    source_sheet: 'Customer_AR',
    source_sha256: sha,
    notes: {
      original_workbook: SOURCE_WORKBOOK,
      basis: 'Line-level outstanding (original - paid) per source row',
      currency_note: 'THB assumed: source has no currency column',
      missing_in_source: ['invoice number', 'due date', 'payment terms', 'tax'],
      source_sheet_reported_totals: { kratom_AS2: 31960, kratom_line_total: 32860, kratom_difference: 900, pod_AN2: 17960, pod_line_total: 18960, pod_difference: 1000 },
      reconciliation_refs: ['R-AR3-TOTAL', 'R-AR6-TOTAL'],
    },
  };
  return { batch, customers, items };
}

async function main() {
  const payload = buildPayload(file);
  if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], JSON.stringify(payload, null, 2));

  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set');
  const ref = process.env.SUPABASE_PROJECT_REF || 'hlvravynjalculvplrxc';
  const j = (v) => `$j$${JSON.stringify(v)}$j$::jsonb`;
  const query = `select public.ar_import_opening(${j(payload.batch)}, ${j(payload.customers)}, ${j(payload.items)}, ${!commit}) as report`;

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`import failed (${res.status}): ${body}`);
  const report = JSON.parse(body)[0].report;
  console.log(commit ? 'IMPORT' : 'DRY RUN (nothing written; add --commit to import)');
  console.table({
    'Total Source Records': report.total_source_records,
    'Customers already in DB': report.customers_existing,
    'New customers': report.customers_new,
    'Unmatched customer records': report.unmatched_customer_records,
    'Original Invoice Total': report.original_total,
    'Previously Paid Total': report.paid_total,
    'Outstanding AR Total': report.outstanding_total,
    'Successfully Imported': report.imported,
    'Duplicate Records': report.duplicate_records,
    'Import Errors': report.import_errors,
  });
  if (report.errors.length) console.log(report.errors);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

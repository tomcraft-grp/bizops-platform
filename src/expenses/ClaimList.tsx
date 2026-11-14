// A table of expense claims loaded from the central database (RLS decides which ones this user may see).
import { useEffect, useState, type ReactNode } from 'react';
import { useLang } from '../domain/store';
import { DataTable, Empty } from '../ui/kit';
import { dateFmt, money } from '../lib/util';
import { catName, listClaims, useT, type Claim, type ClaimFilters } from './api';
import { CatIcon, StatusBadge, useExpense } from './parts';

const LIMIT = 500;

export function ClaimList({ filters, refreshKey = 0, onOpen, showEmployee, extra, extraHeader, accountFilter, empty, onLoaded }: {
  filters: ClaimFilters; refreshKey?: number; onOpen: (c: Claim) => void; showEmployee?: boolean; extra?: (c: Claim) => ReactNode; extraHeader?: string;
  accountFilter?: string; empty?: ReactNode; onLoaded?: (rows: Claim[]) => void;
}) {
  const T = useT();
  const lang = useLang();
  const { catById } = useExpense();
  const [rows, setRows] = useState<Claim[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const key = JSON.stringify(filters);
  useEffect(() => {
    let live = true;
    setErr('');
    listClaims(filters, 0, LIMIT).then((r) => { if (!live) return; setRows(r.rows); setTotal(r.total); onLoaded?.(r.rows); }).catch((e) => { if (live) { setErr((e as Error).message); setRows([]); } });
    return () => { live = false; };
  }, [key, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (rows === null) return <div className="card-b"><div className="spinner" /></div>;
  const shown = accountFilter ? rows.filter((c) => (c.account_override ?? catById[c.category_id]?.account_code) === accountFilter) : rows;
  return (
    <>
      {err && <div className="card-b"><div className="exp-err" role="alert">{err}</div></div>}
      <DataTable rows={shown} rowKey={(c) => c.id} pageSize={12} onRow={onOpen} empty={empty ?? <Empty title={T('No expenses here yet', 'ยังไม่มีรายจ่าย')} />}
        cols={[
          { key: 'd', header: T('Date', 'วันที่'), sort: (c) => c.expense_date, render: (c) => dateFmt(c.expense_date) },
          { key: 'n', header: T('Expense', 'รายการ'), sort: (c) => c.description, render: (c) => <><b>{c.description}</b><div className="sub">{c.expense_no ?? T('Draft', 'แบบร่าง')}{c.vendor ? ` · ${c.vendor}` : ''}</div></> },
          { key: 'c', header: T('Category', 'หมวดหมู่'), hideSm: true, sort: (c) => catName(lang, c.category), render: (c) => <span className="row gap-6"><CatIcon name={c.category?.icon} size={15} />{catName(lang, c.category)}</span> },
          ...(showEmployee ? [{ key: 'e', header: T('Employee', 'พนักงาน'), hideSm: true, sort: (c: Claim) => c.created_by_name ?? '', render: (c: Claim) => c.created_by_name ?? '—' }] : []),
          { key: 'a', header: T('Amount', 'จำนวนเงิน'), num: true, sort: (c) => Number(c.amount_paid), render: (c) => <>{money(Number(c.amount_paid))}{Number(c.vat_amount) > 0 && <div className="sub">VAT {money(Number(c.vat_amount))}</div>}</> },
          { key: 's', header: T('Status', 'สถานะ'), sort: (c) => c.status, render: (c) => <StatusBadge status={c.status} /> },
          ...(extra ? [{ key: 'x', header: extraHeader ?? '', render: (c: Claim) => extra(c) }] : []),
        ]} />
      {total > LIMIT && <div className="card-b muted">{T(`Showing the latest ${LIMIT} of ${total}. Narrow the dates or filters to see the rest.`, `แสดงล่าสุด ${LIMIT} จาก ${total} รายการ กรุณาจำกัดช่วงวันที่หรือตัวกรอง`)}</div>}
    </>
  );
}

// Real LINE members (Supabase `profiles` rows created by the line-auth Edge Function), unlike the rest of the
// back office which still runs on the local demo store. Reading is allowed to ADMIN/SUPER_ADMIN by RLS;
// disabling/enabling a member is enforced server-side as SUPER_ADMIN-only (protect_profile_columns trigger). Giving or taking back back-office access (the ADMIN role) is a SUPER_ADMIN-only
// database function that also writes the audit log (line_member_set_access, src/lib/lineMemberAccess.ts).
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import { Badge, Banner, Button, Card, DataTable, PageHead, useConfirm } from '../ui/kit';
import { dateTimeFmt } from '../lib/util';
import type { ProfileRole } from '../auth/AuthProvider';
import { accessAction, accessMissing, ROLE_LABEL } from '../lib/lineMemberAccess';

interface Member { id: string; display_name: string | null; phone: string | null; status: 'active' | 'disabled'; created_at: string; pdpa_consent_at: string | null; role: ProfileRole }

const fmtPhone = (p: string | null) => (p ? p.replace(/^(\d{3})(\d{3})(\d{3,4})$/, '$1-$2-$3') : '—');

export default function LineMembers() {
  const { profile } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Member[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isSuper = profile?.role === 'SUPER_ADMIN';

  const load = async () => {
    setErr(null);
    const { data, error } = await supabase.from('profiles')
      .select('id, display_name, phone, status, created_at, pdpa_consent_at, role')
      .not('line_user_id', 'is', null)
      .order('created_at', { ascending: false });
    if (error) setErr(error.message); else setRows((data ?? []) as Member[]);
  };
  useEffect(() => { void load(); }, []);

  const setStatus = async (m: Member, status: Member['status']) => {
    if (status === 'disabled') {
      const r = await confirm({ title: `ปิดบัญชี ${m.display_name ?? ''}?`, body: 'สมาชิกจะเข้าแอปผ่าน LINE ไม่ได้จนกว่าจะเปิดกลับ', confirmLabel: 'ปิดบัญชี', danger: true });
      if (!r.ok) return;
    }
    const { error } = await supabase.from('profiles').update({ status }).eq('id', m.id);
    if (error) { toast('error', error.message); return; }
    toast('success', status === 'disabled' ? 'ปิดบัญชีแล้ว' : 'เปิดบัญชีแล้ว');
    void load();
  };

  const setAccess = async (m: Member, grant: boolean) => {
    const name = m.display_name ?? 'สมาชิกคนนี้';
    const r = await confirm({
      title: grant ? `ให้สิทธิ์หลังบ้านแก่ ${name}?` : `ถอนสิทธิ์หลังบ้านของ ${name}?`,
      body: grant
        ? 'บัญชี LINE นี้จะเข้าหลังบ้านได้ในระดับผู้จัดการ (ADMIN) ทั้งชุด เห็นออเดอร์ ลูกค้า และข้อมูลการเงินตามเมนูที่ผู้จัดการเข้าถึงได้ ประวัติการสั่งซื้อและแต้มเดิมของเขายังอยู่ ถอนสิทธิ์ได้ทุกเมื่อ'
        : 'เขาจะกลับเป็นลูกค้าธรรมดาและเข้าหลังบ้านไม่ได้ทันที ประวัติการสั่งซื้อและแต้มของเขายังอยู่',
      confirmLabel: grant ? 'ให้สิทธิ์หลังบ้าน' : 'ถอนสิทธิ์', danger: !grant, reason: 'เหตุผล (ไม่บังคับ บันทึกไว้ในประวัติ)', reasonOptional: true,
    });
    if (!r.ok) return;
    const { error } = await supabase.rpc('line_member_set_access', { p_profile: m.id, p_grant: grant, p_reason: r.reason.trim() || null });
    if (error) { toast('error', accessMissing(error.message) ? 'ฐานข้อมูลส่วนให้สิทธิ์หลังบ้านยังไม่ได้ติดตั้ง' : error.message); return; }
    toast('success', grant ? `ให้สิทธิ์แล้ว ให้ ${name} ปิดแล้วเปิดลิงก์หลังบ้านใหม่อีกครั้ง` : 'ถอนสิทธิ์แล้ว');
    void load();
  };

  const active = rows?.filter((r) => r.status === 'active').length ?? 0;
  const staff = rows?.filter((r) => r.role !== 'USER').length ?? 0;
  return (
    <>
      <PageHead title="สมาชิก LINE" desc="ลูกค้าที่สมัครผ่าน LINE (ข้อมูลจริงจากฐานข้อมูลกลาง)"
        actions={<Button onClick={() => void load()}><RefreshCw size={15} /> รีเฟรช</Button>} />
      {err && <Banner tone="bad">{err}</Banner>}
      {isSuper && <Banner tone="info">ปุ่ม "ให้สิทธิ์หลังบ้าน" ให้บัญชี LINE ของคนนั้นเข้าหลังบ้านได้จากลิงก์เดียวกับที่ลูกค้าใช้ (เฉพาะ SUPER_ADMIN เห็นปุ่มนี้ ทุกครั้งที่ให้หรือถอนสิทธิ์มีบันทึกไว้ในประวัติ)</Banner>}
      <Card title={rows ? `${rows.length} คน · ใช้งาน ${active} · มีสิทธิ์หลังบ้าน ${staff}` : 'กำลังโหลด…'}>
        <DataTable<Member>
          rows={rows ?? []}
          rowKey={(r) => r.id}
          search={(r) => `${r.display_name ?? ''} ${r.phone ?? ''}`}
          initialSort={{ key: 'joined', dir: 'desc' }}
          empty={rows ? 'ยังไม่มีสมาชิก' : 'กำลังโหลด…'}
          cols={[
            { key: 'name', header: 'ชื่อ', render: (r) => <b>{r.display_name ?? '—'}</b>, sort: (r) => r.display_name ?? '' },
            { key: 'phone', header: 'เบอร์โทร', render: (r) => <span className="mono">{fmtPhone(r.phone)}</span>, sort: (r) => r.phone ?? '' },
            { key: 'joined', header: 'สมัครเมื่อ', render: (r) => dateTimeFmt(r.created_at), sort: (r) => r.created_at, hideSm: true },
            { key: 'pdpa', header: 'PDPA', render: (r) => (r.pdpa_consent_at ? <Badge tone="good">ยินยอม</Badge> : <Badge tone="warn">ยังไม่กรอกข้อมูล</Badge>), hideSm: true },
            { key: 'role', header: 'สิทธิ์', render: (r) => (r.role === 'USER' ? <span className="muted">{ROLE_LABEL.USER}</span> : <Badge tone={r.role === 'SUPER_ADMIN' ? 'info' : 'good'}>{ROLE_LABEL[r.role]}</Badge>), sort: (r) => r.role },
            { key: 'status', header: 'สถานะ', render: (r) => (r.status === 'active' ? <Badge tone="good" dot>ใช้งาน</Badge> : <Badge tone="bad" dot>ปิดบัญชี</Badge>), sort: (r) => r.status },
            ...(isSuper ? [{ key: 'act', header: 'จัดการ', right: true, render: (r: Member) => {
              const a = accessAction(r, profile);
              return (
                <span className="row gap-6" style={{ justifyContent: 'flex-end' }}>
                  {a === 'grant' && <Button size="sm" variant="primary" data-testid="grant-access" onClick={() => void setAccess(r, true)}>ให้สิทธิ์หลังบ้าน</Button>}
                  {a === 'revoke' && <Button size="sm" variant="danger" data-testid="revoke-access" onClick={() => void setAccess(r, false)}>ถอนสิทธิ์หลังบ้าน</Button>}
                  {r.role !== 'SUPER_ADMIN' && (r.status === 'active'
                    ? <Button size="sm" onClick={() => void setStatus(r, 'disabled')}>ปิดบัญชี</Button>
                    : <Button size="sm" onClick={() => void setStatus(r, 'active')}>เปิดบัญชี</Button>)}
                </span>
              );
            } }] : []),
          ]}
        />
      </Card>
    </>
  );
}

// Real LINE members (Supabase `profiles` rows created by the line-auth Edge Function), unlike the rest of the
// back office which still runs on the local demo store. Reading is allowed to ADMIN/SUPER_ADMIN by RLS;
// disabling/enabling a member is enforced server-side as SUPER_ADMIN-only (protect_profile_columns trigger).
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';
import { toast } from '../domain/store';
import { Badge, Banner, Button, Card, DataTable, PageHead, useConfirm } from '../ui/kit';
import { dateTimeFmt } from '../lib/util';

interface Member { id: string; display_name: string | null; phone: string | null; status: 'active' | 'disabled'; created_at: string; pdpa_consent_at: string | null }

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
      .select('id, display_name, phone, status, created_at, pdpa_consent_at')
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

  const active = rows?.filter((r) => r.status === 'active').length ?? 0;
  return (
    <>
      <PageHead title="สมาชิก LINE" desc="ลูกค้าที่สมัครผ่าน LINE (ข้อมูลจริงจากฐานข้อมูลกลาง)"
        actions={<Button onClick={() => void load()}><RefreshCw size={15} /> รีเฟรช</Button>} />
      {err && <Banner tone="bad">{err}</Banner>}
      <Card title={rows ? `${rows.length} คน · ใช้งาน ${active}` : 'กำลังโหลด…'}>
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
            { key: 'status', header: 'สถานะ', render: (r) => (r.status === 'active' ? <Badge tone="good" dot>ใช้งาน</Badge> : <Badge tone="bad" dot>ปิดบัญชี</Badge>), sort: (r) => r.status },
            ...(isSuper ? [{ key: 'act', header: '', right: true, render: (r: Member) => (r.status === 'active'
              ? <Button size="sm" onClick={() => void setStatus(r, 'disabled')}>ปิดบัญชี</Button>
              : <Button size="sm" onClick={() => void setStatus(r, 'active')}>เปิดบัญชี</Button>) }] : []),
          ]}
        />
      </Card>
    </>
  );
}

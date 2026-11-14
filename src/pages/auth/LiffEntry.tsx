// Landing page for the LIFF endpoint (?entry=liff → #/liff, see main.tsx). Signs the customer in with
// their LINE account and sends them straight to the customer app — no form, nothing to type.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithLine } from '../../lib/liff';
import { Banner, Button, Card } from '../../ui/kit';
import { setLang } from '../../domain/store';
import { AuthLayout } from '../../ui/Brand';
import { BRAND } from '../../brand';

export default function LiffEntry() {
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false); // StrictMode runs effects twice in dev; sign in only once

  const run = () => {
    setError(null);
    signInWithLine().then((r) => {
      if (r.status === 'signed-in') {
        // Drop ?entry=liff etc. so a later reload doesn't re-run the LINE flow, then open the customer app.
        window.history.replaceState(null, '', `${window.location.pathname}#/app`);
        nav('/app', { replace: true });
      } else if (r.status === 'error') setError(r.message);
    });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Customers arriving from LINE get Thai by default unless they already chose a language.
    try { if (!localStorage.getItem('bizops.lang')) setLang('th'); } catch { /* storage unavailable: keep default */ }
    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthLayout>
      <Card title={error ? 'เข้าสู่ระบบไม่สำเร็จ' : 'กำลังเชื่อมต่อ LINE…'} sub={BRAND.name} className="auth-card">
        {error ? (
          <div className="col gap-12">
            <Banner tone="bad">{error}</Banner>
            <Button variant="primary" className="block" onClick={run}>ลองอีกครั้ง</Button>
          </div>
        ) : (
          <div className="center" style={{ padding: '12px 0' }}><div className="spinner" /></div>
        )}
      </Card>
    </AuthLayout>
  );
}

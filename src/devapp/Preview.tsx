// Device-framed preview of a customer-app layout, built from the same components as the real customer app
// (pages/CustomerApp.tsx), so what the designer shows is what customers get. Non-Home tabs are shown read-only:
// clicks are blocked so previewing can never create orders, redemptions or payments.
import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { Gift, Hash, Home, ShoppingBag, UserRound, Wallet } from 'lucide-react';
import { cx } from '../lib/util';
import type { ID } from '../domain/types';
import { EventsTab, PayTab, RewardsTab, ShopTab } from '../pages/CustomerApp';
import { BrandHeader, EditorHooks, LayoutHome, OnboardingModal, themeVars, useLayoutFont } from './render';
import { Device, DEVICES, LayoutConfig, TabKey } from './schema';

const ICON: Record<TabKey, ReactNode> = {
  home: <Home size={18} />, shop: <ShoppingBag size={18} />, rewards: <Gift size={18} />, pay: <Wallet size={18} />, events: <Hash size={18} />, profile: <UserRound size={18} />,
};

export function PhonePreview({ config, device, customerId, editor, fit, height = 720, label, intro, onIntroClose }: {
  config: LayoutConfig; device: Device; customerId: ID | null; editor?: EditorHooks; fit?: number; height?: number; label?: ReactNode;
  intro?: boolean; onIntroClose?: () => void;
}) {
  useLayoutFont(config);
  const [tab, setTab] = useState<TabKey>('home');
  const nav = config.nav.filter((n) => n.visible && n.key !== 'profile'); // profile exists only for real LINE sign-ins
  useEffect(() => { if (!nav.some((n) => n.key === tab)) setTab('home'); }, [nav.map((n) => n.key).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const width = DEVICES.find((d) => d.v === device)!.width;
  const scale = fit ? Math.min(1, fit / width) : 1;
  const frame: CSSProperties = {
    ...themeVars(config), width, height, maxHeight: 'none', margin: 0,
    borderRadius: device === 'mobile' ? 38 : 16, borderWidth: device === 'mobile' ? 10 : 6,
  };
  const go = (t: TabKey) => { if (nav.some((n) => n.key === t)) setTab(t); };
  return (
    <div style={{ width: width * scale, height: height * scale, flex: 'none' }}>
      {label && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{label}</div>}
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width, height }}>
        <div className="phone" style={frame} data-device={device}>
          <BrandHeader config={config} go={go} />
          <div className="phone-body" role="region" aria-label="Customer app preview">
            {!customerId ? <div className="muted center" style={{ padding: 24 }}>No member to preview with</div>
              : tab === 'home' ? <LayoutHome config={config} device={device} customerId={customerId} go={go} editor={editor} />
              : <div style={{ pointerEvents: 'none' }} aria-disabled="true">
                  {tab === 'shop' && <ShopTab id={customerId} go={go as (t: string) => void} />}
                  {tab === 'rewards' && <RewardsTab id={customerId} />}
                  {tab === 'pay' && <PayTab id={customerId} />}
                  {tab === 'events' && <EventsTab id={customerId} />}
                </div>}
          </div>
          <nav className={cx('phone-nav', config.theme.navStyle === 'floating' && 'floating')} style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
            {nav.map((n) => <button key={n.key} type="button" className={cx(tab === n.key && 'on')} onClick={() => setTab(n.key)}>{ICON[n.key]}{n.label}</button>)}
          </nav>
          {intro && config.onboarding.slides.length > 0 && <OnboardingModal config={config} storageKey={null} onClose={() => onIntroClose?.()} />}
        </div>
      </div>
    </div>
  );
}

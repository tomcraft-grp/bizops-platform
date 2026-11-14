// Device-framed preview of a customer-app layout, built from the same components as the real customer app
// (pages/CustomerApp.tsx), so what the designer shows is what customers get. Every page (Home, the tabs, custom pages)
// renders from the layout. The tabs' built-in features (core blocks) are shown read-only: clicks are blocked so
// previewing can never create orders, redemptions or payments.
import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { ArrowLeft, Gift, Hash, Home, ShoppingBag, UserRound, Wallet } from 'lucide-react';
import { cx } from '../lib/util';
import type { ID } from '../domain/types';
import { EventsTab, PayTab, RewardsTab, ShopTab } from '../pages/CustomerApp';
import { BrandHeader, CorePlaceholder, EditorHooks, LayoutPage, OnboardingModal, themeVars, useLayoutFont } from './render';
import { CoreType, customId, Device, DEVICES, isTabRef, LayoutConfig, PageRef, pageSections, TabKey } from './schema';
import type { Row } from './datasources';

const ICON: Record<TabKey, ReactNode> = {
  home: <Home size={18} />, shop: <ShoppingBag size={18} />, rewards: <Gift size={18} />, pay: <Wallet size={18} />, events: <Hash size={18} />, profile: <UserRound size={18} />,
};

/** Read-only rendering of a tab's built-in features for previews. */
export function previewCore(customerId: ID, go: (t: string) => void) {
  const CoreView = (t: CoreType): ReactNode => (
    t === 'profileCore' ? <CorePlaceholder type={t} />
      : <div style={{ pointerEvents: 'none' }} aria-disabled="true" className="col" >
        {t === 'shopCore' && <ShopTab id={customerId} go={go as (t: string) => void} />}
        {t === 'rewardsCore' && <RewardsTab id={customerId} />}
        {t === 'payCore' && <PayTab id={customerId} />}
        {t === 'eventsCore' && <EventsTab id={customerId} />}
      </div>
  );
  return CoreView;
}

export function PhonePreview({ config, device, customerId, editor, fit, height = 720, label, intro, onIntroClose, page: pageProp, onPage }: {
  config: LayoutConfig; device: Device; customerId: ID | null; editor?: EditorHooks; fit?: number; height?: number; label?: ReactNode;
  intro?: boolean; onIntroClose?: () => void;
  /** Controlled page (the designer's selected page). Without it the preview keeps its own page state. */
  page?: PageRef; onPage?: (p: PageRef) => void;
}) {
  useLayoutFont(config);
  const [own, setOwn] = useState<PageRef>('home');
  const [selected, setSelected] = useState<Row | null>(null);
  const page = pageProp ?? own;
  const setPage = (p: PageRef) => { if (onPage) onPage(p); else setOwn(p); };
  const nav = config.nav.filter((n) => n.visible && n.key !== 'profile'); // profile exists only for real LINE sign-ins
  useEffect(() => { if (!pageProp && isTabRef(own) && !nav.some((n) => n.key === own)) setOwn('home'); }, [nav.map((n) => n.key).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const width = DEVICES.find((d) => d.v === device)!.width;
  const scale = fit ? Math.min(1, fit / width) : 1;
  const frame: CSSProperties = {
    ...themeVars(config), width, height, maxHeight: 'none', margin: 0,
    borderRadius: device === 'mobile' ? 38 : 16, borderWidth: device === 'mobile' ? 10 : 6,
  };
  const go = (t: string, rec?: Row) => {
    const id = customId(t);
    if (id) { if (config.customPages.some((p) => p.id === id)) { setSelected(rec ?? null); setPage(t as PageRef); } return; }
    if (nav.some((n) => n.key === t) || t === 'profile') { setSelected(null); setPage(t as PageRef); }
  };
  const cp = customId(page) ? config.customPages.find((p) => p.id === customId(page)) : undefined;
  const activeTab = isTabRef(page) ? page : null;
  return (
    <div style={{ width: width * scale, height: height * scale, flex: 'none' }}>
      {label && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{label}</div>}
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width, height }}>
        <div className="phone" style={frame} data-device={device}>
          <BrandHeader config={config} go={go} />
          {cp && <div className="ca-backbar"><button type="button" className="ca-hicon" onClick={() => setPage('home')} aria-label="Back"><ArrowLeft size={16} /></button><b>{cp.title}</b></div>}
          <div className="phone-body" role="region" aria-label="Customer app preview">
            {!customerId ? <div className="muted center" style={{ padding: 24 }}>No member to preview with</div>
              : <LayoutPage key={page} config={config} sections={pageSections(config, page)} device={device} customerId={customerId} go={go} editor={editor}
                  core={previewCore(customerId, go)} selected={selected} />}
          </div>
          <nav className={cx('phone-nav', config.theme.navStyle === 'floating' && 'floating')} style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
            {nav.map((n) => <button key={n.key} type="button" className={cx(activeTab === n.key && 'on')} onClick={() => go(n.key)}>{ICON[n.key]}{n.label}</button>)}
          </nav>
          {intro && config.onboarding.slides.length > 0 && <OnboardingModal config={config} storageKey={null} onClose={() => onIntroClose?.()} />}
        </div>
      </div>
    </div>
  );
}

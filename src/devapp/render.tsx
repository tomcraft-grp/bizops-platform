// Renders a customer-app layout. Used by BOTH the real customer app (pages/CustomerApp.tsx) and the DEV APP
// designer preview, so the preview is the same code the customer runs. Text is always rendered as text (React
// escapes it); images must be https; only components from SECTION_DEFS exist.
import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { Heart, Search, ShoppingBag, X } from 'lucide-react';
import { useDB } from '../domain/store';
import { customerLifetimeSpend, expiringSoon, pointsBalance, tierFor } from '../domain/loyalty';
import { customerOutstanding } from '../domain/payments';
import { effectiveStatus } from '../domain/promotions';
import { Banner, Card } from '../ui/kit';
import { ProductEmoji, QR } from '../ui/shared';
import { money, money0 } from '../lib/util';
import type { ID } from '../domain/types';
import { CoreType, Device, deviceForWidth, FONTS, isCoreType, isSafeImageUrl, LayoutConfig, PropItem, Section, sectionDef, TabKey } from './schema';
import {
  ChartSection, DataCardSection, DataListSection, DataTableSection, DesignerCtx, FilterSection, Go, KpiSection, PageQueryCtx, ProductCardsSection,
  ProductImageSection, SearchSection, usePageQueryState,
} from './dataViews';
import type { Row } from './datasources';

/** CSS variables for the customer app frame. Kit components inside pick them up (buttons, cards, text). */
export function themeVars(c: LayoutConfig): CSSProperties {
  const t = c.theme;
  const font = FONTS.find((f) => f.v === t.font) ?? FONTS[0];
  return {
    '--brand': t.primary, '--brand-hover': t.primary, '--on-brand': t.primaryText, '--bg': t.background, '--surface': t.surface,
    '--text': t.text, '--muted': t.muted, '--radius': `${t.radius}px`, '--ca-header-bg': t.headerBg, '--ca-header-text': t.headerText,
    '--ca-nav-active': t.navActive, '--ca-card-from': t.cardFrom, '--ca-card-to': t.cardTo, '--ca-gap': `${t.gap}px`, '--ca-pad': `${t.padding}px`,
    // derived neutrals so dark themes get matching borders and secondary surfaces
    '--border': `color-mix(in srgb, ${t.text} 14%, ${t.surface})`, '--hairline': `color-mix(in srgb, ${t.text} 8%, ${t.surface})`,
    '--surface-2': `color-mix(in srgb, ${t.text} 4%, ${t.surface})`, '--surface-3': `color-mix(in srgb, ${t.text} 9%, ${t.surface})`, '--text2': t.muted,
    ...(font.v !== 'system' ? { '--font': font.css, fontFamily: font.css } : {}), fontSize: t.baseSize, color: t.text,
  } as CSSProperties;
}

/** Load a Google font from the allow-list once (only when a layout selects one). */
export function useLayoutFont(c: LayoutConfig | null) {
  const font = c ? FONTS.find((f) => f.v === c.theme.font) : undefined;
  useEffect(() => {
    if (!font?.google) return;
    const id = 'ca-font-' + font.v;
    if (document.getElementById(id)) return;
    const l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet'; l.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
    document.head.appendChild(l);
  }, [font?.v, font?.google]);
}

// ---------------------------------------------------------------- member-data sections (same markup as the original Home tab)
export function MemberCardSection({ id, showQr = true, showProgress = true }: { id: ID; showQr?: boolean; showProgress?: boolean }) {
  const db = useDB();
  const c = db.customers.find((x) => x.id === id);
  if (!c) return null;
  const spend = customerLifetimeSpend(db, id);
  const tier = tierFor(db, spend);
  const next = [...db.loyalty.tiers].sort((a, b) => a.minSpend - b.minSpend).find((t) => t.minSpend > spend);
  const pts = pointsBalance(db, id);
  const exp = expiringSoon(db, id, new Date().toISOString());
  return (
    <div className="cust-card">
      <div className="row between"><div><div style={{ opacity: 0.8, fontSize: 12 }}>Member</div><div style={{ fontSize: 18, fontWeight: 700 }}>{c.name}</div></div><span style={{ background: 'rgba(255,255,255,.2)', padding: '3px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12 }}>{tier.name}</span></div>
      <div style={{ fontSize: 34, fontWeight: 750, marginTop: 10 }}>{pts.toLocaleString()} <span style={{ fontSize: 14, fontWeight: 500 }}>points</span></div>
      {exp > 0 && <div style={{ fontSize: 12, opacity: 0.9 }}>{exp} points expire within 60 days</div>}
      {showProgress && next && <div style={{ marginTop: 10 }}><div style={{ fontSize: 12, opacity: 0.9 }}>{money0(next.minSpend - spend)} more to reach {next.name}</div><div className="progress" style={{ background: 'rgba(255,255,255,.25)', marginTop: 4 }}><i style={{ width: `${Math.min(100, (spend / next.minSpend) * 100)}%`, background: '#fff' }} /></div></div>}
      {showQr && <div className="row mt16" style={{ justifyContent: 'center' }}><QR data={`MEMBER|${c.code}`} size={96} /></div>}
    </div>
  );
}
export function OutstandingSection({ id, go }: { id: ID; go: (t: TabKey) => void }) {
  const db = useDB();
  const out = customerOutstanding(db, id);
  return out > 0 ? <Banner tone="warn">You have an outstanding balance of <b>{money(out)}</b>. <a onClick={() => go('pay')} style={{ cursor: 'pointer' }}>Pay now</a></Banner> : null;
}
export function CouponsSection({ id, title = 'My coupons' }: { id: ID; title?: string }) {
  const db = useDB();
  const coupons = db.coupons.filter((x) => x.customerId === id && x.status === 'issued' && x.expiresAt > new Date().toISOString());
  return coupons.length > 0 ? <Card title={title}>{coupons.map((x) => <div key={x.id} className="row between" style={{ padding: '4px 0' }}><span>{x.title}</span><span className="mono">{x.code}</span></div>)}<div className="muted" style={{ fontSize: 12 }}>Show the code at the counter or enter it at checkout.</div></Card> : null;
}
export function OffersSection({ title = 'Offers for you', limit = 4 }: { title?: string; limit?: number }) {
  const db = useDB();
  const promos = db.promotions.filter((p) => effectiveStatus(p, new Date().toISOString()) === 'active' && !p.code && (!p.channels.length || p.channels.includes('LINE') || p.channels.includes('POS'))).slice(0, limit);
  return <Card title={title}>{promos.map((p) => <div key={p.id} style={{ padding: '5px 0' }}><b>{p.name}</b><div className="muted" style={{ fontSize: 12.5 }}>{p.description}</div></div>)}</Card>;
}

export function CategoriesSection({ limit = 8, shape = 'rounded', go }: { limit?: number; shape?: string; go: (t: TabKey) => void }) {
  const db = useDB();
  const cats: { name: string; p: (typeof db.products)[number] }[] = [];
  for (const p of db.products) if (p.active && ['resale', 'finished', 'menu'].includes(p.kind) && !cats.some((c) => c.name === p.category)) cats.push({ name: p.category, p });
  return (
    <div className="ca-hscroll">
      {cats.slice(0, limit).map((c) => (
        <button key={c.name} type="button" className="ca-cat" onClick={() => go('shop')}>
          <span className={shape === 'circle' ? 'ca-cat-img circle' : 'ca-cat-img'}><ProductEmoji p={c.p} size={44} /></span>
          <span className="ca-cat-name">{c.name}</span>
        </button>
      ))}
    </div>
  );
}
export function CouponStripSection({ id, buttonLabel = 'Use', linkTab = 'shop', limit = 6, go }: { id: ID; buttonLabel?: string; linkTab?: string; limit?: number; go: (t: TabKey) => void }) {
  const db = useDB();
  const nowIso = new Date().toISOString();
  const mine = db.coupons.filter((x) => x.customerId === id && x.status === 'issued' && x.expiresAt > nowIso)
    .map((x) => ({ key: x.id, big: x.kind === 'percent' ? `-${x.value}%` : `฿${x.value}`, title: x.title, sub: x.minOrder ? `min ${money0(x.minOrder)}` : '', code: x.code }));
  const pub = db.promotions.filter((p) => p.code && effectiveStatus(p, nowIso) === 'active')
    .map((p) => ({ key: p.id, big: '%', title: p.name, sub: p.description, code: p.code! }));
  const all = [...mine, ...pub].slice(0, limit);
  if (!all.length) return null;
  return (
    <div className="ca-hscroll">
      {all.map((c) => (
        <div key={c.key} className="ca-coupon">
          <div className="ca-coupon-big">{c.big}</div>
          <div className="ca-coupon-body"><b>{c.title}</b>{c.sub && <span className="muted">{c.sub}</span>}<span className="mono" style={{ fontSize: 11.5 }}>{c.code}</span></div>
          {buttonLabel && <button type="button" className="btn primary sm ca-coupon-btn" onClick={() => linkTab && go(linkTab as TabKey)}>{buttonLabel}</button>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- one section
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);

export function SectionView({ s, customerId, go }: { s: Section; customerId: ID; go: Go }): ReactNode {
  const p = s.props;
  const link = (t: unknown) => (typeof t === 'string' && t ? () => go(t) : undefined);
  switch (s.type) {
    case 'dataCard': return <DataCardSection p={p} customerId={customerId} go={go} />;
    case 'productCard': return <ProductCardsSection p={p} customerId={customerId} go={go} />;
    case 'productImage': return <ProductImageSection p={p} customerId={customerId} />;
    case 'dataTable': return <DataTableSection p={p} customerId={customerId} go={go} />;
    case 'dataList': return <DataListSection p={p} customerId={customerId} go={go} />;
    case 'kpi': return <KpiSection p={p} customerId={customerId} />;
    case 'chart': return <ChartSection p={p} customerId={customerId} />;
    case 'search': return <SearchSection p={p} />;
    case 'filter': return <FilterSection p={p} customerId={customerId} />;
    case 'memberCard': return <MemberCardSection id={customerId} showQr={p.showQr !== false} showProgress={p.showProgress !== false} />;
    case 'outstandingNotice': return <OutstandingSection id={customerId} go={go} />;
    case 'myCoupons': return <CouponsSection id={customerId} title={str(p.title, 'My coupons')} />;
    case 'offers': return <OffersSection title={str(p.title, 'Offers for you')} limit={num(p.limit, 4)} />;
    case 'categories': return <CategoriesSection limit={num(p.limit, 8)} shape={str(p.shape, 'rounded')} go={go} />;
    case 'couponStrip': return <CouponStripSection id={customerId} buttonLabel={str(p.buttonLabel)} linkTab={str(p.linkTab)} limit={num(p.limit, 6)} go={go} />;
    case 'announcement': {
      const lines = str(p.lines).split('\n').map((x) => x.trim()).filter(Boolean);
      if (!lines.length) return null;
      const run = <span className="ca-marquee-run">{lines.map((l, i) => <span key={i}>{l}<i aria-hidden>•</i></span>)}</span>;
      return p.scroll === false
        ? <div className="ca-announce"><span className="ca-marquee-run" style={{ flexWrap: 'wrap' }}>{lines.map((l, i) => <span key={i}>{l}</span>)}</span></div>
        : <div className="ca-announce" role="marquee" aria-label={lines.join(' · ')}><div className="ca-marquee" style={{ animationDuration: `${num(p.speed, 30)}s` }}>{run}{run}</div></div>;
    }
    case 'sectionHeader': {
      const onClick = link(p.linkTab);
      return <div className="row between" style={{ alignItems: 'baseline', gap: 8 }}><div style={{ fontSize: num(p.size, 22), fontWeight: 800, lineHeight: 1.2 }}>{str(p.title)}</div>{str(p.linkLabel) && <button type="button" className="ca-link" onClick={onClick}>{str(p.linkLabel)}</button>}</div>;
    }
    case 'carousel': {
      const items = (Array.isArray(p.items) ? p.items : []) as PropItem[];
      return (
        <div className="ca-hscroll">
          {items.map((it, i) => {
            const url = it.imageUrl && isSafeImageUrl(it.imageUrl) ? it.imageUrl : '';
            const onClick = link(it.linkTab);
            return (
              <div key={i} className="ca-slide" role={onClick ? 'button' : undefined} onClick={onClick} style={{ width: `${num(p.cardWidth, 78)}%`, height: num(p.height, 180), cursor: onClick ? 'pointer' : undefined,
                background: url ? `center / cover no-repeat url("${encodeURI(url)}")` : 'linear-gradient(135deg, var(--ca-card-from, #1c5cab), var(--ca-card-to, #6250d6))' }}>
                {it.badge && <span className="ca-slide-badge">{it.badge}</span>}
                <div className="ca-slide-text">{it.title && <b>{it.title}</b>}{it.subtitle && <span>{it.subtitle}</span>}</div>
              </div>
            );
          })}
        </div>
      );
    }
    case 'banner': {
      const url = str(p.imageUrl); const onClick = link(p.linkTab);
      return (
        <div role={onClick ? 'button' : undefined} onClick={onClick} style={{ position: 'relative', height: num(p.height, 140), borderRadius: 'var(--radius)', overflow: 'hidden', cursor: onClick ? 'pointer' : undefined,
          background: url && isSafeImageUrl(url) ? `center / cover no-repeat url("${encodeURI(url)}")` : 'linear-gradient(135deg, var(--ca-card-from, #1c5cab), var(--ca-card-to, #6250d6))' }}
          aria-label={str(p.alt) || str(p.headline) || undefined}>
          {str(p.headline) && <div style={{ position: 'absolute', left: 14, right: 14, bottom: 12, color: '#fff', fontSize: 20, fontWeight: 700, textShadow: '0 1px 6px rgba(0,0,0,.45)' }}>{str(p.headline)}</div>}
        </div>
      );
    }
    case 'heading': return <div style={{ fontSize: num(p.size, 20), fontWeight: 700, lineHeight: 1.25 }}>{str(p.text)}</div>;
    case 'text': return <div style={{ fontSize: num(p.size, 14), whiteSpace: 'pre-wrap' }}>{str(p.text)}</div>;
    case 'image': {
      const url = str(p.imageUrl);
      return url && isSafeImageUrl(url)
        ? <img src={url} alt={str(p.alt)} style={{ width: '100%', height: num(p.height, 180), objectFit: p.fit === 'contain' ? 'contain' : 'cover', borderRadius: 'var(--radius)', display: 'block' }} />
        : <div className="muted" style={{ height: num(p.height, 180), borderRadius: 'var(--radius)', border: '1px dashed var(--border)', display: 'grid', placeItems: 'center', fontSize: 12 }}>{str(p.alt) || 'Image'}</div>;
    }
    case 'button': {
      const outline = p.variant === 'outline';
      return <button type="button" className={outline ? 'btn' : 'btn primary'} onClick={link(p.linkTab)} style={{ width: p.fullWidth ? '100%' : undefined, justifyContent: 'center', ...(outline ? { borderColor: 'var(--brand)', color: 'var(--brand)' } : {}) }}>{str(p.label)}</button>;
    }
    case 'card': return <Card title={str(p.title) || undefined}><div style={{ whiteSpace: 'pre-wrap' }}>{str(p.body)}</div></Card>;
    case 'spacer': return <div style={{ height: num(p.height, 24) }} />;
    case 'divider': return <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0 }} />;
    default: return null;
  }
}

/** Header bar of the customer app for a configured layout (logo + title + tagline). */
export function BrandHeader({ config, go }: { config: LayoutConfig; go?: (t: TabKey) => void }) {
  const b = config.brand;
  const logo = b.logoUrl && isSafeImageUrl(b.logoUrl);
  if (b.headerStyle === 'centered') {
    const icon = (node: ReactNode, label: string, tab?: TabKey) => <button type="button" className="ca-hicon" aria-label={label} onClick={() => tab && go?.(tab)}>{node}</button>;
    return (
      <div className="phone-top ca-top-centered">
        <span className="row gap-6">{b.showIcons && icon(<Search size={18} />, 'Search', 'shop')}</span>
        <b className="row gap-6" style={{ justifyContent: 'center', minWidth: 0 }}>{logo ? <img src={b.logoUrl} alt={b.title} style={{ height: 30, width: 'auto' }} /> : <span style={{ fontSize: 18 }}>{b.title}</span>}{b.tagline && <span className="ca-pill">{b.tagline}</span>}</b>
        <span className="row gap-6" style={{ justifyContent: 'flex-end' }}>{b.showIcons && <>{icon(<Heart size={18} />, 'Favourites', 'rewards')}{icon(<ShoppingBag size={18} />, 'Basket', 'shop')}</>}</span>
      </div>
    );
  }
  return (
    <div className="phone-top">
      <b className="row gap-6" style={{ minWidth: 0 }}>{b.logoUrl && isSafeImageUrl(b.logoUrl) && <img src={b.logoUrl} alt="" style={{ height: 24, width: 'auto', borderRadius: 4 }} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.title}</span></b>
      <span style={{ fontSize: 12, opacity: 0.9 }}>{b.tagline || 'LINE'}</span>
    </div>
  );
}

/** Which device layout applies, from the rendered width of the app body (phone frame, tablet or desktop). */
export function useDeviceOf(el: HTMLElement | null): Device {
  const [w, setW] = useState(390);
  useEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return deviceForWidth(w);
}

/** First-visit intro pop-up (slides with Back / Next and a "don't show again" box, remembered per layout version). */
export function OnboardingModal({ config, storageKey, onClose }: { config: LayoutConfig; storageKey: string | null; onClose: () => void }) {
  const slides = config.onboarding.slides;
  const [i, setI] = useState(0);
  const [never, setNever] = useState(false);
  if (!slides.length) return null;
  const s = slides[Math.min(i, slides.length - 1)];
  const close = () => { if (never && storageKey) { try { localStorage.setItem(storageKey, '1'); } catch { /* ignore */ } } onClose(); };
  return (
    <div className="ca-intro" role="dialog" aria-modal="true" aria-label={s.title}>
      <button type="button" className="ca-intro-x" onClick={close} aria-label="Close"><X size={20} /></button>
      <div className="ca-intro-card">
        {s.title && <div className="ca-intro-title">{s.title}</div>}
        {s.text && <div style={{ whiteSpace: 'pre-wrap', textAlign: 'center' }}>{s.text}</div>}
        {s.imageUrl && isSafeImageUrl(s.imageUrl) && <img src={s.imageUrl} alt="" style={{ width: '100%', maxHeight: 280, objectFit: 'contain', borderRadius: 12 }} />}
      </div>
      <div className="ca-intro-nav">
        <button type="button" className="btn primary" disabled={i === 0} onClick={() => setI(i - 1)} aria-label="Previous">‹</button>
        <span className="ca-intro-dots">{slides.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}<small>{i + 1} / {slides.length}</small></span>
        {i < slides.length - 1 ? <button type="button" className="btn primary" onClick={() => setI(i + 1)} aria-label="Next">›</button> : <button type="button" className="btn primary" onClick={close}>OK</button>}
      </div>
      {storageKey && <label className="check ca-intro-never"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />{"Don't show this again"}</label>}
    </div>
  );
}

export interface EditorHooks {
  selected: string | null;
  render: (s: Section, content: ReactNode, hiddenHere: boolean) => ReactNode;
}

/** Placeholder for a tab's built-in features where they cannot run (e.g. the profile form outside a LINE sign-in). */
export function CorePlaceholder({ type }: { type: CoreType }) {
  const d = sectionDef(type)!;
  return <div className="ca-core-ph"><b>{d.label}</b><span>{d.desc}</span></div>;
}

/**
 * One page of a configured layout (Home, a tab page or a custom page): a 12-column grid; each section's width depends
 * on the device. Core blocks (the tab's built-in features) are drawn by `core`, supplied by the host app, so their
 * business logic stays in pages/CustomerApp.tsx. Sections limited to some customer groups are skipped for others.
 */
export function LayoutPage({ config, sections, device, customerId, go, editor, core, selected = null }: {
  config: LayoutConfig; sections: Section[]; device: Device; customerId: ID; go: Go; editor?: EditorHooks;
  core?: (t: CoreType) => ReactNode; selected?: Row | null;
}) {
  void config;
  const db = useDB();
  const group = db.customers.find((c) => c.id === customerId)?.group;
  const pq = usePageQueryState(selected);
  return (
    <DesignerCtx.Provider value={!!editor}>
      <PageQueryCtx.Provider value={pq}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 'var(--ca-gap, 12px)', alignContent: 'start' }}>
          {sections.map((s) => {
            const notForMember = !!group && (s.visibility?.groups?.length ?? 0) > 0 && !s.visibility.groups.includes(group);
            const hiddenHere = !!s.hidden?.[device] || notForMember;
            if (hiddenHere && !editor) return null;
            const st = s.style;
            const box: CSSProperties = {
              gridColumn: `span ${Math.min(12, Math.max(1, s.span?.[device] ?? 12))}`, padding: st.padding || undefined, marginTop: st.marginTop || undefined,
              background: st.background || undefined, color: st.textColor || undefined, borderRadius: st.radius || undefined, textAlign: st.align, minWidth: 0,
            };
            const content = isCoreType(s.type)
              ? <div className="ca-core">{core ? core(s.type) : <CorePlaceholder type={s.type} />}</div>
              : <SectionView s={s} customerId={customerId} go={go} />;
            return <div key={s.id} className="ca-sec" style={box} data-section={s.id}>{editor ? editor.render(s, content, hiddenHere) : content}</div>;
          })}
        </div>
      </PageQueryCtx.Provider>
    </DesignerCtx.Provider>
  );
}

/** The Home page of a configured layout (kept for existing callers). */
export function LayoutHome(props: { config: LayoutConfig; device: Device; customerId: ID; go: Go; editor?: EditorHooks }) {
  return <LayoutPage {...props} sections={props.config.home} />;
}

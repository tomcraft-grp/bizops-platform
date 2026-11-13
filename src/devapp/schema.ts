// DEV APP Customer: the layout configuration of a customer-facing app, as structured JSON.
// The config never holds markup or code. The app renders it with the fixed component allow-list in
// SECTION_DEFS, and validateLayout() (mirrored server-side by public.customer_app_validate) rejects anything else.

export const SCHEMA_VERSION = 1 as const;
export type Device = 'mobile' | 'tablet' | 'desktop';
export const DEVICES: { v: Device; label: string; width: number }[] = [
  { v: 'mobile', label: 'Mobile', width: 390 },
  { v: 'tablet', label: 'Tablet', width: 768 },
  { v: 'desktop', label: 'Desktop', width: 1180 },
];
export const deviceForWidth = (w: number): Device => (w >= 1000 ? 'desktop' : w >= 600 ? 'tablet' : 'mobile');

export type TabKey = 'home' | 'shop' | 'rewards' | 'pay' | 'events' | 'profile';
/** Tabs a layout may rename or reorder but never hide. */
export const ALWAYS_VISIBLE: TabKey[] = ['home', 'profile'];
export const TAB_KEYS: TabKey[] = ['home', 'shop', 'rewards', 'pay', 'events', 'profile'];

export const FONTS: { v: string; label: string; css: string; google?: string }[] = [
  { v: 'system', label: 'System default', css: 'inherit' },
  { v: 'noto-sans-thai', label: 'Noto Sans Thai', css: "'Noto Sans Thai', sans-serif", google: 'Noto+Sans+Thai:wght@400;600;700' },
  { v: 'prompt', label: 'Prompt', css: "'Prompt', sans-serif", google: 'Prompt:wght@400;600;700' },
  { v: 'sarabun', label: 'Sarabun', css: "'Sarabun', sans-serif", google: 'Sarabun:wght@400;600;700' },
  { v: 'kanit', label: 'Kanit', css: "'Kanit', sans-serif", google: 'Kanit:wght@400;600;700' },
];

export interface Theme {
  primary: string; primaryText: string; background: string; surface: string; text: string; muted: string;
  headerBg: string; headerText: string; navActive: string; cardFrom: string; cardTo: string;
  font: string; baseSize: number; radius: number; gap: number; padding: number;
  /** 'classic' = full-width bar (today's look); 'floating' = rounded pill above the bottom edge with a glowing active tab */
  navStyle: 'classic' | 'floating';
}
export interface Brand {
  title: string; logoUrl: string; tagline: string;
  /** 'classic' = title left, tagline right (today's look); 'centered' = logo/title centred with icon buttons either side */
  headerStyle: 'classic' | 'centered';
  showIcons: boolean;
}
export interface OnboardingSlide { title: string; text: string; imageUrl: string }
/** Optional intro pop-up shown the first time a member opens a published layout ("don't show again" is remembered per version). */
export interface Onboarding { enabled: boolean; slides: OnboardingSlide[] }
export interface NavTab { key: TabKey; label: string; visible: boolean }
export type Span = Record<Device, number>; // columns out of 12
export interface SectionStyle {
  padding: number; marginTop: number; background: string; textColor: string; radius: number; align: 'left' | 'center' | 'right';
}
export type PropItem = Record<string, string>;
export type PropValue = string | number | boolean | PropItem[];
export interface Section {
  id: string; type: SectionType; props: Record<string, PropValue>; span: Span; hidden: Record<Device, boolean>; style: SectionStyle;
}
export interface LayoutConfig { schemaVersion: typeof SCHEMA_VERSION; theme: Theme; brand: Brand; nav: NavTab[]; home: Section[]; onboarding: Onboarding }

// ---------------------------------------------------------------- component allow-list
export type SectionType = 'memberCard' | 'outstandingNotice' | 'myCoupons' | 'offers'
  | 'categories' | 'couponStrip'
  | 'banner' | 'heading' | 'text' | 'image' | 'button' | 'card' | 'spacer' | 'divider'
  | 'announcement' | 'sectionHeader' | 'carousel';
export type FieldKind = 'text' | 'textarea' | 'number' | 'color' | 'image' | 'tab' | 'select' | 'boolean' | 'items';
export interface FieldDef {
  key: string; label: string; kind: FieldKind; options?: { v: string; label: string }[]; min?: number; max?: number; max_len?: number;
  /** kind 'items': the fields of each item (text / textarea / image / tab only) and the maximum number of items */
  item?: FieldDef[]; max_items?: number;
}
export interface SectionDef { type: SectionType; label: string; group: 'Member data' | 'Content' | 'Layout'; desc: string; fields: FieldDef[]; defaults: Record<string, PropValue> }

const TAB_FIELD = (key: string, label: string): FieldDef => ({ key, label, kind: 'tab' });
export const SECTION_DEFS: SectionDef[] = [
  { type: 'memberCard', group: 'Member data', label: 'Member card', desc: 'Name, tier, points, progress to next tier and member QR', fields: [
    { key: 'showQr', label: 'Show member QR', kind: 'boolean' }, { key: 'showProgress', label: 'Show tier progress', kind: 'boolean' }], defaults: { showQr: true, showProgress: true } },
  { type: 'outstandingNotice', group: 'Member data', label: 'Outstanding balance notice', desc: 'Shown only when the member owes money', fields: [], defaults: {} },
  { type: 'myCoupons', group: 'Member data', label: 'My coupons', desc: "The member's valid coupons (hidden when there are none)", fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 60 }], defaults: { title: 'My coupons' } },
  { type: 'offers', group: 'Member data', label: 'Offers for you', desc: 'Active promotions for LINE / store', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 60 }, { key: 'limit', label: 'Max offers', kind: 'number', min: 1, max: 10 }], defaults: { title: 'Offers for you', limit: 4 } },
  { type: 'categories', group: 'Member data', label: 'Product categories', desc: 'Round tiles of the shop categories (scroll sideways); tapping opens the shop', fields: [
    { key: 'limit', label: 'Max categories', kind: 'number', min: 2, max: 20 },
    { key: 'shape', label: 'Tile shape', kind: 'select', options: [{ v: 'circle', label: 'Circle' }, { v: 'rounded', label: 'Rounded square' }] }], defaults: { limit: 8, shape: 'rounded' } },
  { type: 'couponStrip', group: 'Member data', label: 'Coupon strip', desc: "Ticket-style coupons (the member's coupons, then public promo codes), scrolling sideways", fields: [
    { key: 'buttonLabel', label: 'Button label', kind: 'text', max_len: 20 }, TAB_FIELD('linkTab', 'Button opens tab'), { key: 'limit', label: 'Max coupons', kind: 'number', min: 1, max: 10 }],
    defaults: { buttonLabel: 'Use', linkTab: 'shop', limit: 6 } },
  { type: 'banner', group: 'Content', label: 'Banner', desc: 'Wide image with optional headline and link', fields: [
    { key: 'imageUrl', label: 'Image', kind: 'image' }, { key: 'alt', label: 'Image description', kind: 'text', max_len: 120 },
    { key: 'headline', label: 'Headline', kind: 'text', max_len: 80 }, { key: 'height', label: 'Height (px)', kind: 'number', min: 60, max: 400 },
    TAB_FIELD('linkTab', 'Opens tab when tapped')], defaults: { imageUrl: '', alt: '', headline: 'Welcome!', height: 140, linkTab: '' } },
  { type: 'announcement', group: 'Content', label: 'Announcement bar', desc: 'Scrolling message strip (one message per line)', fields: [
    { key: 'lines', label: 'Messages (one per line)', kind: 'textarea', max_len: 600 }, { key: 'speed', label: 'Speed (seconds per loop)', kind: 'number', min: 8, max: 120 },
    { key: 'scroll', label: 'Scroll continuously', kind: 'boolean' }], defaults: { lines: 'Welcome to our shop\nFree delivery on your first order', speed: 30, scroll: true } },
  { type: 'sectionHeader', group: 'Content', label: 'Section header', desc: 'Bold title with a “See all” link on the right', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 60 }, { key: 'linkLabel', label: 'Link text', kind: 'text', max_len: 30 }, TAB_FIELD('linkTab', 'Link opens tab'),
    { key: 'size', label: 'Title size (px)', kind: 'number', min: 14, max: 36 }], defaults: { title: 'Bundle set', linkLabel: 'See all ›', linkTab: 'shop', size: 22 } },
  { type: 'carousel', group: 'Content', label: 'Card carousel', desc: 'Large image cards that scroll sideways (promotions, bundles, news)', fields: [
    { key: 'items', label: 'Cards', kind: 'items', max_items: 10, item: [
      { key: 'imageUrl', label: 'Image', kind: 'image' }, { key: 'badge', label: 'Small label', kind: 'text', max_len: 24 },
      { key: 'title', label: 'Title', kind: 'text', max_len: 60 }, { key: 'subtitle', label: 'Subtitle', kind: 'text', max_len: 80 }, TAB_FIELD('linkTab', 'Opens tab')] },
    { key: 'cardWidth', label: 'Card width (% of screen)', kind: 'number', min: 40, max: 100 }, { key: 'height', label: 'Card height (px)', kind: 'number', min: 100, max: 400 }],
    defaults: { items: [{ imageUrl: '', badge: 'Special deal', title: 'Buy 1 get 1', subtitle: 'This week only', linkTab: 'shop' }, { imageUrl: '', badge: 'New', title: 'New arrivals', subtitle: 'See what just landed', linkTab: 'shop' }], cardWidth: 78, height: 180 } },
  { type: 'heading', group: 'Content', label: 'Heading', desc: 'Section title', fields: [
    { key: 'text', label: 'Text', kind: 'text', max_len: 120 }, { key: 'size', label: 'Size (px)', kind: 'number', min: 12, max: 40 }], defaults: { text: 'Heading', size: 20 } },
  { type: 'text', group: 'Content', label: 'Text', desc: 'Paragraph (plain text, line breaks kept)', fields: [
    { key: 'text', label: 'Text', kind: 'textarea', max_len: 2000 }, { key: 'size', label: 'Size (px)', kind: 'number', min: 10, max: 28 }], defaults: { text: 'Write something for your members.', size: 14 } },
  { type: 'image', group: 'Content', label: 'Image', desc: 'Picture, e.g. a menu or poster', fields: [
    { key: 'imageUrl', label: 'Image', kind: 'image' }, { key: 'alt', label: 'Image description', kind: 'text', max_len: 120 },
    { key: 'fit', label: 'Fit', kind: 'select', options: [{ v: 'cover', label: 'Fill' }, { v: 'contain', label: 'Fit whole image' }] },
    { key: 'height', label: 'Height (px)', kind: 'number', min: 60, max: 600 }], defaults: { imageUrl: '', alt: '', fit: 'cover', height: 180 } },
  { type: 'button', group: 'Content', label: 'Button', desc: 'Opens one of the app tabs', fields: [
    { key: 'label', label: 'Label', kind: 'text', max_len: 40 }, TAB_FIELD('linkTab', 'Opens tab'),
    { key: 'variant', label: 'Style', kind: 'select', options: [{ v: 'primary', label: 'Filled' }, { v: 'outline', label: 'Outline' }] },
    { key: 'fullWidth', label: 'Full width', kind: 'boolean' }], defaults: { label: 'Order now', linkTab: 'shop', variant: 'primary', fullWidth: true } },
  { type: 'card', group: 'Content', label: 'Card', desc: 'Title and text in a card', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 80 }, { key: 'body', label: 'Text', kind: 'textarea', max_len: 1000 }], defaults: { title: 'Card title', body: 'Card text' } },
  { type: 'spacer', group: 'Layout', label: 'Spacer', desc: 'Empty space', fields: [{ key: 'height', label: 'Height (px)', kind: 'number', min: 4, max: 200 }], defaults: { height: 24 } },
  { type: 'divider', group: 'Layout', label: 'Divider', desc: 'Horizontal line', fields: [], defaults: {} },
];
export const sectionDef = (t: string) => SECTION_DEFS.find((d) => d.type === t);

// ---------------------------------------------------------------- defaults (= the app as it looks today)
export const DEFAULT_THEME: Theme = {
  primary: '#2068c4', primaryText: '#ffffff', background: '#f6f6f3', surface: '#ffffff', text: '#0b0b0b', muted: '#6a6963',
  headerBg: '#047a3b', headerText: '#ffffff', navActive: '#047a3b', cardFrom: '#1c5cab', cardTo: '#6250d6',
  font: 'system', baseSize: 14, radius: 12, gap: 12, padding: 14, navStyle: 'classic',
};

/** One-click starting points for the Theme panel. "Dark neon" matches a dark shop style with a bright accent. */
export const THEME_PRESETS: { v: string; label: string; theme: Partial<Theme>; brand?: Partial<Brand> }[] = [
  { v: 'default', label: 'Light (current app)', theme: { ...{} }, brand: { headerStyle: 'classic', showIcons: false } },
  { v: 'dark-neon', label: 'Dark neon', theme: { primary: '#c6ff00', primaryText: '#0b0b0b', background: '#0b0b0b', surface: '#1b1b1b', text: '#ffffff', muted: '#a3a3a3', headerBg: '#0b0b0b', headerText: '#ffffff', navActive: '#c6ff00', cardFrom: '#2f4410', cardTo: '#141a08', radius: 18, navStyle: 'floating' }, brand: { headerStyle: 'centered', showIcons: true } },
  { v: 'ocean', label: 'Ocean', theme: { primary: '#0a84ff', primaryText: '#ffffff', background: '#eef5fb', surface: '#ffffff', text: '#0b1b2b', muted: '#5b6b7b', headerBg: '#0a4f8f', headerText: '#ffffff', navActive: '#0a84ff', cardFrom: '#0a4f8f', cardTo: '#0ab3c9', radius: 16, navStyle: 'floating' }, brand: { headerStyle: 'centered', showIcons: true } },
  { v: 'warm', label: 'Warm café', theme: { primary: '#8a4b2a', primaryText: '#ffffff', background: '#f7f1ea', surface: '#fffaf4', text: '#2b1d14', muted: '#7a6555', headerBg: '#5a3220', headerText: '#fff4e8', navActive: '#8a4b2a', cardFrom: '#5a3220', cardTo: '#b9773e', radius: 14, navStyle: 'classic' }, brand: { headerStyle: 'classic', showIcons: false } },
];
export const DEFAULT_STYLE: SectionStyle = { padding: 0, marginTop: 0, background: '', textColor: '', radius: 0, align: 'left' };
const FULL: Span = { mobile: 12, tablet: 12, desktop: 12 };
const SHOWN: Record<Device, boolean> = { mobile: false, tablet: false, desktop: false };

let seq = 0;
export const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export function newSection(type: SectionType): Section {
  const d = sectionDef(type)!;
  return { id: newId(), type, props: JSON.parse(JSON.stringify(d.defaults)), span: { ...FULL }, hidden: { ...SHOWN }, style: { ...DEFAULT_STYLE } };
}
export function defaultLayout(title = 'Sabaidee'): LayoutConfig {
  const mk = (id: string, type: SectionType): Section => ({ ...newSection(type), id });
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: { ...DEFAULT_THEME },
    brand: { title, logoUrl: '', tagline: '', headerStyle: 'classic', showIcons: false },
    nav: [
      { key: 'home', label: 'Home', visible: true }, { key: 'shop', label: 'Shop', visible: true }, { key: 'rewards', label: 'Rewards', visible: true },
      { key: 'pay', label: 'Pay', visible: true }, { key: 'events', label: 'Events', visible: true }, { key: 'profile', label: 'โปรไฟล์', visible: true },
    ],
    home: [mk('member-card', 'memberCard'), mk('outstanding', 'outstandingNotice'), mk('coupons', 'myCoupons'), mk('offers', 'offers')],
    onboarding: { enabled: false, slides: [{ title: 'Welcome!', text: 'Collect points every time you order.', imageUrl: '' }] },
  };
}

// ---------------------------------------------------------------- validation
export interface Issue { path: string; message: string }
const HEX = /^#[0-9a-fA-F]{6}$/;
// Tested against JSON.stringify(config), where a quote appears as \" — hence the optional backslash.
const MARKUP = /(<\s*script|javascript:|\bon[a-z]+\s*=\s*\\?["']|<\s*iframe)/i;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Image URLs must be https (our storage bucket or any https host). data:/javascript:/http: are rejected. */
export const isSafeImageUrl = (u: string) => u === '' || /^https:\/\/[^\s"'<>]+$/i.test(u);

export function validateLayout(c: unknown): Issue[] {
  const out: Issue[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  if (!isObj(c)) return [{ path: '', message: 'Layout must be an object' }];
  if (c.schemaVersion !== SCHEMA_VERSION) bad('schemaVersion', 'Unsupported schema version');
  if (MARKUP.test(JSON.stringify(c))) bad('', 'HTML or script is not allowed anywhere in a layout');
  if (JSON.stringify(c).length > 150_000) bad('', 'Layout is too large');

  const th = c.theme;
  if (!isObj(th)) bad('theme', 'Theme is missing');
  else {
    for (const k of ['primary', 'primaryText', 'background', 'surface', 'text', 'muted', 'headerBg', 'headerText', 'navActive', 'cardFrom', 'cardTo'] as const)
      if (typeof th[k] !== 'string' || !HEX.test(th[k] as string)) bad(`theme.${k}`, 'Must be a colour like #1a2b3c');
    if (!FONTS.some((f) => f.v === th.font)) bad('theme.font', 'Unknown font');
    const num = (k: string, lo: number, hi: number) => { const v = th[k]; if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) bad(`theme.${k}`, `Must be a number from ${lo} to ${hi}`); };
    num('baseSize', 11, 22); num('radius', 0, 32); num('gap', 0, 40); num('padding', 0, 40);
    if (!['classic', 'floating'].includes(th.navStyle as string)) bad('theme.navStyle', 'Unknown menu style');
  }
  const br = c.brand;
  if (!isObj(br)) bad('brand', 'Branding is missing');
  else {
    if (typeof br.title !== 'string' || !br.title.trim() || br.title.length > 40) bad('brand.title', 'App title is required (max 40 characters)');
    if (typeof br.tagline !== 'string' || br.tagline.length > 80) bad('brand.tagline', 'Max 80 characters');
    if (typeof br.logoUrl !== 'string' || !isSafeImageUrl(br.logoUrl)) bad('brand.logoUrl', 'Logo must be an https image link');
    if (!['classic', 'centered'].includes(br.headerStyle as string)) bad('brand.headerStyle', 'Unknown header style');
    if (typeof br.showIcons !== 'boolean') bad('brand.showIcons', 'Must be true or false');
  }
  const ob = c.onboarding;
  if (!isObj(ob) || typeof ob.enabled !== 'boolean' || !Array.isArray(ob.slides)) bad('onboarding', 'Intro pop-up settings are missing');
  else {
    if (ob.slides.length > 8) bad('onboarding.slides', 'Max 8 slides');
    if (ob.enabled && !ob.slides.length) bad('onboarding.slides', 'Add at least one slide or turn the pop-up off');
    ob.slides.forEach((s, i) => {
      if (!isObj(s)) return bad(`onboarding.slides.${i}`, 'Slide must be an object');
      if (typeof s.title !== 'string' || s.title.length > 60) bad(`onboarding.slides.${i}.title`, 'Title: max 60 characters');
      if (typeof s.text !== 'string' || s.text.length > 300) bad(`onboarding.slides.${i}.text`, 'Text: max 300 characters');
      if (typeof s.imageUrl !== 'string' || !isSafeImageUrl(s.imageUrl)) bad(`onboarding.slides.${i}.imageUrl`, 'Image must be an https link');
    });
  }
  if (!Array.isArray(c.nav) || !c.nav.length) bad('nav', 'Navigation is missing');
  else {
    const seen = new Set<string>();
    c.nav.forEach((t, i) => {
      if (!isObj(t) || !TAB_KEYS.includes(t.key as TabKey) || seen.has(t.key as string)) return bad(`nav.${i}`, 'Unknown or duplicated tab');
      seen.add(t.key as string);
      if (typeof t.label !== 'string' || !t.label.trim() || t.label.length > 20) bad(`nav.${i}.label`, 'Tab label is required (max 20 characters)');
      if (typeof t.visible !== 'boolean') bad(`nav.${i}.visible`, 'Must be true or false');
    });
    const home = c.nav.find((t) => isObj(t) && t.key === 'home') as NavTab | undefined;
    if (!home || !home.visible) bad('nav', 'The Home tab must stay visible');
    // LINE members edit their name / phone / consent on the profile tab, so it can be renamed or moved but not hidden
    const prof = c.nav.find((t) => isObj(t) && t.key === 'profile') as NavTab | undefined;
    if (prof && !prof.visible) bad('nav', 'The profile tab must stay visible (members edit their details there)');
  }
  if (!Array.isArray(c.home)) bad('home', 'Home sections are missing');
  else {
    if (c.home.length > 60) bad('home', 'Too many sections (max 60)');
    const ids = new Set<string>();
    c.home.forEach((s, i) => {
      const p = `home.${i}`;
      if (!isObj(s)) return bad(p, 'Section must be an object');
      const def = sectionDef(s.type as string);
      if (!def) return bad(`${p}.type`, `Unknown component "${String(s.type)}"`);
      if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) bad(`${p}.id`, 'Section id must be unique');
      ids.add(s.id as string);
      const props = isObj(s.props) ? s.props : {};
      if (!isObj(s.props)) bad(`${p}.props`, 'Properties are missing');
      for (const f of def.fields) {
        const v = props[f.key];
        const fp = `${p}.props.${f.key}`;
        if (f.kind === 'number') { if (typeof v !== 'number' || !isFinite(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max)) bad(fp, `${f.label}: ${f.min}–${f.max}`); }
        else if (f.kind === 'boolean') { if (typeof v !== 'boolean') bad(fp, `${f.label}: must be on or off`); }
        else if (f.kind === 'image') { if (typeof v !== 'string' || !isSafeImageUrl(v)) bad(fp, `${f.label}: must be an https image link`); }
        else if (f.kind === 'tab') { if (typeof v !== 'string' || (v !== '' && !TAB_KEYS.includes(v as TabKey))) bad(fp, `${f.label}: unknown tab`); }
        else if (f.kind === 'select') { if (!f.options?.some((o) => o.v === v)) bad(fp, `${f.label}: choose one of the options`); }
        else if (f.kind === 'items') {
          if (!Array.isArray(v) || v.length > (f.max_items ?? 10)) { bad(fp, `${f.label}: max ${f.max_items ?? 10} items`); continue; }
          v.forEach((it, j) => {
            if (!isObj(it)) return bad(`${fp}.${j}`, 'Item must be an object');
            for (const sf of f.item ?? []) {
              const x = it[sf.key]; const ip = `${fp}.${j}.${sf.key}`;
              if (typeof x !== 'string') bad(ip, `${sf.label}: required`);
              else if (sf.kind === 'image' && !isSafeImageUrl(x)) bad(ip, `${sf.label}: must be an https image link`);
              else if (sf.kind === 'tab' && x !== '' && !TAB_KEYS.includes(x as TabKey)) bad(ip, `${sf.label}: unknown tab`);
              else if (x.length > (sf.max_len ?? 500)) bad(ip, `${sf.label}: max ${sf.max_len ?? 500} characters`);
            }
          });
        }
        else if (typeof v !== 'string' || v.length > (f.max_len ?? 500)) bad(fp, `${f.label}: max ${f.max_len ?? 500} characters`);
      }
      const span = isObj(s.span) ? s.span : {};
      for (const d of DEVICES) { const v = span[d.v]; if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 12) bad(`${p}.span.${d.v}`, 'Width must be 1–12 columns'); }
      const hid = isObj(s.hidden) ? s.hidden : {};
      for (const d of DEVICES) if (typeof hid[d.v] !== 'boolean') bad(`${p}.hidden.${d.v}`, 'Must be true or false');
      const st = isObj(s.style) ? s.style : null;
      if (!st) bad(`${p}.style`, 'Style is missing');
      else {
        for (const [k, lo, hi] of [['padding', 0, 64], ['marginTop', 0, 120], ['radius', 0, 40]] as const) { const v = st[k]; if (typeof v !== 'number' || v < lo || v > hi) bad(`${p}.style.${k}`, `Must be ${lo}–${hi}`); }
        for (const k of ['background', 'textColor'] as const) if (typeof st[k] !== 'string' || (st[k] !== '' && !HEX.test(st[k] as string))) bad(`${p}.style.${k}`, 'Must be empty or a colour like #1a2b3c');
        if (!['left', 'center', 'right'].includes(st.align as string)) bad(`${p}.style.align`, 'Unknown alignment');
      }
    });
  }
  return out;
}

/** Fill in fields added by later code (backward compatible): a stored config keeps working when new options appear. */
export function normalizeLayout(c: LayoutConfig): LayoutConfig {
  const base = defaultLayout(c.brand?.title);
  // Home and profile can never be hidden (also repairs layouts stored before this rule existed)
  const nav = c.nav.map((t) => (ALWAYS_VISIBLE.includes(t.key) ? { ...t, visible: true } : t));
  for (const t of base.nav) if (!nav.some((x) => x.key === t.key)) nav.push({ ...t, visible: false });
  return {
    ...c,
    theme: { ...base.theme, ...c.theme },
    brand: { ...base.brand, ...c.brand },
    nav,
    onboarding: c.onboarding ? { ...base.onboarding, ...c.onboarding } : { ...base.onboarding },
    home: c.home.map((s) => ({ ...s, props: { ...(sectionDef(s.type)?.defaults ?? {}), ...s.props }, span: { ...FULL, ...s.span }, hidden: { ...SHOWN, ...s.hidden }, style: { ...DEFAULT_STYLE, ...s.style } })),
  };
}

/** Human-readable differences between two layouts (for "compare versions"). */
export function diffLayouts(a: LayoutConfig, b: LayoutConfig): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (isObj(x) && isObj(y)) { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path ? `${path}.${k}` : k); return; }
    out.push(`${path}: ${fmt(x)} → ${fmt(y)}`);
  };
  const fmt = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? `"${v.length > 40 ? v.slice(0, 40) + '…' : v}"` : JSON.stringify(v));
  walk(a.theme, b.theme, 'theme'); walk(a.brand, b.brand, 'brand'); walk(a.onboarding, b.onboarding, 'intro pop-up');
  const navA = a.nav.map((t) => `${t.key}${t.visible ? '' : '(hidden)'}:${t.label}`).join(', '), navB = b.nav.map((t) => `${t.key}${t.visible ? '' : '(hidden)'}:${t.label}`).join(', ');
  if (navA !== navB) out.push(`navigation: ${navA} → ${navB}`);
  const byIdA = new Map(a.home.map((s) => [s.id, s])), byIdB = new Map(b.home.map((s) => [s.id, s]));
  for (const s of b.home) if (!byIdA.has(s.id)) out.push(`home: added ${sectionDef(s.type)?.label ?? s.type}`);
  for (const s of a.home) if (!byIdB.has(s.id)) out.push(`home: removed ${sectionDef(s.type)?.label ?? s.type}`);
  if (a.home.filter((s) => byIdB.has(s.id)).map((s) => s.id).join() !== b.home.filter((s) => byIdA.has(s.id)).map((s) => s.id).join()) out.push('home: sections reordered');
  for (const s of b.home) { const o = byIdA.get(s.id); if (o) walk({ props: o.props, span: o.span, hidden: o.hidden, style: o.style }, { props: s.props, span: s.span, hidden: s.hidden, style: s.style }, `home[${sectionDef(s.type)?.label ?? s.type}]`); }
  return out;
}

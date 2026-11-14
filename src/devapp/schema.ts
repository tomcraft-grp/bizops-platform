// DEV APP Customer: the layout configuration of a customer-facing app, as structured JSON.
// The config never holds markup or code. The app renders it with the fixed component allow-list in
// SECTION_DEFS / CORE_DEFS, and validateLayout() (mirrored server-side by public.customer_app_validate) rejects anything else.
//
// Pages: `home` (kept at the top level for backward compatibility), one section list per app tab in `pages`, and
// staff-made `customPages`. Each tab page holds exactly one "core" block: the tab's built-in features (shop with cart,
// rewards redemption, payments, lucky-draw board, member profile). It can be moved and surrounded by other components
// but never removed, so business logic always stays intact. Layouts stored before pages existed have no `pages` /
// `customPages`; normalizeLayout() fills in the defaults, which render exactly like the original tabs.

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

/** App tabs other than Home: each has its own editable page around a fixed core block. */
export type PageTab = Exclude<TabKey, 'home'>;
export const PAGE_TABS: PageTab[] = ['shop', 'rewards', 'pay', 'events', 'profile'];
export type CoreType = 'shopCore' | 'rewardsCore' | 'payCore' | 'eventsCore' | 'profileCore';
export const CORE_OF: Record<PageTab, CoreType> = { shop: 'shopCore', rewards: 'rewardsCore', pay: 'payCore', events: 'eventsCore', profile: 'profileCore' };
export const isCoreType = (t: string): t is CoreType => (Object.values(CORE_OF) as string[]).includes(t);
/** A page of the app: 'home', a tab key, or a custom page ('page:<id>'). */
export type PageRef = TabKey | `page:${string}`;
export const PAGE_ID = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const MAX_CUSTOM_PAGES = 20;
export const MAX_SECTIONS_PER_PAGE = 60;
export interface CustomPage { id: string; title: string; sections: Section[] }

export const CUSTOMER_GROUPS = ['retail', 'wholesale', 'vip', 'staff'] as const;
export type CustomerGroup = (typeof CUSTOMER_GROUPS)[number];

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
/** Who sees a section. Empty `groups` = every member. */
export interface Visibility { groups: CustomerGroup[] }

// ---------------------------------------------------------------- data binding
// A component's data comes from a registered data source (src/devapp/datasources.ts for app data; the server-side
// allow-list public.customer_app_data_sources for database views). A binding names a source and columns; it never
// contains SQL. Database queries are built server-side from the allow-list with bound parameters.
export type ColType = 'text' | 'number' | 'money' | 'boolean' | 'date' | 'image' | 'emoji';
export type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_true' | 'is_false' | 'not_empty';
export const FILTER_OPS: { v: FilterOp; label: string; needsValue: boolean; types?: ColType[] }[] = [
  { v: 'eq', label: 'is', needsValue: true }, { v: 'neq', label: 'is not', needsValue: true },
  { v: 'contains', label: 'contains', needsValue: true },
  { v: 'gt', label: '>', needsValue: true, types: ['number', 'money', 'date'] }, { v: 'gte', label: '≥', needsValue: true, types: ['number', 'money', 'date'] },
  { v: 'lt', label: '<', needsValue: true, types: ['number', 'money', 'date'] }, { v: 'lte', label: '≤', needsValue: true, types: ['number', 'money', 'date'] },
  { v: 'is_true', label: 'is yes', needsValue: false, types: ['boolean'] }, { v: 'is_false', label: 'is no', needsValue: false, types: ['boolean'] },
  { v: 'not_empty', label: 'is not empty', needsValue: false },
];
export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export const AGG_FNS: { v: AggFn; label: string }[] = [
  { v: 'count', label: 'Count of records' }, { v: 'sum', label: 'Sum' }, { v: 'avg', label: 'Average' }, { v: 'min', label: 'Minimum' }, { v: 'max', label: 'Maximum' },
];
export type FieldFormat = 'auto' | 'text' | 'number' | 'money' | 'date' | 'badge';
export const FIELD_FORMATS: { v: FieldFormat; label: string }[] = [
  { v: 'auto', label: 'Auto' }, { v: 'text', label: 'Text' }, { v: 'number', label: 'Number' }, { v: 'money', label: 'Price (฿)' }, { v: 'date', label: 'Date' }, { v: 'badge', label: 'Badge' },
];
export interface BindingFilter { field: string; op: FilterOp; value: string }
export interface Binding {
  source: string; fields: string[]; filters: BindingFilter[]; sort: { field: string; dir: 'asc' | 'desc' } | null;
  limit: number; formats: Record<string, FieldFormat>;
  /** Aggregate instead of listing records (KPI cards and charts). */
  agg: { fn: AggFn; field: string; groupBy: string } | null;
}
export const SOURCE_ID = /^(local|db):[a-z0-9_]{2,40}$/;
export const COL_ID = /^[a-z_][a-z0-9_]{0,62}$/;
export const MAX_LIMIT = 50;
/** Filter values may reference the record the customer tapped to open a page, e.g. "{selected.sku}". */
export const SELECTED_TOKEN = /\{selected\.([a-z_][a-z0-9_]{0,62})\}/g;
export const emptyBinding = (source = 'local:products'): Binding => ({ source, fields: [], filters: [], sort: null, limit: 6, formats: {}, agg: null });
const bind = (source: string, fields: string[], o: Partial<Binding> = {}): Binding => ({ ...emptyBinding(source), fields, ...o });

export type PropItem = Record<string, string>;
export type PropValue = string | number | boolean | PropItem[] | Binding;
export interface Section {
  id: string; type: SectionType; props: Record<string, PropValue>; span: Span; hidden: Record<Device, boolean>; style: SectionStyle; visibility: Visibility;
}
export interface LayoutConfig {
  schemaVersion: typeof SCHEMA_VERSION; theme: Theme; brand: Brand; nav: NavTab[]; onboarding: Onboarding;
  home: Section[];
  pages: Record<PageTab, Section[]>;
  customPages: CustomPage[];
}

// ---------------------------------------------------------------- component allow-list
export type SectionType = 'memberCard' | 'outstandingNotice' | 'myCoupons' | 'offers'
  | 'categories' | 'couponStrip'
  | 'banner' | 'heading' | 'text' | 'image' | 'button' | 'card' | 'spacer' | 'divider'
  | 'announcement' | 'sectionHeader' | 'carousel'
  | 'dataCard' | 'productCard' | 'productImage' | 'dataTable' | 'dataList' | 'kpi' | 'chart' | 'search' | 'filter'
  | CoreType;
export type FieldKind = 'text' | 'textarea' | 'number' | 'color' | 'image' | 'tab' | 'select' | 'boolean' | 'items' | 'binding' | 'column';
export interface FieldDef {
  key: string; label: string; kind: FieldKind; options?: { v: string; label: string }[]; min?: number; max?: number; max_len?: number;
  /** kind 'items': the fields of each item (text / textarea / image / tab only) and the maximum number of items */
  item?: FieldDef[]; max_items?: number;
  /** kind 'binding': what the component needs from its data. records = rows; aggregate = one value (or one per group); field = one column */
  mode?: 'records' | 'aggregate' | 'field'; maxFields?: number; groupBy?: boolean;
  /** kind 'column': a column of the binding in prop `of`, optionally limited to some column types */
  of?: string; colTypes?: ColType[];
}
export type SectionGroup = 'Member data' | 'Content' | 'Data' | 'Layout' | 'Page core';
export interface SectionDef { type: SectionType; label: string; group: SectionGroup; desc: string; fields: FieldDef[]; defaults: Record<string, PropValue> }

const TAB_FIELD = (key: string, label: string): FieldDef => ({ key, label, kind: 'tab' });
const HIDE_EMPTY: FieldDef = { key: 'hideWhenEmpty', label: 'Hide when there is no data', kind: 'boolean' };
const col = (key: string, label: string, colTypes?: ColType[]): FieldDef => ({ key, label, kind: 'column', of: 'data', colTypes });
/** The component palette (what designers can add). Core blocks are separate (CORE_DEFS): they exist once per tab page. */
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
    { key: 'buttonLabel', label: 'Button label', kind: 'text', max_len: 20 }, TAB_FIELD('linkTab', 'Button opens page'), { key: 'limit', label: 'Max coupons', kind: 'number', min: 1, max: 10 }],
    defaults: { buttonLabel: 'Use', linkTab: 'shop', limit: 6 } },
  { type: 'banner', group: 'Content', label: 'Banner', desc: 'Wide image with optional headline and link', fields: [
    { key: 'imageUrl', label: 'Image', kind: 'image' }, { key: 'alt', label: 'Image description', kind: 'text', max_len: 120 },
    { key: 'headline', label: 'Headline', kind: 'text', max_len: 80 }, { key: 'height', label: 'Height (px)', kind: 'number', min: 60, max: 400 },
    TAB_FIELD('linkTab', 'Opens page when tapped')], defaults: { imageUrl: '', alt: '', headline: 'Welcome!', height: 140, linkTab: '' } },
  { type: 'announcement', group: 'Content', label: 'Announcement bar', desc: 'Scrolling message strip (one message per line)', fields: [
    { key: 'lines', label: 'Messages (one per line)', kind: 'textarea', max_len: 600 }, { key: 'speed', label: 'Speed (seconds per loop)', kind: 'number', min: 8, max: 120 },
    { key: 'scroll', label: 'Scroll continuously', kind: 'boolean' }], defaults: { lines: 'Welcome to our shop\nFree delivery on your first order', speed: 30, scroll: true } },
  { type: 'sectionHeader', group: 'Content', label: 'Section header', desc: 'Bold title with a “See all” link on the right', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 60 }, { key: 'linkLabel', label: 'Link text', kind: 'text', max_len: 30 }, TAB_FIELD('linkTab', 'Link opens page'),
    { key: 'size', label: 'Title size (px)', kind: 'number', min: 14, max: 36 }], defaults: { title: 'Bundle set', linkLabel: 'See all ›', linkTab: 'shop', size: 22 } },
  { type: 'carousel', group: 'Content', label: 'Card carousel', desc: 'Large image cards that scroll sideways (promotions, bundles, news)', fields: [
    { key: 'items', label: 'Cards', kind: 'items', max_items: 10, item: [
      { key: 'imageUrl', label: 'Image', kind: 'image' }, { key: 'badge', label: 'Small label', kind: 'text', max_len: 24 },
      { key: 'title', label: 'Title', kind: 'text', max_len: 60 }, { key: 'subtitle', label: 'Subtitle', kind: 'text', max_len: 80 }, TAB_FIELD('linkTab', 'Opens page')] },
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
  { type: 'button', group: 'Content', label: 'Button', desc: 'Opens one of the app pages', fields: [
    { key: 'label', label: 'Label', kind: 'text', max_len: 40 }, TAB_FIELD('linkTab', 'Opens page'),
    { key: 'variant', label: 'Style', kind: 'select', options: [{ v: 'primary', label: 'Filled' }, { v: 'outline', label: 'Outline' }] },
    { key: 'fullWidth', label: 'Full width', kind: 'boolean' }], defaults: { label: 'Order now', linkTab: 'shop', variant: 'primary', fullWidth: true } },
  { type: 'card', group: 'Content', label: 'Card', desc: 'Title and text in a card', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 80 }, { key: 'body', label: 'Text', kind: 'textarea', max_len: 1000 }], defaults: { title: 'Card title', body: 'Card text' } },

  // ---- data-bound components
  { type: 'dataCard', group: 'Data', label: 'Data card', desc: 'Card with fields from a data source, e.g. SKU, name, price, stock', fields: [
    { key: 'title', label: 'Card title', kind: 'text', max_len: 80 }, { key: 'description', label: 'Description', kind: 'textarea', max_len: 400 },
    { key: 'display', label: 'Card type', kind: 'select', options: [{ v: 'single', label: 'One record (field: value)' }, { v: 'list', label: 'One row per record' }, { v: 'tiles', label: 'One tile per record' }] },
    { key: 'data', label: 'Data', kind: 'binding', mode: 'records', maxFields: 12 },
    { key: 'showLabels', label: 'Show field names', kind: 'boolean' }, HIDE_EMPTY, TAB_FIELD('linkTab', 'Tapping a record opens page')],
    defaults: { title: 'Products', description: '', display: 'list', data: bind('local:products', ['sku', 'name', 'price', 'stock'], { limit: 5 }), showLabels: false, hideWhenEmpty: false, linkTab: '' } },
  { type: 'productCard', group: 'Data', label: 'Product cards', desc: 'Product tiles: image, name, price and badge from a data source', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 80 }, { key: 'data', label: 'Data', kind: 'binding', mode: 'records', maxFields: 6 },
    col('imageField', 'Image field', ['image', 'emoji']), col('titleField', 'Name field'), col('priceField', 'Price field', ['money', 'number']), col('subField', 'Subtitle field'), col('badgeField', 'Badge field'),
    { key: 'layout', label: 'Layout', kind: 'select', options: [{ v: 'grid', label: 'Grid (2 per row)' }, { v: 'scroll', label: 'Scroll sideways' }, { v: 'list', label: 'List' }] },
    HIDE_EMPTY, TAB_FIELD('linkTab', 'Tapping a product opens page')],
    defaults: { title: 'Recommended', data: bind('local:products', [], { limit: 6, sort: { field: 'name', dir: 'asc' } }), imageField: 'emoji', titleField: 'name', priceField: 'price', subField: 'category', badgeField: '', layout: 'grid', hideWhenEmpty: true, linkTab: '' } },
  { type: 'productImage', group: 'Data', label: 'Product image', desc: 'Large image of the first matching record (e.g. on a product details page)', fields: [
    { key: 'data', label: 'Data', kind: 'binding', mode: 'records', maxFields: 0 }, col('imageField', 'Image field', ['image', 'emoji']), col('captionField', 'Caption field'),
    { key: 'height', label: 'Height (px)', kind: 'number', min: 80, max: 480 },
    { key: 'fit', label: 'Fit', kind: 'select', options: [{ v: 'cover', label: 'Fill' }, { v: 'contain', label: 'Fit whole image' }] }, HIDE_EMPTY],
    defaults: { data: bind('local:products', [], { limit: 1 }), imageField: 'emoji', captionField: 'name', height: 200, fit: 'contain', hideWhenEmpty: true } },
  { type: 'dataTable', group: 'Data', label: 'Data table', desc: 'Records in rows and columns', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 80 }, { key: 'data', label: 'Data', kind: 'binding', mode: 'records', maxFields: 8 }, HIDE_EMPTY, TAB_FIELD('linkTab', 'Tapping a row opens page')],
    defaults: { title: 'Price list', data: bind('local:products', ['sku', 'name', 'price'], { limit: 10, sort: { field: 'name', dir: 'asc' } }), hideWhenEmpty: false, linkTab: '' } },
  { type: 'dataList', group: 'Data', label: 'List', desc: 'Simple list of records: main text, secondary text, value on the right', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 80 }, { key: 'data', label: 'Data', kind: 'binding', mode: 'records', maxFields: 0 },
    col('primaryField', 'Main text'), col('secondaryField', 'Secondary text'), col('rightField', 'Right side'), HIDE_EMPTY, TAB_FIELD('linkTab', 'Tapping a record opens page')],
    defaults: { title: 'Current offers', data: bind('local:promotions', [], { limit: 5 }), primaryField: 'name', secondaryField: 'description', rightField: '', hideWhenEmpty: true, linkTab: '' } },
  { type: 'kpi', group: 'Data', label: 'KPI card', desc: 'One calculated number: count, sum, average, min or max', fields: [
    { key: 'label', label: 'Label', kind: 'text', max_len: 60 }, { key: 'data', label: 'Data', kind: 'binding', mode: 'aggregate' },
    { key: 'format', label: 'Number format', kind: 'select', options: [{ v: 'number', label: 'Number' }, { v: 'money', label: 'Price (฿)' }] },
    { key: 'prefix', label: 'Text before', kind: 'text', max_len: 10 }, { key: 'suffix', label: 'Text after', kind: 'text', max_len: 20 }],
    defaults: { label: 'Products available', data: bind('local:products', [], { agg: { fn: 'count', field: '', groupBy: '' } }), format: 'number', prefix: '', suffix: '' } },
  { type: 'chart', group: 'Data', label: 'Chart', desc: 'Bar chart of a count or total per group', fields: [
    { key: 'title', label: 'Title', kind: 'text', max_len: 80 }, { key: 'data', label: 'Data', kind: 'binding', mode: 'aggregate', groupBy: true },
    { key: 'chartType', label: 'Chart type', kind: 'select', options: [{ v: 'bars', label: 'Horizontal bars' }, { v: 'columns', label: 'Columns' }] },
    { key: 'format', label: 'Number format', kind: 'select', options: [{ v: 'number', label: 'Number' }, { v: 'money', label: 'Price (฿)' }] }],
    defaults: { title: 'Products per category', data: bind('local:products', [], { limit: 8, agg: { fn: 'count', field: '', groupBy: 'category' } }), chartType: 'bars', format: 'number' } },
  { type: 'search', group: 'Data', label: 'Search', desc: 'Search box: narrows the data cards, product cards, tables and lists on this page', fields: [
    { key: 'placeholder', label: 'Placeholder', kind: 'text', max_len: 60 }], defaults: { placeholder: 'Search…' } },
  { type: 'filter', group: 'Data', label: 'Filter', desc: 'Chips of the values of one field; narrows the components on this page that use the same data', fields: [
    { key: 'label', label: 'Label', kind: 'text', max_len: 40 }, { key: 'data', label: 'Filter by', kind: 'binding', mode: 'field' }, { key: 'allLabel', label: '“All” chip text', kind: 'text', max_len: 20 }],
    defaults: { label: '', data: bind('local:products', ['category'], { limit: 20 }), allLabel: 'All' } },

  { type: 'spacer', group: 'Layout', label: 'Spacer', desc: 'Empty space', fields: [{ key: 'height', label: 'Height (px)', kind: 'number', min: 4, max: 200 }], defaults: { height: 24 } },
  { type: 'divider', group: 'Layout', label: 'Divider', desc: 'Horizontal line', fields: [], defaults: {} },
];
/** The built-in features of each tab. Exactly one per tab page; movable, never removable. */
export const CORE_DEFS: SectionDef[] = [
  { type: 'shopCore', group: 'Page core', label: 'Shop: products & cart', desc: 'The LINE shop: product list, quantities, promotions and Place order', fields: [], defaults: {} },
  { type: 'rewardsCore', group: 'Page core', label: 'Rewards: redeem points', desc: 'Points balance, reward list with Redeem, and my redemptions', fields: [], defaults: {} },
  { type: 'payCore', group: 'Page core', label: 'Pay: statement & slip upload', desc: 'Balance, open invoices, PromptPay QR, slip upload and my orders', fields: [], defaults: {} },
  { type: 'eventsCore', group: 'Page core', label: 'Events: lucky-draw board', desc: 'Picks left, number board, reservation and my numbers', fields: [], defaults: {} },
  { type: 'profileCore', group: 'Page core', label: 'Profile: member details & feedback', desc: 'Name / phone / PDPA form and the feedback centre (LINE members only)', fields: [], defaults: {} },
];
const ALL_DEFS = [...SECTION_DEFS, ...CORE_DEFS];
export const sectionDef = (t: string) => ALL_DEFS.find((d) => d.type === t);

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
const EVERYONE = (): Visibility => ({ groups: [] });

let seq = 0;
export const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export function newSection(type: SectionType): Section {
  const d = sectionDef(type)!;
  return { id: newId(), type, props: JSON.parse(JSON.stringify(d.defaults)), span: { ...FULL }, hidden: { ...SHOWN }, style: { ...DEFAULT_STYLE }, visibility: EVERYONE() };
}
const coreSection = (tab: PageTab): Section => ({ ...newSection(CORE_OF[tab]), id: `core-${tab}` });
/** A tab page as it is without any customisation: just its core block (= the original tab). */
export const defaultPage = (tab: PageTab): Section[] => [coreSection(tab)];
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
    pages: Object.fromEntries(PAGE_TABS.map((t) => [t, defaultPage(t)])) as Record<PageTab, Section[]>,
    customPages: [],
    onboarding: { enabled: false, slides: [{ title: 'Welcome!', text: 'Collect points every time you order.', imageUrl: '' }] },
  };
}

// ---------------------------------------------------------------- pages
export const isTabRef = (r: string): r is TabKey => (TAB_KEYS as string[]).includes(r);
export const customId = (r: string) => (r.startsWith('page:') ? r.slice(5) : null);
/** The sections of a page (read-only use). Unknown pages give an empty list. */
export function pageSections(c: LayoutConfig, ref: PageRef | string): Section[] {
  if (ref === 'home') return c.home;
  if ((PAGE_TABS as string[]).includes(ref)) return c.pages?.[ref as PageTab] ?? defaultPage(ref as PageTab);
  const id = customId(ref);
  return (id && c.customPages?.find((p) => p.id === id)?.sections) || [];
}
/** The mutable section list of a page inside a (cloned) config, created if missing. */
export function pageSectionsMut(c: LayoutConfig, ref: PageRef | string): Section[] {
  if (ref === 'home') return c.home;
  if ((PAGE_TABS as string[]).includes(ref)) { c.pages ??= {} as LayoutConfig['pages']; return (c.pages[ref as PageTab] ??= defaultPage(ref as PageTab)); }
  const id = customId(ref);
  const p = id ? c.customPages?.find((x) => x.id === id) : undefined;
  if (!p) throw new Error('Page not found');
  return p.sections;
}
export interface PageInfo { ref: PageRef; label: string; kind: 'home' | 'tab' | 'custom'; inNav: boolean }
/** Every editable page: Home, the tabs (in menu order) and the custom pages. */
export function pageList(c: LayoutConfig): PageInfo[] {
  const tabs = c.nav.map((n) => ({ ref: n.key as PageRef, label: n.label, kind: (n.key === 'home' ? 'home' : 'tab') as PageInfo['kind'], inNav: n.visible }));
  for (const t of TAB_KEYS) if (!tabs.some((x) => x.ref === t)) tabs.push({ ref: t, label: t, kind: t === 'home' ? 'home' : 'tab', inNav: false });
  return [...tabs, ...(c.customPages ?? []).map((p) => ({ ref: `page:${p.id}` as PageRef, label: p.title, kind: 'custom' as const, inNav: false }))];
}
export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
/** Every place a link can point to: '' (none), a tab, or a custom page. */
export const isLinkTarget = (v: string, customIds: Set<string>) => v === '' || (TAB_KEYS as string[]).includes(v) || (v.startsWith('page:') && customIds.has(v.slice(5)));

// ---------------------------------------------------------------- validation
export interface Issue { path: string; message: string }
const HEX = /^#[0-9a-fA-F]{6}$/;
// Tested against JSON.stringify(config), where a quote appears as \" — hence the optional backslash.
const MARKUP = /(<\s*script|javascript:|\bon[a-z]+\s*=\s*\\?["']|<\s*iframe)/i;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Image URLs must be https (our storage bucket or any https host). data:/javascript:/http: are rejected. */
export const isSafeImageUrl = (u: string) => u === '' || /^https:\/\/[^\s"'<>]+$/i.test(u);
const FORMAT_KEYS = FIELD_FORMATS.map((f) => f.v) as string[];

/** Structural check of a data binding (the server re-checks sources and columns against its allow-list). */
export function validateBinding(b: unknown, f: FieldDef, p: string, bad: (path: string, message: string) => void) {
  if (!isObj(b)) return bad(p, `${f.label}: choose a data source`);
  if (typeof b.source !== 'string' || !SOURCE_ID.test(b.source)) bad(`${p}.source`, 'Unknown data source');
  const fields = b.fields;
  if (!Array.isArray(fields) || fields.length > 16 || fields.some((x) => typeof x !== 'string' || !COL_ID.test(x))) bad(`${p}.fields`, 'Fields must be column names (max 16)');
  else if (f.maxFields != null && f.mode === 'records' && fields.length > Math.max(f.maxFields, 0)) bad(`${p}.fields`, `Max ${f.maxFields} fields`);
  if (f.mode === 'field' && (!Array.isArray(fields) || fields.length !== 1)) bad(`${p}.fields`, 'Choose the field to filter by');
  if (!Array.isArray(b.filters) || b.filters.length > 8) bad(`${p}.filters`, 'Max 8 filters');
  else b.filters.forEach((x, i) => {
    if (!isObj(x) || typeof x.field !== 'string' || !COL_ID.test(x.field)) return bad(`${p}.filters.${i}`, 'Filter: choose a field');
    if (!FILTER_OPS.some((o) => o.v === x.op)) bad(`${p}.filters.${i}.op`, 'Filter: unknown condition');
    if (typeof x.value !== 'string' || x.value.length > 200) bad(`${p}.filters.${i}.value`, 'Filter value: max 200 characters');
  });
  if (b.sort !== null && (!isObj(b.sort) || typeof b.sort.field !== 'string' || !COL_ID.test(b.sort.field) || !['asc', 'desc'].includes(b.sort.dir as string))) bad(`${p}.sort`, 'Sorting: choose a field and a direction');
  if (typeof b.limit !== 'number' || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > MAX_LIMIT) bad(`${p}.limit`, `Number of records: 1–${MAX_LIMIT}`);
  if (!isObj(b.formats) || Object.entries(b.formats).some(([k, v]) => !COL_ID.test(k) || !FORMAT_KEYS.includes(v as string))) bad(`${p}.formats`, 'Unknown display format');
  if (b.agg !== null) {
    const a = b.agg;
    if (!isObj(a) || !AGG_FNS.some((x) => x.v === a.fn) || typeof a.field !== 'string' || typeof a.groupBy !== 'string'
      || (a.field !== '' && !COL_ID.test(a.field)) || (a.groupBy !== '' && !COL_ID.test(a.groupBy))) bad(`${p}.agg`, 'Calculation: choose a function and fields');
    else if (a.fn !== 'count' && !a.field) bad(`${p}.agg.field`, 'Calculation: choose the field to calculate');
    else if (f.groupBy && !a.groupBy) bad(`${p}.agg.groupBy`, 'Chart: choose the field to group by');
  } else if (f.mode === 'aggregate') bad(`${p}.agg`, 'Choose what to calculate');
}

function validateSections(list: unknown, p: string, page: PageRef, ids: Set<string>, customIds: Set<string>, bad: (path: string, message: string) => void) {
  if (!Array.isArray(list)) return bad(p, 'Sections are missing');
  if (list.length > MAX_SECTIONS_PER_PAGE) bad(p, `Too many sections (max ${MAX_SECTIONS_PER_PAGE})`);
  const coreHere = (PAGE_TABS as string[]).includes(page) ? CORE_OF[page as PageTab] : null;
  let cores = 0;
  list.forEach((s, i) => {
    const sp = `${p}.${i}`;
    if (!isObj(s)) return bad(sp, 'Section must be an object');
    const def = sectionDef(s.type as string);
    if (!def) return bad(`${sp}.type`, `Unknown component "${String(s.type)}"`);
    if (isCoreType(def.type)) {
      if (def.type !== coreHere) bad(`${sp}.type`, `${def.label} can only be on its own tab`);
      else cores++;
    }
    if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) bad(`${sp}.id`, 'Section id must be unique');
    ids.add(s.id as string);
    const props = isObj(s.props) ? s.props : {};
    if (!isObj(s.props)) bad(`${sp}.props`, 'Properties are missing');
    for (const f of def.fields) {
      const v = props[f.key];
      const fp = `${sp}.props.${f.key}`;
      if (f.kind === 'number') { if (typeof v !== 'number' || !isFinite(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max)) bad(fp, `${f.label}: ${f.min}–${f.max}`); }
      else if (f.kind === 'boolean') { if (typeof v !== 'boolean') bad(fp, `${f.label}: must be on or off`); }
      else if (f.kind === 'image') { if (typeof v !== 'string' || !isSafeImageUrl(v)) bad(fp, `${f.label}: must be an https image link`); }
      else if (f.kind === 'tab') { if (typeof v !== 'string' || !isLinkTarget(v, customIds)) bad(fp, `${f.label}: unknown page`); }
      else if (f.kind === 'select') { if (!f.options?.some((o) => o.v === v)) bad(fp, `${f.label}: choose one of the options`); }
      else if (f.kind === 'binding') validateBinding(v, f, fp, bad);
      else if (f.kind === 'column') { if (typeof v !== 'string' || (v !== '' && !COL_ID.test(v))) bad(fp, `${f.label}: unknown field`); }
      else if (f.kind === 'items') {
        if (!Array.isArray(v) || v.length > (f.max_items ?? 10)) { bad(fp, `${f.label}: max ${f.max_items ?? 10} items`); continue; }
        v.forEach((it, j) => {
          if (!isObj(it)) return bad(`${fp}.${j}`, 'Item must be an object');
          for (const sf of f.item ?? []) {
            const x = it[sf.key]; const ip = `${fp}.${j}.${sf.key}`;
            if (typeof x !== 'string') bad(ip, `${sf.label}: required`);
            else if (sf.kind === 'image' && !isSafeImageUrl(x)) bad(ip, `${sf.label}: must be an https image link`);
            else if (sf.kind === 'tab' && !isLinkTarget(x, customIds)) bad(ip, `${sf.label}: unknown page`);
            else if (x.length > (sf.max_len ?? 500)) bad(ip, `${sf.label}: max ${sf.max_len ?? 500} characters`);
          }
        });
      }
      else if (typeof v !== 'string' || v.length > (f.max_len ?? 500)) bad(fp, `${f.label}: max ${f.max_len ?? 500} characters`);
    }
    const span = isObj(s.span) ? s.span : {};
    for (const d of DEVICES) { const v = span[d.v]; if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 12) bad(`${sp}.span.${d.v}`, 'Width must be 1–12 columns'); }
    const hid = isObj(s.hidden) ? s.hidden : {};
    for (const d of DEVICES) if (typeof hid[d.v] !== 'boolean') bad(`${sp}.hidden.${d.v}`, 'Must be true or false');
    const st = isObj(s.style) ? s.style : null;
    if (!st) bad(`${sp}.style`, 'Style is missing');
    else {
      for (const [k, lo, hi] of [['padding', 0, 64], ['marginTop', 0, 120], ['radius', 0, 40]] as const) { const v = st[k]; if (typeof v !== 'number' || v < lo || v > hi) bad(`${sp}.style.${k}`, `Must be ${lo}–${hi}`); }
      for (const k of ['background', 'textColor'] as const) if (typeof st[k] !== 'string' || (st[k] !== '' && !HEX.test(st[k] as string))) bad(`${sp}.style.${k}`, 'Must be empty or a colour like #1a2b3c');
      if (!['left', 'center', 'right'].includes(st.align as string)) bad(`${sp}.style.align`, 'Unknown alignment');
    }
    // visibility is optional in layouts stored before it existed
    if (s.visibility !== undefined) {
      const g = isObj(s.visibility) ? s.visibility.groups : null;
      if (!Array.isArray(g) || g.some((x) => !(CUSTOMER_GROUPS as readonly string[]).includes(x as string))) bad(`${sp}.visibility`, 'Unknown customer group');
    }
  });
  if (coreHere && cores !== 1) bad(p, `The ${sectionDef(coreHere)!.label} block must be on this page exactly once`);
}

export function validateLayout(c: unknown): Issue[] {
  const out: Issue[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  if (!isObj(c)) return [{ path: '', message: 'Layout must be an object' }];
  if (c.schemaVersion !== SCHEMA_VERSION) bad('schemaVersion', 'Unsupported schema version');
  if (MARKUP.test(JSON.stringify(c))) bad('', 'HTML or script is not allowed anywhere in a layout');
  if (JSON.stringify(c).length > 300_000) bad('', 'Layout is too large');

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

  // custom pages first: links anywhere may point to them
  const customIds = new Set<string>();
  const cps = c.customPages;
  if (cps !== undefined && (!Array.isArray(cps) || cps.length > MAX_CUSTOM_PAGES)) bad('customPages', `Max ${MAX_CUSTOM_PAGES} custom pages`);
  const cpList = Array.isArray(cps) ? cps : [];
  cpList.forEach((p, j) => {
    if (!isObj(p)) return bad(`customPages.${j}`, 'Page must be an object');
    if (typeof p.id !== 'string' || !PAGE_ID.test(p.id) || customIds.has(p.id)) bad(`customPages.${j}.id`, 'Page address must be unique: 2–31 lowercase letters, digits or -');
    else customIds.add(p.id);
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 40) bad(`customPages.${j}.title`, 'Page title is required (max 40 characters)');
  });

  const ids = new Set<string>();
  if (!Array.isArray(c.home)) bad('home', 'Home sections are missing');
  else validateSections(c.home, 'home', 'home', ids, customIds, bad);
  if (c.pages !== undefined) {
    if (!isObj(c.pages)) bad('pages', 'Pages must be an object');
    else for (const [k, list] of Object.entries(c.pages)) {
      if (!(PAGE_TABS as string[]).includes(k)) { bad(`pages.${k}`, `Unknown page "${k}"`); continue; }
      validateSections(list, `pages.${k}`, k as PageTab, ids, customIds, bad);
    }
  }
  cpList.forEach((p, j) => { if (isObj(p)) validateSections(p.sections, `customPages.${j}.sections`, `page:${String(p.id)}`, ids, customIds, bad); });
  return out;
}

/** Fill in fields added by later code (backward compatible): a stored config keeps working when new options appear. */
export function normalizeLayout(c: LayoutConfig): LayoutConfig {
  const base = defaultLayout(c.brand?.title);
  // Home and profile can never be hidden (also repairs layouts stored before this rule existed)
  const nav = c.nav.map((t) => (ALWAYS_VISIBLE.includes(t.key) ? { ...t, visible: true } : t));
  for (const t of base.nav) if (!nav.some((x) => x.key === t.key)) nav.push({ ...t, visible: false });
  const normSec = (s: Section): Section => {
    const def = sectionDef(s.type);
    const props: Record<string, PropValue> = { ...(def?.defaults ?? {}), ...s.props };
    // bindings stored by older code may lack newer keys
    for (const f of def?.fields ?? []) if (f.kind === 'binding' && props[f.key] && typeof props[f.key] === 'object') props[f.key] = { ...emptyBinding(), ...(props[f.key] as Binding) };
    return { ...s, props, span: { ...FULL, ...s.span }, hidden: { ...SHOWN, ...s.hidden }, style: { ...DEFAULT_STYLE, ...s.style }, visibility: { ...EVERYONE(), ...s.visibility } };
  };
  const pages = {} as Record<PageTab, Section[]>;
  for (const t of PAGE_TABS) {
    const list = (c.pages?.[t] ?? defaultPage(t)).map(normSec);
    // the core block holds the tab's business features: it must always be there, once
    const core = CORE_OF[t];
    const firstCore = list.findIndex((s) => s.type === core);
    pages[t] = firstCore < 0 ? [...list, coreSection(t)] : list.filter((s, i) => s.type !== core || i === firstCore);
  }
  return {
    ...c,
    theme: { ...base.theme, ...c.theme },
    brand: { ...base.brand, ...c.brand },
    nav,
    onboarding: c.onboarding ? { ...base.onboarding, ...c.onboarding } : { ...base.onboarding },
    home: c.home.map(normSec),
    pages,
    customPages: (c.customPages ?? []).map((p) => ({ ...p, sections: (p.sections ?? []).map(normSec) })),
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
  const label = (s: Section) => sectionDef(s.type)?.label ?? s.type;
  const diffList = (la: Section[], lb: Section[], name: string) => {
    const byIdA = new Map(la.map((s) => [s.id, s])), byIdB = new Map(lb.map((s) => [s.id, s]));
    for (const s of lb) if (!byIdA.has(s.id)) out.push(`${name}: added ${label(s)}`);
    for (const s of la) if (!byIdB.has(s.id)) out.push(`${name}: removed ${label(s)}`);
    if (la.filter((s) => byIdB.has(s.id)).map((s) => s.id).join() !== lb.filter((s) => byIdA.has(s.id)).map((s) => s.id).join()) out.push(`${name}: sections reordered`);
    for (const s of lb) { const o = byIdA.get(s.id); if (o) walk({ props: o.props, span: o.span, hidden: o.hidden, style: o.style, visibility: o.visibility }, { props: s.props, span: s.span, hidden: s.hidden, style: s.style, visibility: s.visibility }, `${name}[${label(s)}]`); }
  };
  diffList(a.home, b.home, 'home');
  for (const t of PAGE_TABS) diffList(pageSections(a, t), pageSections(b, t), t);
  const cpA = new Map((a.customPages ?? []).map((p) => [p.id, p])), cpB = new Map((b.customPages ?? []).map((p) => [p.id, p]));
  for (const [id, p] of cpB) { const o = cpA.get(id); if (!o) out.push(`page "${p.title}": added`); else { if (o.title !== p.title) out.push(`page "${id}": title "${o.title}" → "${p.title}"`); diffList(o.sections, p.sections, `page "${p.title}"`); } }
  for (const [id, p] of cpA) if (!cpB.has(id)) out.push(`page "${p.title}": removed`);
  return out;
}

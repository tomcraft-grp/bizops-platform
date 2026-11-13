import { describe, expect, it } from 'vitest';
import { defaultLayout, diffLayouts, LayoutConfig, newSection, normalizeLayout, SECTION_DEFS, validateLayout, isSafeImageUrl } from '../../src/devapp/schema';
import { canDo } from '../../src/devapp/api';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const paths = (c: unknown) => validateLayout(c).map((i) => i.path);

describe('DEV APP Customer: layout schema', () => {
  it('the built-in layout is valid and reproduces the current Home tab order', () => {
    const c = defaultLayout('Sabaidee');
    expect(validateLayout(c)).toEqual([]);
    expect(c.home.map((s) => s.type)).toEqual(['memberCard', 'outstandingNotice', 'myCoupons', 'offers']);
    expect(c.nav.map((n) => n.key)).toEqual(['home', 'shop', 'rewards', 'pay', 'events', 'profile']);
  });

  it('every component in the palette produces a valid section with its defaults', () => {
    const c = defaultLayout();
    c.home = SECTION_DEFS.map((d) => newSection(d.type));
    expect(validateLayout(c)).toEqual([]);
  });

  it('rejects markup and script anywhere in the config', () => {
    for (const evil of ['<script>alert(1)</script>', 'javascript:alert(1)', '<img src=x onerror="x()">', '<iframe src=//x>']) {
      const c = defaultLayout(); const s = newSection('text'); s.props.text = evil; c.home.push(s);
      expect(validateLayout(c).some((i) => /HTML or script/.test(i.message))).toBe(true);
    }
    // ordinary text that merely contains "on" + "=" is fine
    const ok = defaultLayout(); const t = newSection('text'); t.props.text = 'Bonus=2x points on Tuesday'; ok.home.push(t);
    expect(validateLayout(ok)).toEqual([]);
  });

  it('allows only https images', () => {
    expect(isSafeImageUrl('https://x.supabase.co/storage/v1/object/public/customer-app-assets/a.png')).toBe(true);
    expect(isSafeImageUrl('')).toBe(true);
    for (const u of ['http://x/a.png', 'data:image/png;base64,AAA', 'javascript:alert(1)', 'https://x/a.png" onerror="x']) expect(isSafeImageUrl(u)).toBe(false);
    const c = defaultLayout(); const b = newSection('banner'); b.props.imageUrl = 'data:image/svg+xml,<svg/>'; c.home.push(b);
    expect(paths(c)).toContain(`home.${c.home.length - 1}.props.imageUrl`);
  });

  it('rejects unknown components, bad colours, out-of-range numbers and duplicate ids', () => {
    const c = clone(defaultLayout()) as unknown as Record<string, any>;
    c.home.push({ ...newSection('heading'), type: 'customHtml' });
    c.theme.primary = 'red';
    c.theme.radius = 99;
    c.home[1].id = c.home[0].id;
    c.home[0].span.mobile = 13;
    const p = paths(c);
    expect(p).toEqual(expect.arrayContaining(['home.4.type', 'theme.primary', 'theme.radius', 'home.1.id', 'home.0.span.mobile']));
  });

  it('the Home tab cannot be hidden and tab keys must be known and unique', () => {
    const c = defaultLayout(); c.nav[0].visible = false;
    expect(validateLayout(c).some((i) => i.message.includes('Home tab'))).toBe(true);
    const d = clone(defaultLayout()) as unknown as Record<string, any>; d.nav.push({ key: 'admin', label: 'x', visible: true }); d.nav.push({ ...d.nav[1] });
    expect(paths(d)).toEqual(expect.arrayContaining(['nav.6', 'nav.7']));
  });

  it('normalize fills fields added later so older stored layouts keep working', () => {
    const old = clone(defaultLayout()) as unknown as Record<string, any>;
    delete old.theme.gap; old.nav = old.nav.filter((n: { key: string }) => n.key !== 'events'); delete old.home[3].props.limit; delete old.home[0].style;
    const n = normalizeLayout(old as LayoutConfig);
    expect(validateLayout(n)).toEqual([]);
    expect(n.nav.find((x) => x.key === 'events')?.visible).toBe(false); // added hidden, not silently shown
  });

  it('diff describes theme, navigation and section changes', () => {
    const a = defaultLayout(); const b = clone(a);
    b.theme.primary = '#ff0000'; b.nav[1].label = 'Menu'; b.home.reverse(); b.home.push(newSection('banner')); b.home = b.home.filter((s) => s.type !== 'offers');
    const d = diffLayouts(a, b).join('\n');
    expect(d).toMatch(/theme\.primary: "#2068c4" → "#ff0000"/);
    expect(d).toMatch(/navigation:.*shop:Shop.*→.*shop:Menu/);
    expect(d).toMatch(/added Banner/); expect(d).toMatch(/removed Offers for you/); expect(d).toMatch(/reordered/);
    expect(diffLayouts(a, clone(a))).toEqual([]);
  });

  it('UI capability check mirrors the database role ladder', () => {
    expect(canDo(null, 'view')).toBe(false);
    expect(canDo('viewer', 'view')).toBe(true); expect(canDo('viewer', 'edit')).toBe(false);
    expect(canDo('designer', 'edit')).toBe(true); expect(canDo('designer', 'approve')).toBe(false);
    expect(canDo('approver', 'approve')).toBe(true); expect(canDo('approver', 'deploy')).toBe(false);
    expect(canDo('publisher', 'deploy')).toBe(true); expect(canDo('publisher', 'admin')).toBe(false);
    expect(canDo('admin', 'admin')).toBe(true);
  });
});

describe('DEV APP Customer: reference-style components', () => {
  it('every theme preset produces a valid layout', async () => {
    const { THEME_PRESETS } = await import('../../src/devapp/schema');
    for (const p of THEME_PRESETS) {
      const c = defaultLayout(); c.theme = { ...c.theme, ...p.theme }; c.brand = { ...c.brand, ...p.brand };
      expect(validateLayout(c)).toEqual([]);
    }
  });
  it('carousel items are validated (https images, known tabs, max count)', () => {
    const c = defaultLayout(); const s = newSection('carousel'); c.home.push(s);
    expect(validateLayout(c)).toEqual([]);
    (s.props.items as Record<string, string>[])[0].imageUrl = 'http://x/a.png';
    (s.props.items as Record<string, string>[])[1].linkTab = 'admin';
    const p = paths(c);
    expect(p).toEqual(expect.arrayContaining([`home.4.props.items.0.imageUrl`, `home.4.props.items.1.linkTab`]));
    s.props.items = Array.from({ length: 11 }, () => ({ imageUrl: '', badge: '', title: '', subtitle: '', linkTab: '' }));
    expect(paths(c)).toContain('home.4.props.items');
  });
  it('the intro pop-up needs a slide when enabled and is optional in older layouts', () => {
    const c = defaultLayout(); c.onboarding = { enabled: true, slides: [] };
    expect(paths(c)).toContain('onboarding.slides');
    const old = clone(defaultLayout()) as unknown as Record<string, unknown>; delete old.onboarding;
    expect(validateLayout(normalizeLayout(old as unknown as LayoutConfig))).toEqual([]);
  });
});

describe('DEV APP Customer: protected tabs', () => {
  it('the profile tab cannot be hidden (LINE members edit their details there)', () => {
    const c = defaultLayout(); c.nav.find((n) => n.key === 'profile')!.visible = false;
    expect(validateLayout(c).some((i) => i.message.includes('profile tab'))).toBe(true);
  });
  it('normalize repairs stored layouts that hid home or profile', () => {
    const c = defaultLayout(); c.nav.forEach((n) => { if (n.key === 'profile') n.visible = false; });
    const n = normalizeLayout(c);
    expect(n.nav.find((x) => x.key === 'profile')!.visible).toBe(true);
    expect(validateLayout(n)).toEqual([]);
  });
});

// Plain English translation on the staff computer: identifier protection, line handling and the browser glue, all with a FAKE translator.
// This proves the logic around the translator, not the quality of Chrome's real Thai -> English model (it could not be downloaded in the test browser).
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatTranslation, googleTranslateUrl, hasThai, protectedTokens, translateInBrowser, translateIssueText, translateText, translatorState,
} from '../../src/lib/feedbackTranslate';

const DICT: Record<string, string> = {
  'ที่หน้า สินค้า กดบันทึก': 'On the Products page, pressing Save',
  'แล้วขึ้น error': 'then shows an error',
  'ปุ่มบันทึกกดไม่ได้': 'The Save button cannot be pressed',
  'อยากให้ แสดงออเดอร์ทุกช่องทาง': 'Please show orders from every channel',
  'การแสดงผล': 'Display',
};
/** a well-behaved translator: translates known Thai phrases and leaves Latin text alone */
function good() {
  const calls: string[] = [];
  const fn = async (s: string) => { calls.push(s); return Object.entries(DICT).reduce((acc, [th, en]) => acc.split(th).join(en), s); };
  return { fn, calls };
}
/** a damaging translator: turns FG-000001 into "FG 000001", drops URLs and re-translates quoted text, as real engines sometimes do */
function damaging() {
  const calls: string[] = [];
  const fn = async (s: string) => { calls.push(s); return Object.entries(DICT).reduce((acc, [th, en]) => acc.split(th).join(en), s).replace(/FG-(\d+)/g, 'FG $1').replace(/https?:\/\/\S+/g, 'link'); };
  return { fn, calls };
}

describe('what is protected', () => {
  it('finds codes, routes, URLs, backticks and quoted messages', () => {
    const line = 'ที่หน้า /orders กดบันทึก SKU FG-000001 และ INV-202611-00268 ดู https://example.com/a?b=1 หรือ `npm run build` แล้วขึ้น "permission denied"';
    expect(protectedTokens(line)).toEqual(['/orders', 'FG-000001', 'INV-202611-00268', 'https://example.com/a?b=1', '`npm run build`', '"permission denied"']);
  });
  it('does not protect ordinary words, dates, "and/or" or Thai', () => {
    expect(protectedTokens('and/or เลือก 15/11/2026 Wi-Fi T-shirt และ/หรือ ไทย')).toEqual([]);
  });
  it('a quoted Thai message is protected as well (error texts stay word for word)', () => {
    expect(protectedTokens('ขึ้นว่า "ไม่มีสิทธิ์บันทึก" ตอนกดปุ่ม')).toEqual(['"ไม่มีสิทธิ์บันทึก"']);
    expect(protectedTokens('ขึ้นว่า “ไม่มีสิทธิ์”')).toEqual(['“ไม่มีสิทธิ์”']);
  });
  it('hasThai', () => { expect(hasThai('abc')).toBe(false); expect(hasThai('abc ก')).toBe(true); });
});

describe('translateText', () => {
  it('leaves English-only lines, numbers and quoted-only lines alone and never calls the translator for them', async () => {
    const t = good();
    const text = 'The Save button does nothing\n12345 !!!\n"permission denied for table sku_registry"\n\n/orders';
    expect(await translateText(text, t.fn)).toBe(text);
    expect(t.calls).toEqual([]);
  });
  it('translates a Thai line as a whole when every identifier survives', async () => {
    const t = good();
    expect(await translateText('ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error "permission denied"', t.fn))
      .toBe('On the Products page, pressing Save SKU FG-000001 then shows an error "permission denied"');
    expect(t.calls).toHaveLength(1);
  });
  it('when the translator damages an identifier, only the Thai runs are translated and every identifier stays exact', async () => {
    const t = damaging();
    const out = await translateText('ที่หน้า สินค้า กดบันทึก SKU FG-000001 แล้วขึ้น error https://example.com/x', t.fn);
    expect(out).toBe('On the Products page, pressing Save SKU FG-000001 then shows an error https://example.com/x');
    expect(out).toContain('FG-000001');
    expect(out).toContain('https://example.com/x');
    expect(t.calls.at(-1)).not.toMatch(/FG-|https/);              // the identifiers were never sent in the second round
  });
  it('keeps line breaks, blank lines and normalises CRLF', async () => {
    const t = good();
    expect(await translateText('ปุ่มบันทึกกดไม่ได้\r\n\r\nการแสดงผล\r\nplain line', t.fn)).toBe('The Save button cannot be pressed\n\nDisplay\nplain line');
  });
  it('never loses text: a translator that returns nothing leaves the original Thai in place', async () => {
    expect(await translateText('ปุ่มบันทึกกดไม่ได้', async () => '   ')).toBe('ปุ่มบันทึกกดไม่ได้');
    expect(await translateText('ที่หน้า สินค้า กดบันทึก FG-000001', async () => '')).toBe('ที่หน้า สินค้า กดบันทึก FG-000001');
  });
  it('a translator that throws stops the whole translation (nothing half-saved)', async () => {
    await expect(translateText('ปุ่มบันทึกกดไม่ได้', async () => { throw new Error('model gone'); })).rejects.toThrow('model gone');
  });
});

describe('the stored text', () => {
  it('is the title, a blank line, then the description: plain English, no sections', async () => {
    const t = good();
    const out = await translateIssueText({ title: 'ปุ่มบันทึกกดไม่ได้', description: 'อยากให้ แสดงออเดอร์ทุกช่องทาง\nที่ /orders' }, t.fn);
    expect(out).toBe('Title: The Save button cannot be pressed\n\nPlease show orders from every channel\nที่ /orders');
    expect(out.startsWith('Title: ')).toBe(true);
    expect(out).not.toMatch(/^## /m);
  });
  it('formatTranslation trims', () => { expect(formatTranslation('  A ', '\nB  ')).toBe('Title: A\n\nB'); });
  it('google translate link is encoded and capped', () => {
    const u = googleTranslateUrl('ไทย & "x"\nline', 6);
    expect(u.startsWith('https://translate.google.com/?sl=th&tl=en&op=translate&text=')).toBe(true);
    expect(decodeURIComponent(u.split('text=')[1])).toBe('ไทย & ');
    expect(googleTranslateUrl('x'.repeat(5000)).length).toBeLessThan(1700);
  });
});

describe('the browser translator', () => {
  const g = globalThis as unknown as { Translator?: unknown };
  afterEach(() => { delete g.Translator; });

  it('reports what this browser can do', async () => {
    expect(await translatorState()).toBe('unsupported');
    for (const a of ['available', 'downloadable', 'downloading'] as const) { g.Translator = { availability: async () => a }; expect(await translatorState()).toBe(a); }
    g.Translator = { availability: async () => 'unavailable' }; expect(await translatorState()).toBe('unavailable');
    g.Translator = { availability: async () => 'something-new' }; expect(await translatorState()).toBe('unavailable');
    g.Translator = { availability: async () => { throw new Error('x'); } }; expect(await translatorState()).toBe('unavailable');
  });
  it('translates Thai to English, reports the download progress, and releases the translator', async () => {
    let created: unknown = null, destroyed = false; const progress: number[] = [];
    g.Translator = {
      availability: async () => 'downloadable',
      create: async (o: { sourceLanguage: string; targetLanguage: string; monitor: (m: EventTarget) => void }) => {
        created = { s: o.sourceLanguage, t: o.targetLanguage };
        const m = new EventTarget(); o.monitor(m);
        const ev = new Event('downloadprogress') as Event & { loaded: number }; ev.loaded = 0.5; m.dispatchEvent(ev);
        return { translate: async (s: string) => `EN:${s}`, destroy: () => { destroyed = true; } };
      },
    };
    const out = await translateInBrowser({ title: 'การแสดงผล', description: 'ปุ่มบันทึกกดไม่ได้' }, (f) => progress.push(f));
    expect(created).toEqual({ s: 'th', t: 'en' });
    expect(out).toBe('Title: EN:การแสดงผล\n\nEN:ปุ่มบันทึกกดไม่ได้');
    expect(progress).toEqual([0.5]);
    expect(destroyed).toBe(true);
  });
  it('explains the two ways it can fail', async () => {
    await expect(translateInBrowser({ title: 'a', description: 'b' })).rejects.toThrow(/no built-in translator/);
    g.Translator = { create: async () => { throw Object.assign(new Error('needs gesture'), { name: 'NotAllowedError' }); } };
    await expect(translateInBrowser({ title: 'ก', description: 'ข' })).rejects.toThrow(/Click the button again/);
    g.Translator = { create: async () => { throw new Error('disk full'); } };
    await expect(translateInBrowser({ title: 'ก', description: 'ข' })).rejects.toThrow(/could not start: disk full/);
  });
  it('releases the translator even when a translation fails', async () => {
    let destroyed = false;
    g.Translator = { create: async () => ({ translate: async () => { throw new Error('boom'); }, destroy: () => { destroyed = true; } }) };
    await expect(translateInBrowser({ title: 'ก', description: 'ข' })).rejects.toThrow('boom');
    expect(destroyed).toBe(true);
  });
});

// Screenshot / clipboard helpers: pure logic only (the canvas resize is covered by the browser test tests/shop-e2e/feedback.spec.ts).
import { describe, expect, it } from 'vitest';
import { clipboardHasText, clipboardImages, extensionFor, fitWithin, isGenericName, pastedName, MAX_IMAGE_DIMENSION, prepareImage } from '../../src/lib/feedbackImages';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, checkAttachment } from '../../src/lib/feedbackApi';

const NOW = new Date(2026, 10, 15, 1, 5, 9);   // 2026-11-15 01:05:09 local time
const file = (name: string, type: string, bytes = 10) => new File([new Uint8Array(bytes)], name, { type });
const clip = (items: { kind: string; type: string; file?: File | null }[], text = '', files: File[] = []) => ({
  items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file ?? null })),
  files, getData: (f: string) => (f === 'text/plain' ? text : ''),
});

describe('fitWithin', () => {
  it('keeps small pictures as they are and never enlarges', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(MAX_IMAGE_DIMENSION, 100)).toEqual({ width: MAX_IMAGE_DIMENSION, height: 100 });
  });
  it('shrinks the longest side to the limit and keeps the proportions', () => {
    expect(fitWithin(5120, 2880)).toEqual({ width: 2560, height: 1440 });
    expect(fitWithin(1000, 4000, 2000)).toEqual({ width: 500, height: 2000 });
    expect(fitWithin(3000, 3000, 1500)).toEqual({ width: 1500, height: 1500 });
  });
  it('never returns a zero or invalid size', () => {
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(NaN, 5)).toEqual({ width: 1, height: 5 });
  });
});

describe('names of pasted screenshots', () => {
  it('uses a readable local timestamp and numbers several pictures from one paste', () => {
    expect(pastedName(0, 'image/png', NOW)).toBe('screenshot-20261115-010509-1.png');
    expect(pastedName(1, 'image/jpeg', NOW)).toBe('screenshot-20261115-010509-2.jpg');
    expect(pastedName(0, 'image/webp', NOW)).toBe('screenshot-20261115-010509-1.webp');
    expect(extensionFor('application/pdf')).toBe('pdf');
  });
  it('recognises the generic names browsers give to pasted pictures', () => {
    for (const n of ['image.png', 'Image.PNG', 'image (1).png', 'blob', '', 'screenshot.png', 'image.jpeg']) expect(isGenericName(n), n).toBe(true);
    for (const n of ['error-page.png', 'IMG_2043.jpg', 'สลิป.png', 'report.pdf']) expect(isGenericName(n), n).toBe(false);
  });
});

describe('clipboardImages (Ctrl+V)', () => {
  it('takes a screenshot from the clipboard and gives it a proper name', () => {
    const shot = file('image.png', 'image/png');
    const out = clipboardImages(clip([{ kind: 'file', type: 'image/png', file: shot }]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('screenshot-20261115-010509-1.png');
    expect(out[0].type).toBe('image/png');
    expect(out[0].size).toBe(shot.size);
  });
  it('takes several pictures, keeps a real file name, and ignores text and non-image files', () => {
    const out = clipboardImages(clip([
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', file: file('image.png', 'image/png') },
      { kind: 'file', type: 'image/jpeg', file: file('IMG_2043.jpg', 'image/jpeg') },
      { kind: 'file', type: 'application/pdf', file: file('x.pdf', 'application/pdf') },
      { kind: 'file', type: 'image/webp', file: null },
    ]), NOW);
    expect(out.map((f) => f.name)).toEqual(['screenshot-20261115-010509-1.png', 'IMG_2043.jpg']);
  });
  it('falls back to files when the browser does not expose items', () => {
    const out = clipboardImages({ files: [file('image.png', 'image/png'), file('a.txt', 'text/plain')] }, NOW);
    expect(out).toHaveLength(1);
  });
  it('returns nothing for an empty or text-only clipboard', () => {
    expect(clipboardImages(null)).toEqual([]);
    expect(clipboardImages(clip([{ kind: 'string', type: 'text/plain' }], 'hello'))).toEqual([]);
  });
  it('does not take over Ctrl+V when the clipboard also carries text (Word, Excel, web pages)', () => {
    expect(clipboardHasText(clip([], 'some copied cells'))).toBe(true);
    expect(clipboardHasText(clip([], '   '))).toBe(false);
    expect(clipboardHasText(clip([], ''))).toBe(false);
    expect(clipboardHasText(null)).toBe(false);
  });
});

describe('what can be attached', () => {
  it('accepts PNG, JPG, WebP and PDF up to 10 MB, nothing else', () => {
    expect(checkAttachment(file('a.png', 'image/png'))).toBeNull();
    expect(checkAttachment(file('a.jpg', 'image/jpeg'))).toBeNull();
    expect(checkAttachment(file('a.webp', 'image/webp'))).toBeNull();
    expect(checkAttachment(file('a.pdf', 'application/pdf'))).toBeNull();
    for (const t of ['image/gif', 'image/svg+xml', 'text/html', 'application/zip', 'application/x-msdownload']) expect(checkAttachment(file('a', t)), t).toMatch(/Only PNG, JPG, WebP/);
  });
  it('refuses empty and oversized files with a message that has a Thai translation', async () => {
    expect(checkAttachment(file('a.png', 'image/png', 0))).toBe('The file is empty');
    const big = { name: 'big.png', type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 } as File;
    expect(checkAttachment(big)).toBe('Each file must be 10 MB or smaller');
    const { TH_FEEDBACK } = await import('../../src/lib/i18n.feedback');
    for (const m of ['The file is empty', 'Each file must be 10 MB or smaller', 'Only PNG, JPG, WebP images or PDF files can be attached', 'You can attach up to {n} files']) expect(TH_FEEDBACK[m], m).toBeTruthy();
    expect(MAX_ATTACHMENTS).toBe(5);
  });
  it('prepareImage leaves non-images and anything it cannot decode untouched (no canvas in Node)', async () => {
    const pdf = file('a.pdf', 'application/pdf');
    expect(await prepareImage(pdf)).toBe(pdf);
    const png = file('a.png', 'image/png');
    expect(await prepareImage(png)).toBe(png);
  });
});

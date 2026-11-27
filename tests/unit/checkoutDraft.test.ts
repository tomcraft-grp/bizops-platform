// The checkout draft: what survives going back, to another tab and a reload; what never does (another customer's draft, odd stored data, a finished order).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDraft, useCheckoutDraft } from '../../src/shop/checkoutDraft';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  useCheckoutDraft.setState({ uid: null, text: {}, slip: null });
});
afterEach(() => vi.unstubAllGlobals());
const s = () => useCheckoutDraft.getState();

describe('parseDraft', () => {
  it('reads what was saved', () => {
    const d = { name: 'A', phone: '0812345678', address: 'x', note: 'n', fulfilment: 'pickup', method: { kind: 'bank', id: 'b1' }, slipWhen: '2026-11-23T10:00', slipRef: 'R' };
    expect(parseDraft(JSON.stringify(d))).toEqual(d);
  });
  it('drops anything odd', () => {
    for (const raw of [null, '', 'x{', '[]', 'null', '1', '"s"']) expect(parseDraft(raw)).toEqual({});
    expect(parseDraft(JSON.stringify({ name: 5, fulfilment: 'teleport', method: { kind: 'card' }, total: 1, amount: 2 }))).toEqual({});
    expect(parseDraft(JSON.stringify({ method: { kind: 'bank' } }))).toEqual({});
    expect(parseDraft(JSON.stringify({ method: { kind: 'qr', id: 'x' } }))).toEqual({ method: { kind: 'qr' } });
    expect(parseDraft(JSON.stringify({ note: 'x'.repeat(999) })).note).toHaveLength(300);
  });
});

describe('the draft store', () => {
  it('keeps an emptied field empty (not back to the default) and survives a reload', () => {
    s().hydrate('u1'); s().patch({ address: '', name: 'A' }); s().patch({ method: { kind: 'qr' } });
    useCheckoutDraft.setState({ uid: null, text: {}, slip: null });
    s().hydrate('u1');
    expect(s().text).toEqual({ address: '', name: 'A', method: { kind: 'qr' } });
  });
  it('never shows one customer the draft or the slip of another on a shared device', () => {
    s().hydrate('u1'); s().patch({ name: 'secret' }); s().setSlip({ file: new File(['x'], 's.png'), total: 10 });
    s().hydrate('u2'); expect(s().text).toEqual({}); expect(s().slip).toBeNull();
    s().hydrate(null); expect(s().text).toEqual({});
    s().hydrate('u1'); expect(s().text.name).toBe('secret'); expect(s().slip).toBeNull();
  });
  it('hydrating the same user again (a token refresh) keeps the slip', () => {
    s().hydrate('u1'); s().setSlip({ file: new File(['x'], 's.png'), total: 10 }); s().hydrate('u1'); expect(s().slip?.total).toBe(10);
  });
  it('is forgotten after the order', () => { s().hydrate('u1'); s().patch({ note: 'n' }); s().clear(); expect(s().text).toEqual({}); expect(store.size).toBe(0); });
  it('works without storage (private mode)', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } });
    s().hydrate('u9'); s().patch({ note: 'n' }); expect(s().text.note).toBe('n'); s().clear(); expect(s().text).toEqual({});
  });
});

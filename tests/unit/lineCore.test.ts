// The shared LINE module of the Edge Functions (supabase/functions/_shared): webhook signature, postback data, delivery classification, secret redaction and
// the Flex cards. No network: what is proven is the logic, not LINE's rendering (that is checked by hand on a phone at go-live).
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { classify, encodePostback, lineClient, parsePostback, redact, verifySignature, type Postback } from '../../supabase/functions/_shared/line';
import { followUpCard, orderCard, quickAskCard, reasonsCard, resultText, type CardData } from '../../supabase/functions/_shared/lineCards';

const SECRET = '0123456789abcdef0123456789abcdef';
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('base64');
const ORDER = '11111111-2222-4333-8444-555555555555';
const CARD = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const EV = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function card(over: Partial<CardData> = {}, items = 2): CardData {
  return {
    order_id: ORDER, order_no: 'ORD-20261122-0001', customer_name: 'Somchai', phone: '0812345678', created_at: '2026-11-22T07:05:00Z',
    item_count: items, items: Array.from({ length: Math.min(items, 3) }, (_, i) => ({ name: `สินค้า ${i + 1}`, qty: 1, price: 420, image: i === 0 ? 'https://img.example/p1.jpg' : null })),
    more_count: Math.max(items - 3, 0), total: 420 * items, fulfilment: 'pickup',
    payment: { method: 'transfer', bank: 'SCB', has_slip: true, transfer_at: '2026-11-22T07:02:00Z', evidence_id: EV },
    status: 'new', quick: { ok: true, why: null }, app_url: 'https://tomcraft-grp.github.io/bizops-platform/', ...over,
  };
}
const postbacks = (o: unknown) => [...JSON.stringify(o).matchAll(/"data":"([^"]+)"/g)].map((m) => parsePostback(m[1])!);
const uris = (o: unknown) => [...JSON.stringify(o).matchAll(/"uri":"([^"]+)"/g)].map((m) => m[1]);

describe('verifySignature', () => {
  const body = JSON.stringify({ destination: 'U1', events: [] });
  it('accepts the body signed with the channel secret', async () => { expect(await verifySignature(SECRET, body, sign(body))).toBe(true); });
  it('rejects a body changed by one character', async () => { expect(await verifySignature(SECRET, body.replace('U1', 'U2'), sign(body))).toBe(false); });
  it('rejects a missing signature header', async () => { expect(await verifySignature(SECRET, body, null)).toBe(false); });
  it('rejects a signature made with another secret', async () => {
    expect(await verifySignature(SECRET, body, createHmac('sha256', 'other-secret-other-secret-000000').update(body).digest('base64'))).toBe(false);
  });
});

describe('postback data', () => {
  it('round-trips every action', () => {
    for (const a of ['accept', 'quick_ask', 'quick_confirm', 'reject_ask'] as const) expect(parsePostback(encodePostback({ a, o: ORDER, c: CARD }))).toEqual({ a, o: ORDER, c: CARD });
    expect(parsePostback(encodePostback({ a: 'reject', o: ORDER, c: CARD, r: 2 }))).toEqual({ a: 'reject', o: ORDER, c: CARD, r: 2 });
  });
  it('fits in the 300 characters LINE allows', () => { expect(encodePostback({ a: 'quick_confirm', o: ORDER, c: CARD, r: 9 }).length).toBeLessThanOrEqual(300); });
  it('refuses an unknown action, a bad id or a bad reason number', () => {
    expect(parsePostback(`a=drop&o=${ORDER}&c=${CARD}`)).toBeNull();
    expect(parsePostback(`a=accept&o=not-a-uuid&c=${CARD}`)).toBeNull();
    expect(parsePostback(`a=reject&o=${ORDER}&c=${CARD}&r=1.5`)).toBeNull();
    expect(parsePostback('garbage')).toBeNull();
  });
});

describe('classify', () => {
  it('maps LINE answers to sent / retry / dead', () => {
    expect([200, 409, 429, 500, 503, 0, 400, 401, 403].map(classify)).toEqual(['sent', 'sent', 'retry', 'retry', 'retry', 'retry', 'dead', 'dead', 'dead']);
  });
});

describe('redact', () => {
  it('removes every secret from a text', () => { expect(redact('token abc123 failed (abc123)', ['abc123', undefined])).toBe('token *** failed (***)'); });
  it('leaves a text without secrets as it is', () => { expect(redact('HTTP 500', ['abc123'])).toBe('HTTP 500'); });
});

describe('lineClient', () => {
  it('pushes with the retry key and reads the request id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'req-1' } }); }) as unknown as typeof fetch;
    const r = await lineClient('TOKEN', f).push('Cgroup', [{ type: 'text', text: 'hi' }], CARD);
    expect(r).toEqual({ ok: true, status: 200, requestId: 'req-1', error: null });
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/message/push');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer TOKEN');
    expect(h['X-Line-Retry-Key']).toBe(CARD);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ to: 'Cgroup', messages: [{ type: 'text', text: 'hi' }] });
  });
  it('a network error is status 0 with the message, never the token', async () => {
    const f = (async () => { throw new Error('connect ECONNREFUSED (Bearer TOKEN)'); }) as unknown as typeof fetch;
    const r = await lineClient('TOKEN', f).reply('rt', []);
    expect(r.ok).toBe(false); expect(r.status).toBe(0); expect(r.error).not.toContain('TOKEN');
  });
  it('an error answer carries LINE\'s message', async () => {
    const f = (async () => new Response('{"message":"Invalid reply token"}', { status: 400 })) as unknown as typeof fetch;
    expect(await lineClient('T0KEN', f).reply('rt', [])).toEqual({ ok: false, status: 400, requestId: null, error: 'HTTP 400: Invalid reply token' });
  });
});

describe('orderCard', () => {
  it('shows at most 3 item lines and how many more', () => {
    const one = JSON.stringify(orderCard(card({}, 1)));
    const twelve = JSON.stringify(orderCard(card({}, 12)));
    expect(one).toContain('สินค้า 1'); expect(one).not.toContain('อีก');
    expect(twelve).toContain('สินค้า 3'); expect(twelve).toContain('+ อีก 9 รายการ');
    expect(twelve.length).toBeLessThan(30000);
  });
  it('a new order offers accept, accept + approve, reject (postbacks bound to the card and the order)', () => {
    const p = postbacks(orderCard(card(), ));
    expect(p.map((x) => x.a)).toEqual(['accept', 'quick_ask', 'reject_ask']);
    expect(new Set(p.map((x) => x.o))).toEqual(new Set([ORDER]));
  });
  it('no quick approve button when the order does not qualify', () => {
    expect(postbacks(orderCard(card({ quick: { ok: false, why: 'OVER_CAP' } }))).map((x) => x.a)).toEqual(['accept', 'reject_ask']);
  });
  it('an order that is no longer new has no action buttons, only its status', () => {
    const o = orderCard(card({ status: 'confirmed' }));
    expect(postbacks(o)).toEqual([]);
    expect(JSON.stringify(o)).toContain('รับแล้ว');
  });
  it('links open the back office in the phone browser on that order and that slip, and call the customer', () => {
    expect(uris(orderCard(card()))).toEqual([
      `https://tomcraft-grp.github.io/bizops-platform/?openExternalBrowser=1#/shop-admin?order=${ORDER}`,
      `https://tomcraft-grp.github.io/bizops-platform/?openExternalBrowser=1#/payment-review?evidence=${EV}`,
      'tel:0812345678',
    ]);
  });
  it('a wallet order says so and has no slip button', () => {
    const o = orderCard(card({ payment: { method: 'wallet', bank: null, has_slip: false, transfer_at: null, evidence_id: null }, quick: { ok: false, why: 'NO_SLIP' } }));
    expect(JSON.stringify(o)).toContain('ชำระด้วยกระเป๋าเงิน');
    expect(uris(o).some((u) => u.includes('payment-review'))).toBe(false);
  });
  it('the slip header variant reads "สลิปใหม่"', () => { expect(JSON.stringify(orderCard(card(), 'slip_new'))).toContain('สลิปใหม่'); });
  it('is a Flex message with alt text', () => {
    const o = orderCard(card()) as { type: string; altText: string; contents: { type: string } };
    expect(o.type).toBe('flex'); expect(o.altText).toContain('ORD-20261122-0001'); expect(o.contents.type).toBe('bubble');
  });
});

describe('follow-ups and replies', () => {
  it('followUpCard names who accepted or cancelled', () => {
    expect(JSON.stringify(followUpCard({ order_no: 'ORD-1', status: 'confirmed', by: 'คุณ A', at: '2026-11-22T07:05:00Z' }))).toContain('รับแล้วโดย คุณ A');
    const c = JSON.stringify(followUpCard({ order_no: 'ORD-1', status: 'cancelled', by: 'คุณ B', at: '2026-11-22T07:05:00Z', reason: 'สินค้าหมด' }));
    expect(c).toContain('ยกเลิกโดย คุณ B'); expect(c).toContain('สินค้าหมด');
  });
  it('quickAskCard shows the amount and asks to confirm with a quick_confirm postback', () => {
    const q = quickAskCard({ result: 'ask_quick', order_no: 'ORD-1', amount: 2500, bank: 'SCB', transfer_at: '2026-11-22T07:05:00Z' }, CARD, ORDER);
    expect(JSON.stringify(q)).toContain('฿2,500.00');
    expect(postbacks(q).map((x) => x.a)).toEqual(['quick_confirm']);
  });
  it('reasonsCard has one reject postback per reason (by number) and "อื่น ๆ" opening the order', () => {
    const r = reasonsCard(['สลิปไม่ถูกต้อง', 'ยอดเงินไม่ตรง'], CARD, ORDER, 'https://x/#/shop-admin?order=1');
    expect(postbacks(r).map((x) => [x.a, x.r])).toEqual([['reject', 0], ['reject', 1]]);
    expect(uris(r)).toEqual(['https://x/#/shop-admin?order=1']);
  });
  it('resultText gives the exact Thai sentences', () => {
    expect(resultText({ result: 'already_done', order_no: 'ORD-1', status: 'confirmed', by: 'คุณ A', at: '2026-11-22T07:05:00Z' })).toBe('ออเดอร์ ORD-1 ถูกรับแล้วโดย คุณ A เมื่อ 14:05');
    expect(resultText({ result: 'already_done', order_no: 'ORD-1', status: 'cancelled', by: 'คุณ B', at: '2026-11-22T07:05:00Z' })).toBe('ออเดอร์ ORD-1 ถูกยกเลิกแล้วโดย คุณ B เมื่อ 14:05');
    expect(resultText({ result: 'not_linked' })).toBe('บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ');
    expect(resultText({ result: 'slip_done', order_no: 'ORD-1', status: 'confirmed', by: 'คุณ S', at: '2026-11-22T07:05:00Z' })).toBe('สลิปของออเดอร์ ORD-1 ถูกยืนยันแล้วโดย คุณ S เมื่อ 14:05');
    expect(resultText({ result: 'slip_done', order_no: 'ORD-1', status: 'verified', by: 'คุณ S', at: '2026-11-22T07:05:00Z' })).toBe('สลิปของออเดอร์ ORD-1 ถูกบันทึกรับเงินแล้วโดย คุณ S เมื่อ 14:05');
    expect(resultText({ result: 'slip_done', order_no: 'ORD-1', status: 'rejected', by: 'คุณ S', at: '2026-11-22T07:05:00Z' })).toBe('สลิปของออเดอร์ ORD-1 ถูกปฏิเสธแล้วโดย คุณ S เมื่อ 14:05');
    expect(resultText({ result: 'done', action: 'accept', order_no: 'ORD-1', by: 'คุณ A', at: '2026-11-22T07:05:00Z' })).toBe('✅ รับออเดอร์ ORD-1 แล้ว (คุณ A · 14:05)');
    expect(resultText({ result: 'not_allowed', why: 'not_verifier' })).toContain('ผู้ตรวจการเงิน');
    expect(resultText({ result: 'refused', code: 'OVER_CAP' })).toContain('เกินวงเงิน');
  });
});

describe('types', () => {
  it('Postback type is the shape parsePostback returns', () => { const p: Postback | null = parsePostback(encodePostback({ a: 'accept', o: ORDER, c: CARD })); expect(p?.a).toBe('accept'); });
});

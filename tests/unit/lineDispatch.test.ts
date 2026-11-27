// The line-dispatch Edge Function with FAKES: who may call it, what is sent for each event, how each LINE answer ends in the outbox (sent / retry / dead),
// secret redaction, and the connection test.
import { describe, expect, it } from 'vitest';
import { handleDispatch, type DispatchDeps, type OutboxRow } from '../../supabase/functions/line-dispatch/handler';
import type { SendResult } from '../../supabase/functions/_shared/line';
import type { CardData } from '../../supabase/functions/_shared/lineCards';

const DSECRET = 'dispatch-secret-0000000000000000000000000000000000';
const TOKEN = 'TESTTOKEN-line-0123456789-abcdefghij';
const ORDER = '11111111-2222-4333-8444-555555555555';
const ID1 = '66666666-7777-4888-9999-aaaaaaaaaaa1';
const ID2 = '66666666-7777-4888-9999-aaaaaaaaaaa2';
const CARD: CardData = {
  order_id: ORDER, order_no: 'ORD-1', customer_name: 'Somchai', phone: '0812345678', created_at: '2026-11-22T07:05:00Z', item_count: 2,
  items: [{ name: 'สินค้า', qty: 2, price: 420, image: null }], more_count: 0, total: 840, fulfilment: 'pickup',
  payment: { method: 'transfer', bank: 'SCB', has_slip: true, transfer_at: '2026-11-22T07:02:00Z', evidence_id: null },
  status: 'new', quick: { ok: false, why: 'QUICK_OFF' }, app_url: 'https://tomcraft-grp.github.io/bizops-platform/',
};
const row = (id: string, over: Partial<OutboxRow> = {}): OutboxRow => ({ id, event: 'order_new', target_type: 'group', target_id: 'Cgroup', attempts: 0, card: CARD, payload: {}, ...over });
const OK: SendResult = { ok: true, status: 200, requestId: 'req-1', error: null };

function fakes(rows: OutboxRow[], answer: (to: string) => SendResult = () => OK, over: Partial<DispatchDeps> = {}) {
  const pushes: { to: string; messages: unknown[]; key: string }[] = [];
  const done: [string, boolean, boolean, string | null, string | null][] = [];
  let claimed = false;
  const deps: DispatchDeps = {
    dispatchSecret: async () => DSECRET,
    token: async () => TOKEN,
    claim: async () => { if (claimed) return []; claimed = true; return rows; },
    complete: async (id, ok, retryable, error, requestId) => { done.push([id, ok, retryable, error, requestId]); },
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return answer(to); },
    botInfo: async () => ({ ok: true, status: 200, requestId: null, error: null, name: 'Tomcraft Shop' }),
    isSuperAdmin: async (jwt) => jwt === 'admin-jwt',
    secrets: () => [TOKEN, DSECRET],
    ...over,
  };
  return { deps, pushes, done };
}
const drain = (headers: Record<string, string> = { 'x-line-dispatch-secret': DSECRET }) =>
  new Request('https://x/functions/v1/line-dispatch', { method: 'POST', body: '{}', headers });

describe('line-dispatch', () => {
  it('wrong secret → 401, nothing claimed', async () => {
    const { deps, pushes } = fakes([row(ID1)]);
    expect((await handleDispatch(drain({ 'x-line-dispatch-secret': 'nope' }), deps)).status).toBe(401);
    expect((await handleDispatch(drain({}), deps)).status).toBe(401);
    expect(pushes).toHaveLength(0);
  });
  it('sends each claimed row with its id as retry key and completes ok', async () => {
    const { deps, pushes, done } = fakes([row(ID1), row(ID2, { target_id: 'Cgroup2' })]);
    const r = await handleDispatch(drain(), deps);
    expect(await r.json()).toEqual({ sent: 2, retried: 0, dead: 0 });
    expect(pushes.map((p) => [p.to, p.key])).toEqual([['Cgroup', ID1], ['Cgroup2', ID2]]);
    expect(done).toEqual([[ID1, true, false, null, 'req-1'], [ID2, true, false, null, 'req-1']]);
    expect(JSON.stringify(pushes[0].messages)).toContain(`"c":"`.replace('"c":"', '') + ID1);   // the card's postbacks carry the outbox id
  });
  it('429 retries', async () => {
    const { deps, done } = fakes([row(ID1)], () => ({ ok: false, status: 429, requestId: null, error: 'HTTP 429: quota' }));
    expect(await (await handleDispatch(drain(), deps)).json()).toEqual({ sent: 0, retried: 1, dead: 0 });
    expect(done[0]).toEqual([ID1, false, true, 'HTTP 429: quota', null]);
  });
  it('401 is dead and redacted', async () => {
    const { deps, done } = fakes([row(ID1)], () => ({ ok: false, status: 401, requestId: null, error: `HTTP 401: invalid token ${TOKEN}` }));
    expect(await (await handleDispatch(drain(), deps)).json()).toEqual({ sent: 0, retried: 0, dead: 1 });
    expect(done[0][1]).toBe(false); expect(done[0][2]).toBe(false);
    expect(done[0][3]).toContain('HTTP 401'); expect(done[0][3]).not.toContain(TOKEN);
  });
  it('network error → retry', async () => {
    const { deps, done } = fakes([row(ID1)], () => ({ ok: false, status: 0, requestId: null, error: 'connect ECONNREFUSED' }));
    await handleDispatch(drain(), deps);
    expect(done[0].slice(1, 3)).toEqual([false, true]);
  });
  it("no token configured → every row completes retryable with 'LINE_NOT_CONFIGURED'", async () => {
    const { deps, pushes, done } = fakes([row(ID1), row(ID2)], undefined, { token: async () => null });
    await handleDispatch(drain(), deps);
    expect(pushes).toHaveLength(0);
    expect(done.map((d) => d.slice(1, 4))).toEqual([[false, true, 'LINE_NOT_CONFIGURED'], [false, true, 'LINE_NOT_CONFIGURED']]);
  });
  it('a card row whose order is gone is dead (nothing to send)', async () => {
    const { deps, done } = fakes([row(ID1, { card: null })]);
    await handleDispatch(drain(), deps);
    expect(done[0].slice(1, 4)).toEqual([false, false, 'NOTHING_TO_SEND']);
  });
  it('order_status row renders followUpCard; slip_new reads "สลิปใหม่"', async () => {
    const { deps, pushes } = fakes([
      row(ID1, { event: 'order_status', payload: { order_no: 'ORD-1', status: 'cancelled', by: 'คุณ B', at: '2026-11-22T07:05:00Z', reason: 'สินค้าหมด' } }),
      row(ID2, { event: 'slip_new' }),
    ]);
    await handleDispatch(drain(), deps);
    expect(JSON.stringify(pushes[0].messages)).toContain('ยกเลิกโดย คุณ B');
    expect(JSON.stringify(pushes[1].messages)).toContain('สลิปใหม่');
  });
  it('payment_issue and customer_notify are text lines', async () => {
    const { deps, pushes } = fakes([
      row(ID1, { event: 'payment_issue', payload: { order_no: 'ORD-1', kind: 'rejected', reason: 'Blurred' } }),
      row(ID2, { event: 'customer_notify', target_type: 'user', target_id: 'Ucust', payload: { order_no: 'ORD-1', status: 'confirmed' } }),
    ]);
    await handleDispatch(drain(), deps);
    const t1 = (pushes[0].messages[0] as { text: string }).text;
    expect(t1).toContain('ORD-1'); expect(t1).toContain('สลิปถูกปฏิเสธ'); expect(t1).toContain('Blurred'); expect(t1).toContain('#/shop-admin?order=');
    expect((pushes[1].messages[0] as { text: string }).text).toBe('ร้านรับออเดอร์ ORD-1 แล้ว ขอบคุณที่สั่งซื้อ');
  });
  it('op test: non-admin → 403; admin → {ok:true, name}', async () => {
    const { deps } = fakes([]);
    const t = (jwt?: string) => new Request('https://x', { method: 'POST', body: '{"op":"test"}', headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });
    expect((await handleDispatch(t(), deps)).status).toBe(403);
    expect((await handleDispatch(t('user-jwt'), deps)).status).toBe(403);
    const r = await handleDispatch(t('admin-jwt'), deps);
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true, name: 'Tomcraft Shop', error: null });
  });
  it('op test with a bad token reports the error without the token', async () => {
    const { deps } = fakes([], undefined, { botInfo: async () => ({ ok: false, status: 401, requestId: null, error: `HTTP 401: bad ${TOKEN}` }) });
    const r = await handleDispatch(new Request('https://x', { method: 'POST', body: '{"op":"test"}', headers: { Authorization: 'Bearer admin-jwt' } }), deps);
    const j = await r.json();
    expect(j.ok).toBe(false); expect(j.error).not.toContain(TOKEN);
  });
  it('OPTIONS answers CORS for the Settings page', async () => {
    const { deps } = fakes([]);
    const r = await handleDispatch(new Request('https://x', { method: 'OPTIONS', headers: { Origin: 'https://tomcraft-grp.github.io' } }), deps);
    expect(r.status).toBe(200); expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://tomcraft-grp.github.io');
  });
});

describe('line-dispatch: preorder messages', () => {
  const PRE: CardData = { ...CARD, order_type: 'preorder', pickup_at: '2026-12-01T03:00:00Z' };
  it('a staff message is the database\'s Thai sentence plus the back-office link of that order', async () => {
    const { deps, pushes, done } = fakes([row(ID1, { event: 'preorder', card: PRE, payload: { kind: 'late', order_no: 'ORD-1', text: '🚨 ORD-1 ถึงเวลานัดรับแล้ว (01/12 10:00 น.) แต่ยังไม่พร้อม', audience: 'staff' } })]);
    await handleDispatch(drain(), deps);
    const text = (pushes[0].messages[0] as { type: string; text: string }).text;
    expect(pushes[0].to).toBe('Cgroup');
    expect(text.startsWith('🚨 ORD-1 ถึงเวลานัดรับแล้ว')).toBe(true);
    expect(text).toContain(`#/preorders?order=${ORDER}`);
    expect(done[0].slice(1, 3)).toEqual([true, false]);
  });
  it('a customer message never carries a back-office link', async () => {
    const { deps, pushes } = fakes([row(ID1, { event: 'preorder', target_type: 'user', target_id: 'Ucust', card: PRE, payload: { kind: 'ready', order_no: 'ORD-1', text: '✅ ออเดอร์ ORD-1 พร้อมให้รับแล้ว', audience: 'customer' } })]);
    await handleDispatch(drain(), deps);
    const text = (pushes[0].messages[0] as { text: string }).text;
    expect(pushes[0].to).toBe('Ucust');
    expect(text).toBe('✅ ออเดอร์ ORD-1 พร้อมให้รับแล้ว');
    expect(text).not.toContain('#/');
  });
  it('a preorder row without its text is dead (nothing to send), and a gone card still sends the text', async () => {
    const a = fakes([row(ID1, { event: 'preorder', payload: { kind: 'x' } })]);
    await handleDispatch(drain(), a.deps);
    expect(a.done[0].slice(1, 4)).toEqual([false, false, 'NOTHING_TO_SEND']);
    const b = fakes([row(ID2, { event: 'preorder', card: null, payload: { text: 'hello', audience: 'staff' } })]);
    await handleDispatch(drain(), b.deps);
    expect((b.pushes[0].messages[0] as { text: string }).text).toBe('hello');
  });
  it('a preorder order card says so and shows the pickup time; a regular card is unchanged', async () => {
    const { deps, pushes } = fakes([row(ID1, { event: 'order_new', card: PRE }), row(ID2, { event: 'order_new' })]);
    await handleDispatch(drain(), deps);
    const pre = JSON.stringify(pushes[0].messages); const reg = JSON.stringify(pushes[1].messages);
    expect(pre).toContain('พรีออเดอร์ใหม่'); expect(pre).toContain('นัดรับ'); expect(pre).toContain('10:00');
    expect(reg).toContain('ออเดอร์ใหม่'); expect(reg).not.toContain('พรีออเดอร์'); expect(reg).not.toContain('นัดรับ');
  });
});

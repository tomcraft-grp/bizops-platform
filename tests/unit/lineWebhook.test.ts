// The line-webhook Edge Function's request handling with FAKES (no LINE, no database): signature, dedupe, who tapped, which chats count, linking codes,
// the reply for every action result, and the push fallback when a reply token has expired.
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleWebhook, type WebhookDeps } from '../../supabase/functions/line-webhook/handler';
import { encodePostback, type SendResult } from '../../supabase/functions/_shared/line';
import type { ActResult } from '../../supabase/functions/_shared/lineCards';

const SECRET = '0123456789abcdef0123456789abcdef';
const GROUP = 'Cgroup0000000000000000000000000001';
const ORDER = '11111111-2222-4333-8444-555555555555';
const CARD = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const OK: SendResult = { ok: true, status: 200, requestId: 'r', error: null };

type Calls = { act: unknown[]; reply: { token: string; messages: unknown[] }[]; push: { to: string; messages: unknown[] }[]; redeem: unknown[]; left: string[]; logs: string[] };
function fakes(over: Partial<WebhookDeps> = {}, actResult: ActResult = { result: 'done', action: 'accept', order_no: 'ORD-1', by: 'คุณ A', at: '2026-11-22T07:05:00Z' }) {
  const calls: Calls = { act: [], reply: [], push: [], redeem: [], left: [], logs: [] };
  const seen = new Set<string>();
  const deps: WebhookDeps = {
    channelSecret: async () => SECRET,
    seen: async (id) => { if (seen.has(id)) return false; seen.add(id); return true; },
    redeem: async (u, n, c, g) => { calls.redeem.push([u, n, c, g]); return g ? { result: 'group_bound', name: 'Boss' } : { result: 'linked', name: 'Adm' }; },
    groupLeft: async (g) => { calls.left.push(g); },
    boundGroup: async () => GROUP,
    appUrl: async () => 'https://tomcraft-grp.github.io/bizops-platform/',
    act: async (a) => { calls.act.push(a); return actResult; },
    reply: async (token, messages) => { calls.reply.push({ token, messages }); return OK; },
    push: async (to, messages) => { calls.push.push({ to, messages }); return OK; },
    profileName: async () => 'Adm on LINE',
    groupName: async () => 'Shop admins',
    log: (m) => { calls.logs.push(m); },
    ...over,
  };
  return { deps, calls };
}
function req(events: unknown[], opts: { sig?: string | null; body?: string } = {}) {
  const body = opts.body ?? JSON.stringify({ destination: 'Ubot', events });
  const sig = opts.sig === undefined ? createHmac('sha256', SECRET).update(body).digest('base64') : opts.sig;
  return new Request('https://x/functions/v1/line-webhook', { method: 'POST', body, headers: sig ? { 'x-line-signature': sig } : {} });
}
const tap = (data: string, over: Record<string, unknown> = {}) => ({
  type: 'postback', webhookEventId: 'ev-' + Math.random(), replyToken: 'rt-1', postback: { data }, source: { type: 'group', groupId: GROUP, userId: 'Uadm' }, ...over,
});
const text = (t: string, source: Record<string, unknown>) => ({ type: 'message', webhookEventId: 'ev-' + Math.random(), replyToken: 'rt-2', message: { type: 'text', text: t }, source });
const accept = encodePostback({ a: 'accept', o: ORDER, c: CARD });
const replyText = (c: Calls, i = 0) => (c.reply[i].messages[0] as { text?: string }).text;

describe('line-webhook', () => {
  it('bad signature → 401 and act not called', async () => {
    const { deps, calls } = fakes();
    const r = await handleWebhook(req([tap(accept)], { sig: 'AAAA' }), deps);
    expect(r.status).toBe(401); expect(calls.act).toHaveLength(0);
  });
  it('no signature → 401', async () => { const { deps } = fakes(); expect((await handleWebhook(req([], { sig: null }), deps)).status).toBe(401); });
  it('missing secret → 503', async () => { const { deps } = fakes({ channelSecret: async () => null }); expect((await handleWebhook(req([]), deps)).status).toBe(503); });
  it('wrong method → 405', async () => { const { deps } = fakes(); expect((await handleWebhook(new Request('https://x', { method: 'GET' }), deps)).status).toBe(405); });

  it('postback from bound group calls act with the tapper and replies with the result sentence', async () => {
    const { deps, calls } = fakes();
    const r = await handleWebhook(req([tap(accept)]), deps);
    expect(r.status).toBe(200);
    expect(calls.act).toEqual([expect.objectContaining({ lineUser: 'Uadm', action: 'accept', order: ORDER, card: CARD, reason: null })]);
    expect(replyText(calls)).toBe('✅ รับออเดอร์ ORD-1 แล้ว (คุณ A · 14:05)');
  });
  it('dedupes redelivered event', async () => {
    const { deps, calls } = fakes();
    const ev = tap(accept);
    await handleWebhook(req([ev]), deps);
    await handleWebhook(req([{ ...ev, deliveryContext: { isRedelivery: true } }]), deps);
    expect(calls.act).toHaveLength(1); expect(calls.reply).toHaveLength(1);
  });
  it('ask_quick → reply is the confirm card; ask_reason → the reasons card', async () => {
    const a = fakes({}, { result: 'ask_quick', order_no: 'ORD-1', amount: 2500, bank: 'SCB', transfer_at: '2026-11-22T07:05:00Z' });
    await handleWebhook(req([tap(encodePostback({ a: 'quick_ask', o: ORDER, c: CARD }))]), a.deps);
    expect(JSON.stringify(a.calls.reply[0].messages)).toContain('quick_confirm');
    const b = fakes({}, { result: 'ask_reason', order_no: 'ORD-1', reasons: ['สลิปไม่ถูกต้อง', 'สินค้าหมด'] });
    await handleWebhook(req([tap(encodePostback({ a: 'reject_ask', o: ORDER, c: CARD }))]), b.deps);
    const s = JSON.stringify(b.calls.reply[0].messages);
    expect(s).toContain('สินค้าหมด'); expect(s).toContain(`#/shop-admin?order=${ORDER}`);
  });
  it('a reject tap passes the reason number', async () => {
    const { deps, calls } = fakes();
    await handleWebhook(req([tap(encodePostback({ a: 'reject', o: ORDER, c: CARD, r: 2 }))]), deps);
    expect(calls.act[0]).toEqual(expect.objectContaining({ action: 'reject', reason: 2 }));
  });
  it('postback from another group is ignored', async () => {
    const { deps, calls } = fakes();
    const r = await handleWebhook(req([tap(accept, { source: { type: 'group', groupId: 'Cother', userId: 'Uadm' } })]), deps);
    expect(r.status).toBe(200); expect(calls.act).toHaveLength(0); expect(calls.reply).toHaveLength(0);
  });
  it('group event without userId → reply not_linked text, no act', async () => {
    const { deps, calls } = fakes();
    await handleWebhook(req([tap(accept, { source: { type: 'group', groupId: GROUP } })]), deps);
    expect(calls.act).toHaveLength(0); expect(replyText(calls)).toBe('บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ');
  });
  it('malformed postback data is ignored', async () => {
    const { deps, calls } = fakes();
    await handleWebhook(req([tap('a=drop&o=x')]), deps);
    expect(calls.act).toHaveLength(0); expect(calls.reply).toHaveLength(0);
  });

  it('6-digit text in 1:1 → redeem as a staff link; linked → confirmation reply', async () => {
    const { deps, calls } = fakes();
    await handleWebhook(req([text(' 123456 ', { type: 'user', userId: 'Uadm' })]), deps);
    expect(calls.redeem).toEqual([['Uadm', 'Adm on LINE', '123456', null]]);
    expect(replyText(calls)).toContain('เชื่อมบัญชีเรียบร้อย');
  });
  it('a group code typed in a group binds that group (any group: it is not bound yet)', async () => {
    const { deps, calls } = fakes({ boundGroup: async () => null });
    await handleWebhook(req([text('654321', { type: 'group', groupId: 'Cnew', userId: 'Usup' })]), deps);
    expect(calls.redeem).toEqual([['Usup', 'Shop admins', '654321', 'Cnew']]);
    expect(replyText(calls)).toContain('ผูกกลุ่มนี้เรียบร้อย');
  });
  it('a wrong code and rate limiting get their own replies', async () => {
    const a = fakes({ redeem: async () => ({ result: 'bad_code' }) });
    await handleWebhook(req([text('000000', { type: 'user', userId: 'U1' })]), a.deps);
    expect(replyText(a.calls)).toContain('รหัสไม่ถูกต้อง');
    const b = fakes({ redeem: async () => ({ result: 'rate_limited' }) });
    await handleWebhook(req([text('000000', { type: 'user', userId: 'U1' })]), b.deps);
    expect(replyText(b.calls)).toContain('ลองใหม่ใน 1 ชั่วโมง');
  });
  it('a 6-digit number typed in the bound admin group (an amount, a phone) is not a code: no reply, no attempt counted', async () => {
    const { deps, calls } = fakes();
    await handleWebhook(req([text('150000', { type: 'group', groupId: GROUP, userId: 'U1' })]), deps);
    expect(calls.redeem).toHaveLength(0); expect(calls.reply).toHaveLength(0);
  });
  it('a wrong code in a group gets no reply (the bot stays quiet in group chats)', async () => {
    const { deps, calls } = fakes({ boundGroup: async () => null, redeem: async () => ({ result: 'bad_code' }) });
    await handleWebhook(req([text('000000', { type: 'group', groupId: 'Cnew', userId: 'U1' })]), deps);
    expect(calls.reply).toHaveLength(0); expect(calls.push).toHaveLength(0);
  });
  it('ordinary chat text is ignored', async () => {
    const { deps, calls } = fakes();
    await handleWebhook(req([text('สวัสดีครับ', { type: 'group', groupId: GROUP, userId: 'U1' }), text('12345', { type: 'user', userId: 'U1' })]), deps);
    expect(calls.redeem).toHaveLength(0); expect(calls.reply).toHaveLength(0);
  });
  it('leave event → groupLeft', async () => {
    const { deps, calls } = fakes();
    await handleWebhook(req([{ type: 'leave', webhookEventId: 'ev-l', source: { type: 'group', groupId: GROUP } }]), deps);
    expect(calls.left).toEqual([GROUP]);
  });
  it('reply failure falls back to push to the group', async () => {
    const { deps, calls } = fakes({ reply: async () => ({ ok: false, status: 400, requestId: null, error: 'HTTP 400: Invalid reply token' }) });
    await handleWebhook(req([tap(accept)]), deps);
    expect(calls.push).toHaveLength(1); expect(calls.push[0].to).toBe(GROUP);
  });
  it('reply failure in 1:1 falls back to push to the user', async () => {
    const { deps, calls } = fakes({ reply: async () => ({ ok: false, status: 400, requestId: null, error: 'x' }) });
    await handleWebhook(req([text('123456', { type: 'user', userId: 'Uadm' })]), deps);
    expect(calls.push[0].to).toBe('Uadm');
  });
  it('act throws → 200, error reply, error logged without the secret', async () => {
    const { deps, calls } = fakes({ act: async () => { throw new Error(`db down ${SECRET}`); } });
    const r = await handleWebhook(req([tap(accept)]), deps);
    expect(r.status).toBe(200);
    expect(replyText(calls)).toBe('เกิดข้อผิดพลาด ลองใหม่หรือทำในเว็บ');
    expect(calls.logs.join(' ')).toContain('db down'); expect(calls.logs.join(' ')).not.toContain(SECRET);
  });
  it('a body that is not JSON (but signed) → 400', async () => {
    const { deps } = fakes();
    expect((await handleWebhook(req([], { body: 'not json' }), deps)).status).toBe(400);
  });
});

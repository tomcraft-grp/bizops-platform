// Request handling for the line-webhook Edge Function, with every outside dependency injected (tests/unit/lineWebhook.test.ts); index.ts wires the real ones.
//
//   POST (from LINE) with X-Line-Signature -> 401 bad/missing signature · 503 no channel secret configured · 400 not JSON · 200 otherwise (always, after a good
//   signature: LINE redelivers on anything else, and every event is handled on its own).
// What counts: postbacks (card buttons) from the bound admin group or a 1:1 chat; 6-digit link codes typed in a 1:1 chat (staff link) or in a group (binding
// that group); the bot leaving a group. Everything else is ignored. Who tapped = source.userId, trusted only because the signature is valid; what that person
// may do is decided by the database (line_act), never here.
import { parsePostback, redact, verifySignature, type SendResult } from '../_shared/line.ts';
import { orderUrl, quickAskCard, reasonsCard, resultText, type ActResult } from '../_shared/lineCards.ts';

export interface WebhookDeps {
  channelSecret(): Promise<string | null>;
  /** line_webhook_seen: true the first time an event id is seen. */
  seen(eventId: string, type: string, source: string): Promise<boolean>;
  redeem(lineUser: string, name: string | null, code: string, group: string | null): Promise<{ result: string; name?: string }>;
  groupLeft(group: string): Promise<void>;
  boundGroup(): Promise<string | null>;
  appUrl(): Promise<string>;
  act(a: { lineUser: string; action: 'accept' | 'quick_ask' | 'quick_confirm' | 'reject_ask' | 'reject'; order: string; card: string; reason: number | null; eventId: string }): Promise<ActResult>;
  reply(token: string, messages: unknown[]): Promise<SendResult>;
  push(to: string, messages: unknown[]): Promise<SendResult>;
  profileName(userId: string): Promise<string | null>;
  groupName(groupId: string): Promise<string | null>;
  log(msg: string): void;
}

type Source = { type?: string; userId?: string; groupId?: string; roomId?: string };
type LineEvent = { type?: string; webhookEventId?: string; replyToken?: string; source?: Source; postback?: { data?: string }; message?: { type?: string; text?: string } };

const ERROR_TEXT = 'เกิดข้อผิดพลาด ลองใหม่หรือทำในเว็บ';
const textMsg = (t: string) => ({ type: 'text', text: t });

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const raw = await req.text();
  const secret = await deps.channelSecret();
  if (!secret) return new Response('LINE is not configured', { status: 503 });
  if (!(await verifySignature(secret, raw, req.headers.get('x-line-signature')))) return new Response('Bad signature', { status: 401 });
  let body: { events?: LineEvent[] };
  try { body = JSON.parse(raw); } catch { return new Response('Bad request', { status: 400 }); }
  const group = await deps.boundGroup();
  for (const ev of Array.isArray(body.events) ? body.events : []) {
    try { await handleEvent(ev, group, deps, secret); }
    catch (e) { deps.log('line-webhook event failed: ' + redact(e instanceof Error ? e.message : String(e), [secret])); }
  }
  return new Response('ok', { status: 200 });
}

async function handleEvent(ev: LineEvent, group: string | null, deps: WebhookDeps, secret: string): Promise<void> {
  const src = ev.source ?? {};
  if (!(await deps.seen(ev.webhookEventId ?? '', ev.type ?? '', src.type ?? ''))) return;
  const answer = async (messages: unknown[]) => {
    if (ev.replyToken) { const r = await deps.reply(ev.replyToken, messages); if (r.ok) return; }
    const to = src.type === 'group' ? src.groupId : src.type === 'user' ? src.userId : undefined;   // the reply token expired: push instead
    if (to) await deps.push(to, messages);
  };

  if (ev.type === 'leave' && src.type === 'group' && src.groupId) { await deps.groupLeft(src.groupId); return; }

  if (ev.type === 'message' && ev.message?.type === 'text') {
    const code = (ev.message.text ?? '').trim();
    if (!/^[0-9]{6}$/.test(code)) return;                                        // ordinary chat
    if (src.type === 'user' && src.userId) {
      const r = await deps.redeem(src.userId, await deps.profileName(src.userId), code, null);
      await answer([textMsg(r.result === 'linked' ? `เชื่อมบัญชีเรียบร้อย: ${r.name ?? ''} จะกดรับออเดอร์จากการ์ดในกลุ่มได้แล้ว` : codeError(r.result))]);
    } else if (src.type === 'group' && src.groupId && src.userId && src.groupId !== group) {
      // in the bound admin group a 6-digit number is an amount or a phone, never a code; elsewhere only a successful binding is answered (quiet in group chats)
      const r = await deps.redeem(src.userId, await deps.groupName(src.groupId), code, src.groupId);
      if (r.result === 'group_bound') await answer([textMsg('ผูกกลุ่มนี้เรียบร้อย ออเดอร์ใหม่จะแจ้งในกลุ่มนี้')]);
    }
    return;
  }

  if (ev.type === 'postback') {
    if (src.type === 'group' ? src.groupId !== group || !group : src.type !== 'user') return;   // only the bound group, or a 1:1 chat
    const p = parsePostback(ev.postback?.data ?? '');
    if (!p) return;
    if (!src.userId) { await answer([textMsg(resultText({ result: 'not_linked' }))]); return; }
    let r: ActResult;
    try {
      r = await deps.act({ lineUser: src.userId, action: p.a, order: p.o, card: p.c, reason: p.r ?? null, eventId: ev.webhookEventId ?? '' });
    } catch (e) {
      deps.log('line_act failed: ' + redact(e instanceof Error ? e.message : String(e), [secret]));
      await answer([textMsg(ERROR_TEXT)]);
      return;
    }
    if (r.result === 'ask_quick') await answer([quickAskCard(r, p.c, p.o)]);
    else if (r.result === 'ask_reason') await answer([reasonsCard(r.reasons, p.c, p.o, orderUrl({ app_url: await deps.appUrl(), order_id: p.o }))]);
    else await answer([textMsg(resultText(r))]);
  }
}

function codeError(result: string): string {
  return result === 'rate_limited' ? 'ใส่รหัสผิดหลายครั้ง ลองใหม่ใน 1 ชั่วโมง' : 'รหัสไม่ถูกต้องหรือหมดอายุ สร้างรหัสใหม่ในหน้า Settings';
}

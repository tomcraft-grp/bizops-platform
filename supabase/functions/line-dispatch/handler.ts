// Request handling for the line-dispatch Edge Function, with every outside dependency injected (tests/unit/lineDispatch.test.ts); index.ts wires the real ones.
//
//   POST {} with x-line-dispatch-secret (pg_net, from line_kick: right after a message is queued and every minute)
//      -> drains the outbox: claim due rows, render each from the CURRENT order state, push to LINE, record sent / retry / dead -> 200 {sent, retried, dead}
//   POST {"op":"test"} with Authorization: Bearer <a SUPER_ADMIN's JWT> (the Settings page) -> 200 {ok, name, error}: LINE's bot info, i.e. the token works
// The token never appears in a stored error or an answer (redacted).
import { classify, redact, type SendResult } from '../_shared/line.ts';
import { followUpCard, orderCard, orderUrl, preorderUrl, type CardData } from '../_shared/lineCards.ts';

export type OutboxRow = {
  id: string; event: 'order_new' | 'slip_new' | 'order_status' | 'payment_issue' | 'customer_notify' | 'preorder';
  target_type: 'group' | 'user'; target_id: string; attempts: number; card: CardData | null; payload: Record<string, unknown>;
};

export interface DispatchDeps {
  dispatchSecret(): Promise<string | null>;
  token(): Promise<string | null>;
  claim(limit: number): Promise<OutboxRow[]>;
  complete(id: string, ok: boolean, retryable: boolean, error: string | null, requestId: string | null): Promise<void>;
  push(to: string, messages: unknown[], retryKey: string): Promise<SendResult>;
  botInfo(): Promise<SendResult & { name?: string }>;
  isSuperAdmin(jwt: string): Promise<boolean>;
  secrets(): (string | undefined | null)[];
}

const ALLOWED_ORIGINS = ['https://tomcraft-grp.github.io', 'http://localhost:5173'];
const BATCH = 20, ROUNDS = 5;

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

const ISSUE: Record<string, string> = { rejected: 'สลิปถูกปฏิเสธ', more_evidence: 'ขอหลักฐานการโอนเพิ่ม', ai: 'ผลตรวจสลิปอัตโนมัติไม่ผ่าน' };

/** The LINE messages for one outbox row, or null when there is nothing to send (a card whose order no longer exists). */
export function render(row: OutboxRow): unknown[] | null {
  const p = row.payload ?? {};
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  switch (row.event) {
    case 'order_new':
    case 'slip_new':
      return row.card ? [orderCard(row.card, row.event, row.id)] : null;
    case 'order_status':
      return [followUpCard({ order_no: s('order_no'), status: s('status'), by: s('by') || 'ระบบ', at: s('at'), reason: s('reason') || null })];
    case 'payment_issue': {
      const link = row.card ? `\nดูออเดอร์: ${orderUrl(row.card)}` : '';
      return [{ type: 'text', text: `⚠️ ${s('order_no')}: ${ISSUE[s('kind')] ?? 'มีปัญหาเรื่องการชำระเงิน'}${s('reason') ? ` (${s('reason')})` : ''}${link}` }];
    }
    case 'preorder': {
      // the Thai sentence is written by the database (preorder_msg); staff messages end with the link to the order in the back office, customer messages never do
      if (!s('text')) return null;
      const link = s('audience') === 'staff' && row.card ? `\nดูออเดอร์: ${preorderUrl(row.card)}` : '';
      return [{ type: 'text', text: s('text') + link }];
    }
    case 'customer_notify':
      return [{ type: 'text', text: s('status') === 'cancelled'
        ? `ออเดอร์ ${s('order_no')} ถูกยกเลิก${s('reason') ? `: ${s('reason')}` : ''}`
        : `ร้านรับออเดอร์ ${s('order_no')} แล้ว ขอบคุณที่สั่งซื้อ` }];
    default:
      return null;
  }
}

export async function handleDispatch(req: Request, deps: DispatchDeps): Promise<Response> {
  const headers = { ...cors(req.headers.get('Origin')), 'Content-Type': 'application/json' };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body: { op?: string } = {};
  try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { return reply(400, { error: 'Invalid JSON body' }); }

  if (body.op === 'test') {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt || !(await deps.isSuperAdmin(jwt))) return reply(403, { error: 'Only a SUPER_ADMIN can test the connection' });
    const r = await deps.botInfo();
    return reply(200, { ok: r.ok, name: r.name ?? null, error: r.error ? redact(r.error, deps.secrets()) : null });
  }

  const secret = await deps.dispatchSecret();
  const given = req.headers.get('x-line-dispatch-secret') ?? '';
  if (!secret || given.length !== secret.length || given !== secret) return reply(401, { error: 'Not allowed' });

  const token = await deps.token();
  const tally = { sent: 0, retried: 0, dead: 0 };
  for (let round = 0; round < ROUNDS; round++) {
    const rows = await deps.claim(BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!token) { await deps.complete(row.id, false, true, 'LINE_NOT_CONFIGURED', null); tally.retried++; continue; }
      const messages = render(row);
      if (!messages) { await deps.complete(row.id, false, false, 'NOTHING_TO_SEND', null); tally.dead++; continue; }
      const r = await deps.push(row.target_id, messages, row.id);
      const c = r.ok ? 'sent' : classify(r.status);
      const err = c === 'sent' ? null : redact(r.error ?? `HTTP ${r.status}`, deps.secrets());
      await deps.complete(row.id, c === 'sent', c === 'retry', err, r.requestId);
      if (c === 'sent') tally.sent++; else if (c === 'retry') tally.retried++; else tally.dead++;
    }
    if (rows.length < BATCH) break;
  }
  return reply(200, tally);
}

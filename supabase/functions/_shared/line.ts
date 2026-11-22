// Shared by the line-webhook and line-dispatch Edge Functions: the webhook signature, postback data, the LINE Messaging API client, how a LINE answer is
// classified for retries, and secret redaction. Standard web APIs only (crypto.subtle, fetch injected), so the same file runs in Deno and in vitest
// (tests/unit/lineCore.test.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API = 'https://api.line.me/v2/bot';

/** X-Line-Signature check: base64(HMAC-SHA256(channel secret, raw body)), compared in constant time. */
export async function verifySignature(secret: string, rawBody: string, signature: string | null): Promise<boolean> {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  const expected = btoa(bin);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export type Action = 'accept' | 'quick_ask' | 'quick_confirm' | 'reject_ask' | 'reject';
const ACTIONS: readonly Action[] = ['accept', 'quick_ask', 'quick_confirm', 'reject_ask', 'reject'];
/** What a card button sends back: the action, the order, the card (outbox row) it was on, and for a reject the reason number. */
export type Postback = { a: Action; o: string; c: string; r?: number };

export function encodePostback(p: Postback): string {
  const q = new URLSearchParams({ a: p.a, o: p.o, c: p.c });
  if (p.r !== undefined) q.set('r', String(p.r));
  return q.toString();
}

export function parsePostback(data: string): Postback | null {
  if (typeof data !== 'string' || data.length > 300) return null;
  const q = new URLSearchParams(data);
  const a = q.get('a') as Action | null, o = q.get('o'), c = q.get('c'), r = q.get('r');
  if (!a || !ACTIONS.includes(a) || !o || !UUID.test(o) || !c || !UUID.test(c)) return null;
  if (r === null) return { a, o, c };
  if (!/^[0-9]{1,2}$/.test(r)) return null;
  return { a, o, c, r: Number(r) };
}

export type SendResult = { ok: boolean; status: number; requestId: string | null; error: string | null };

/** LINE's answer → what the outbox does with the row. 409 = LINE already accepted a request with this retry key (an earlier attempt got through). */
export function classify(status: number): 'sent' | 'retry' | 'dead' {
  if ((status >= 200 && status < 300) || status === 409) return 'sent';
  if (status === 0 || status === 429 || status >= 500) return 'retry';
  return 'dead';
}

export function redact(text: string, secrets: (string | undefined | null)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

export function lineClient(token: string, fetchFn: typeof fetch) {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<SendResult & { json?: Record<string, unknown> }> {
    try {
      const res = await fetchFn(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json: Record<string, unknown> | undefined;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      const requestId = res.headers.get('x-line-request-id');
      if (res.ok) return { ok: true, status: res.status, requestId, error: null, json };
      const msg = typeof json?.message === 'string' ? json.message : text.slice(0, 200);
      return { ok: false, status: res.status, requestId, error: redact(`HTTP ${res.status}: ${msg}`, [token]) };
    } catch (e) {
      return { ok: false, status: 0, requestId: null, error: redact(e instanceof Error ? e.message : String(e), [token]) };
    }
  }
  const plain = ({ ok, status, requestId, error }: SendResult): SendResult => ({ ok, status, requestId, error });
  return {
    async push(to: string, messages: unknown[], retryKey: string): Promise<SendResult> {
      return plain(await call('POST', '/message/push', { to, messages }, { 'X-Line-Retry-Key': retryKey }));
    },
    async reply(replyToken: string, messages: unknown[]): Promise<SendResult> {
      return plain(await call('POST', '/message/reply', { replyToken, messages }));
    },
    async botInfo(): Promise<SendResult & { name?: string }> {
      const r = await call('GET', '/info');
      return { ...plain(r), name: typeof r.json?.displayName === 'string' ? r.json.displayName : undefined };
    },
    async profileName(userId: string): Promise<string | null> {
      const r = await call('GET', `/profile/${encodeURIComponent(userId)}`);
      return typeof r.json?.displayName === 'string' ? r.json.displayName : null;
    },
    async groupName(groupId: string): Promise<string | null> {
      const r = await call('GET', `/group/${encodeURIComponent(groupId)}/summary`);
      return typeof r.json?.groupName === 'string' ? r.json.groupName : null;
    },
  };
}

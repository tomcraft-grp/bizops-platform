// Request handling for the feedback-english-context Edge Function, with every outside dependency injected so it can be tested without Deno,
// Supabase or an AI service (tests/unit/feedbackContext.test.ts). index.ts wires the real ones.
//
//   POST { "issue_id": "FB-001234" }   Authorization: Bearer <the signed-in user's JWT>
//   -> 200 { status: 'completed' | 'failed' | 'processing', error?: 'CODE: message', already?: true }
//   -> 401 not signed in · 400 bad request · 404 issue not found / not yours · 405 wrong method
// A failed generation is NOT an HTTP error: the issue itself was already submitted; the status and reason are stored on the issue.
import { errorText, generateEnglishContext, type IssueFacts, type Provider } from './core.ts';

export type BeginResult =
  | { ok: true; facts: IssueFacts }
  | { ok: false; code: 'ALREADY_RUNNING' | 'ALREADY_DONE' | 'NOT_FOUND' | 'RATE_LIMITED' | 'ERROR'; message: string };

export interface Deps {
  /** Returns the user id of a valid Supabase JWT, or null. */
  verifyUser(jwt: string): Promise<string | null>;
  /** feedback_english_context_begin (service role) */
  begin(issueId: string, actor: string): Promise<BeginResult>;
  /** feedback_english_context_finish (service role) */
  finish(issueId: string, context: string | null, model: string, error: string | null): Promise<void>;
  /** null when no AI key is configured */
  provider: Provider | null;
  allowedOrigins: string[];
  secrets?: (string | undefined)[];
}

const ISSUE_ID = /^FB-\d{6,12}$/;

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/** Classifies the message of a Postgres error raised by feedback_english_context_begin. */
export function classifyBeginError(message: string): BeginResult & { ok: false } {
  if (/ALREADY_RUNNING/.test(message)) return { ok: false, code: 'ALREADY_RUNNING', message };
  if (/ALREADY_DONE/.test(message)) return { ok: false, code: 'ALREADY_DONE', message };
  if (/RATE_LIMITED/.test(message)) return { ok: false, code: 'RATE_LIMITED', message };
  if (/Feedback not found/i.test(message)) return { ok: false, code: 'NOT_FOUND', message };
  return { ok: false, code: 'ERROR', message };
}

export async function handleRequest(req: Request, d: Deps): Promise<Response> {
  const headers = corsHeaders(req.headers.get('Origin'), d.allowedOrigins);
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

  const auth = req.headers.get('Authorization') ?? '';
  const jwt = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!jwt) return reply(401, { error: 'Sign in first' });
  let actor: string | null = null;
  try { actor = await d.verifyUser(jwt); } catch { actor = null; }
  if (!actor) return reply(401, { error: 'Sign in first' });

  let issueId: unknown;
  try { ({ issue_id: issueId } = await req.json()); } catch { return reply(400, { error: 'Invalid JSON body' }); }
  if (typeof issueId !== 'string' || !ISSUE_ID.test(issueId)) return reply(400, { error: 'issue_id is required (FB-######)' });

  let begun: BeginResult;
  try { begun = await d.begin(issueId, actor); } catch (e) { begun = classifyBeginError((e as Error)?.message ?? 'error'); }
  if (!begun.ok) {
    if (begun.code === 'NOT_FOUND') return reply(404, { error: 'Feedback not found' });
    if (begun.code === 'RATE_LIMITED') return reply(429, { status: 'failed', error: 'RATE_LIMITED: too many attempts, ask the support team to regenerate it' });
    if (begun.code === 'ALREADY_RUNNING') return reply(200, { status: 'processing' });
    if (begun.code === 'ALREADY_DONE') return reply(200, { status: 'completed', already: true });
    return reply(500, { error: 'Could not start the generation' });
  }

  // From here on the issue is "processing": every path must end in finish(), or the 5-minute rule in the database frees it.
  const model = d.provider?.model ?? 'none';
  try {
    if (!d.provider) {
      const msg = 'AI_NOT_CONFIGURED: no AI key is set for this project (the administrator must add one)';
      await d.finish(issueId, null, model, msg);
      return reply(200, { status: 'failed', error: msg });
    }
    const out = await generateEnglishContext(begun.facts, d.provider);
    await d.finish(issueId, out.text, out.model, null);
    return reply(200, { status: 'completed' });
  } catch (e) {
    const msg = errorText(e, d.secrets ?? []);
    try { await d.finish(issueId, null, model, msg); } catch { /* the database frees a stale "processing" after 5 minutes */ }
    return reply(200, { status: 'failed', error: msg });
  }
}

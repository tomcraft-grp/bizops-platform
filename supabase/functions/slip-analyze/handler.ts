// Request handling for the slip-analyze Edge Function, with every outside dependency injected so it can be tested without Deno, Supabase or an AI service
// (tests/unit/slipAnalyze.test.ts). index.ts wires the real ones.
//
//   POST { "evidence_id": "<uuid>" }  or  { "invoice_id": "<uuid>" }     Authorization: Bearer <the signed-in user's JWT>
//   -> 200 { status: 'completed', result } | { status: 'failed', error: 'CODE: message' } | { status: 'nothing_to_do' }
//   -> 401 not signed in · 400 bad request · 404 slip not found / not yours · 405 wrong method · 500 the database could not start the attempt
// A failed reading is NOT an HTTP error: the order and the payment slip were already saved; the attempt is marked failed and the slip shows as manual review.
//
// begin() is the ONLY thing that decides who may analyse what (it knows the owner of the invoice and the staff roles); this file never reads the database.
// Every path after begin() ends in complete() or fail(). The expected amount, date and receiver of the order are never available here, so they cannot reach the model.
import { errorText, GenError, normalize, parseRaw, PROMPT_VERSION, scrub, toBase64, type Provider } from './core.ts';
import type { QrResult } from './qr.ts';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;         // the size limit of the payment-evidence bucket
const MAX_BODY_CHARS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const NO_QR: QrResult = { found: false, crc_ok: null, sending_bank: null, trans_ref: null };

export type BeginResult =
  | { ok: true; analysisId: string; evidenceId: string; filePath: string; fileType: string | null }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_DONE' | 'NOTHING_TO_DO' | 'AI_DISABLED' | 'ERROR'; message: string };

export interface Deps {
  /** Returns the user id of a valid Supabase JWT, or null. */
  verifyUser(jwt: string): Promise<string | null>;
  /** finance_analysis_begin (service role): authorises the caller and claims the waiting attempt. */
  begin(p: { evidenceId?: string; invoiceId?: string }, actor: string): Promise<BeginResult>;
  /** Reads the file from the private bucket by the path stored in the database. */
  download(path: string): Promise<Uint8Array>;
  /** Decodes the slip QR. Must not throw (the handler also guards against it). */
  decodeQr(bytes: Uint8Array, mediaType: string): QrResult | Promise<QrResult>;
  /** null when no AI key is configured */
  provider: Provider | null;
  /** finance_analysis_complete (service role) */
  complete(analysisId: string, extracted: unknown, qr: unknown, confidence: number, signals: unknown[], engine: string, promptVersion: string): Promise<{ result: string }>;
  /** finance_analysis_fail (service role) */
  fail(analysisId: string, error: string, engine: string): Promise<void>;
  allowedOrigins: string[];
  secrets?: (string | undefined)[];
  /** the clock (tests); defaults to the real time */
  now?: () => Date;
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

/** Classifies the message of a Postgres error raised by finance_analysis_begin. */
export function classifyBeginError(message: string): BeginResult & { ok: false } {
  if (/NOT_FOUND/.test(message)) return { ok: false, code: 'NOT_FOUND', message };
  if (/ALREADY_DONE/.test(message)) return { ok: false, code: 'ALREADY_DONE', message };
  if (/NOTHING_TO_DO/.test(message)) return { ok: false, code: 'NOTHING_TO_DO', message };
  if (/AI_DISABLED/.test(message)) return { ok: false, code: 'AI_DISABLED', message };
  return { ok: false, code: 'ERROR', message };
}

/** The type of a file by its first bytes (the name and the declared type are not trusted): only JPEG, PNG and PDF are read. */
export function sniffMediaType(b: Uint8Array): 'image/png' | 'image/jpeg' | 'application/pdf' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  return null;
}

/** What comes back from the decoder, reduced to the four fields the database reads. */
function cleanQr(r: QrResult | null | undefined): QrResult {
  if (!r || r.found !== true) return { ...NO_QR };
  return {
    found: true,
    crc_ok: typeof r.crc_ok === 'boolean' ? r.crc_ok : null,
    sending_bank: typeof r.sending_bank === 'string' ? r.sending_bank.slice(0, 16) : null,
    trans_ref: typeof r.trans_ref === 'string' ? r.trans_ref.slice(0, 64) : null,
  };
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

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_CHARS) return reply(400, { error: 'Request too large' });
    body = JSON.parse(raw);
  } catch { return reply(400, { error: 'Invalid JSON body' }); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(400, { error: 'Invalid JSON body' });
  const b = body as Record<string, unknown>;
  const id = (v: unknown): string | undefined | false => (v === undefined || v === null ? undefined : typeof v === 'string' && UUID.test(v) ? v : false);
  const evidenceId = id(b.evidence_id), invoiceId = id(b.invoice_id);
  if (evidenceId === false || invoiceId === false || (evidenceId === undefined && invoiceId === undefined)) {
    return reply(400, { error: 'evidence_id or invoice_id is required (a UUID)' });
  }

  let begun: BeginResult;
  try { begun = await d.begin({ evidenceId, invoiceId }, actor); } catch (e) { begun = classifyBeginError((e as Error)?.message ?? 'error'); }
  if (!begun.ok) {
    if (begun.code === 'NOT_FOUND') return reply(404, { error: 'Slip not found' });
    if (begun.code === 'ERROR') return reply(500, { error: 'Could not start the analysis' });
    return reply(200, { status: 'nothing_to_do' });                                    // already analysed, nothing waiting, or the AI review is off
  }

  // From here on the attempt is "running": every path must end in complete() or fail(), or the 5-minute rule in the database frees it.
  const analysisId = begun.analysisId;
  const engine = d.provider?.model ?? 'none';
  const secrets = d.secrets ?? [];
  let settled = false;
  try {
    if (!d.provider) throw new GenError('AI_NOT_CONFIGURED', 'no AI key is set for this project (the administrator must add one)');
    if (begun.fileType !== null && begun.fileType !== undefined && !ALLOWED_TYPES.includes(begun.fileType)) throw new GenError('UNSUPPORTED_TYPE', 'only JPG, PNG and PDF slips are read');

    let bytes: Uint8Array;
    try { bytes = await d.download(begun.filePath); }
    catch (e) {
      if (e instanceof GenError) throw e;
      throw new GenError('FILE_UNAVAILABLE', scrub((e as Error)?.message || 'the slip file could not be read', secrets));
    }
    if (bytes.length > MAX_FILE_BYTES) throw new GenError('FILE_TOO_LARGE', 'the slip file is larger than 5 MB');
    const mediaType = sniffMediaType(bytes);
    if (!mediaType) throw new GenError('UNSUPPORTED_TYPE', 'the slip file is not a JPG, PNG or PDF');

    let qr: QrResult = { ...NO_QR };
    try { qr = cleanQr(await d.decodeQr(bytes, mediaType)); } catch { qr = { ...NO_QR }; }      // a QR that cannot be decoded is just "not checked"

    const reading = await d.provider.extract({ mediaType, base64: toBase64(bytes) });
    const { extracted, signals, confidence } = normalize(parseRaw(reading), (d.now ?? (() => new Date()))());
    const done = await d.complete(analysisId, extracted, qr, confidence, signals, engine, PROMPT_VERSION);
    settled = true;
    return reply(200, { status: 'completed', result: done.result });
  } catch (e) {
    let msg = 'AI_ERROR: unknown error';
    try { msg = errorText(e, secrets); } catch { /* keep the generic text */ }
    try { await d.fail(analysisId, msg, engine); } catch { /* the database frees a stale "running" attempt after 5 minutes */ }
    settled = true;
    return reply(200, { status: 'failed', error: msg });
  } finally {
    if (!settled) { try { await d.fail(analysisId, 'AI_ERROR: the analysis stopped unexpectedly', engine); } catch { /* as above */ } }
  }
}

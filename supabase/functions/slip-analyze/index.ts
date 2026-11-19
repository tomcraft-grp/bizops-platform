// Supabase Edge Function: read a payment slip with AI and store what it found (a pre-check for the person who confirms the payment, never a decision).
//   1. verifies the caller's JWT (the customer who owns the order, or finance staff),
//   2. claims the waiting analysis in the database (finance_analysis_begin decides who may; it returns the slip's file path),
//   3. downloads the slip from the private bucket, decodes its QR code here (JPG/PNG; a PDF is not QR-checked),
//   4. sends the picture to Claude Haiku 5.5 with an extraction-only prompt and a JSON schema. The expected amount, date and receiver are NEVER sent, no tools,
//   5. validates and normalises the reply (Buddhist year, Thai month, two-digit year, Asia/Bangkok) and stores it with finance_analysis_complete,
//      which lets the SQL classifier label it. A failure of any step is stored with finance_analysis_fail: the slip then shows as manual review.
// It writes ONLY through the three RPCs finance_analysis_begin / finance_analysis_complete / finance_analysis_fail (service role): never a direct table write.
//
// Needs ai_review_enabled to be on in finance_settings (off by default; a manager switches it on): while it is off, finance_analysis_begin answers
// AI_DISABLED and this function answers { status: 'nothing_to_do' } without reading the file or calling the AI.
//
// Secret (never in the browser, never in git):
//   supabase secrets set ANTHROPIC_API_KEY=...
// Deploy (verify_jwt stays ON): supabase functions deploy slip-analyze --project-ref hlvravynjalculvplrxc
// Without a key every attempt is stored as failed with AI_NOT_CONFIGURED and the slip shows as manual review; nobody is blocked.
// deno.json next to this file maps the bare imports (jsqr, pngjs, jpeg-js) used by qr.ts.
import { createClient } from 'npm:@supabase/supabase-js@2.49.1';
import { GenError, selectProvider } from './core.ts';
import { classifyBeginError, handleRequest, MAX_FILE_BYTES, type BeginResult } from './handler.ts';
import { decodeSlipQr } from './qr.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const env = Deno.env.toObject();
const provider = selectProvider(env, (url, init) => fetch(url, init));

Deno.serve((req) => handleRequest(req, {
  provider,
  allowedOrigins: ['https://tomcraft-grp.github.io', 'http://localhost:5173'],
  secrets: [env.ANTHROPIC_API_KEY, env.SUPABASE_SERVICE_ROLE_KEY],
  decodeQr: decodeSlipQr,
  async verifyUser(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    return error || !data.user ? null : data.user.id;
  },
  async begin(p, actor): Promise<BeginResult> {
    const { data, error } = await admin.rpc('finance_analysis_begin', { p_evidence: p.evidenceId ?? null, p_invoice: p.invoiceId ?? null, p_actor: actor });
    if (error) return classifyBeginError(error.message);
    if (!data?.analysis_id || !data?.file_path) return { ok: false, code: 'ERROR', message: 'finance_analysis_begin returned no analysis' };
    return { ok: true, analysisId: data.analysis_id, evidenceId: data.evidence_id, filePath: data.file_path, fileType: data.file_type ?? null };
  },
  async download(path) {
    const { data, error } = await admin.storage.from('payment-evidence').download(path);
    if (error || !data) throw new Error(error?.message || 'file not found');
    if (data.size > MAX_FILE_BYTES) throw new GenError('FILE_TOO_LARGE', 'the slip file is larger than 5 MB');
    return new Uint8Array(await data.arrayBuffer());
  },
  async complete(analysisId, extracted, qr, confidence, signals, engine, promptVersion) {
    const { data, error } = await admin.rpc('finance_analysis_complete', {
      p_analysis: analysisId, p_extracted: extracted, p_qr: qr, p_confidence: confidence, p_signals: signals, p_engine: engine, p_prompt_version: promptVersion,
    });
    if (error) throw new Error(error.message);
    return { result: String(data?.result ?? '') };
  },
  async fail(analysisId, error, engine) {
    const { error: e } = await admin.rpc('finance_analysis_fail', { p_analysis: analysisId, p_error: error, p_engine: engine });
    if (e) throw new Error(e.message);
  },
}));

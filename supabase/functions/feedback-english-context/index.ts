// Supabase Edge Function: generate the English technical context of a feedback issue.
//   1. verifies the caller's JWT (a signed-in customer or staff member),
//   2. claims the generation in the database (only the reporter or staff may; one run at a time),
//   3. asks the configured AI service for the nine-section English brief (the issue text is sent as data, screenshots are NOT sent),
//   4. stores the text, or the failure reason, on the issue. The original description is never changed.
//
// Secrets (never in the browser, never in git):
//   supabase secrets set ANTHROPIC_API_KEY=...                     # default provider
//   supabase secrets set AI_PROVIDER=openai AI_API_KEY=... AI_MODEL=... AI_BASE_URL=...   # any OpenAI-compatible service instead
//   supabase secrets set AI_MODEL=claude-sonnet-5-5                # optional (that is the default for Anthropic)
// Deploy (verify_jwt stays ON): supabase functions deploy feedback-english-context --project-ref <ref>
// Without a key the function answers { status: 'failed', error: 'AI_NOT_CONFIGURED: ...' } and the issue shows that, with a Retry button.
import { createClient } from 'npm:@supabase/supabase-js@2.49.1';
import { selectProvider } from './core.ts';
import { classifyBeginError, handleRequest, type BeginResult } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const env = Deno.env.toObject();
const provider = selectProvider(env, (url, init) => fetch(url, init));

Deno.serve((req) => handleRequest(req, {
  provider,
  allowedOrigins: ['https://tomcraft-grp.github.io', 'http://localhost:5173'],
  secrets: [env.ANTHROPIC_API_KEY, env.AI_API_KEY],
  async verifyUser(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    return error || !data.user ? null : data.user.id;
  },
  async begin(issueId, actor): Promise<BeginResult> {
    const { data, error } = await admin.rpc('feedback_english_context_begin', { p_issue: issueId, p_actor: actor });
    if (error) return classifyBeginError(error.message);
    return { ok: true, facts: data };
  },
  async finish(issueId, context, model, error) {
    const { error: e } = await admin.rpc('feedback_english_context_finish', { p_issue: issueId, p_context: context, p_model: model, p_error: error });
    if (e) throw new Error(e.message);
  },
}));

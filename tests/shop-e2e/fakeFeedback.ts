// A fake of the feedback endpoints for browser tests of the screenshot paste / English-context UI. It mirrors the contracts that
// supabase/tests/feedback_permissions.sql and supabase/tests/feedback_english_context.sql prove against the real database (who may read what,
// one generation at a time, 3 attempts for customers, uploads must exist before they are recorded) and a switchable FAKE AI for the Edge
// Function. This file proves the SCREENS; it proves nothing about the database, the storage policies or a real AI model.
// Install it AFTER FakeShop.install(page): it handles the feedback paths and passes everything else on (route.fallback).
import type { Page, Route } from '@playwright/test';
import { FakeShop, USER_ID } from './fakeBackend';

const HOST = 'hlvravynjalculvplrxc.supabase.co';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

export interface FIssue {
  id: string; title: string; description: string; category: string; priority: string; status: string; source: 'staff' | 'customer'; app_id: string; reporter_id: string | null;
  submitter_label: string; assigned_to: string | null; page_name: string; page_path: string; module_name: string | null; environment: string; browser_info: string;
  os_info: string | null; device_type: string | null; app_version: string | null; root_cause: string | null; resolution: string | null; remark: string | null;
  created_at: string; updated_at: string; last_activity_at: string; resolved_at: string | null; archived_at: string | null; idempotency_key?: string;
  english_context?: string | null; english_context_status?: string; english_context_error?: string | null; english_context_at?: string | null; english_context_source?: string | null;
  english_context_model?: string | null; english_context_attempts?: number; english_context_started_at?: string | null;
}
interface FAtt { id: string; issue_id: string; comment_id: string | null; storage_path: string; file_name: string; mime_type: string; size_bytes: number; created_at: string }
export type AiMode = 'ok' | 'fail' | 'not_configured' | 'not_deployed';

export class FakeFeedback {
  issues: FIssue[] = [];
  attachments: FAtt[] = [];
  /** files in the storage bucket: path -> bytes and type, as uploaded by the browser */
  files = new Map<string, { type: string; bytes: Buffer }>();
  uploads: { path: string; type: string; size: number }[] = [];
  signed: { path: string; expiresIn: number }[] = [];
  functionCalls: { issue_id: string; authorised: boolean; status: number }[] = [];
  rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  ai: AiMode = 'ok';
  aiDelayMs = 0;
  private seq = 1000;
  private n = 0;

  private shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }
  get staff() { return this.shop.profile.role === 'ADMIN' || this.shop.profile.role === 'SUPER_ADMIN'; }
  issue = (id: string) => this.issues.find((i) => i.id === id);

  /** an issue that existed before the English-context feature: its row has none of the new columns */
  seedLegacy(over: Partial<FIssue> = {}): FIssue {
    const id = `FB-00${++this.seq}`;
    const now = new Date(Date.now() - 86400_000).toISOString();
    const row: FIssue = { id, title: 'ข้อความเก่า', description: 'ปุ่มค้นหากดแล้วไม่มีอะไรเกิดขึ้น', category: 'bug', priority: 'medium', status: 'submitted', source: 'staff', app_id: 'backoffice', reporter_id: OTHER_USER_ID,
      submitter_label: 'Old Reporter', assigned_to: null, page_name: 'Products', page_path: '/products', module_name: null, environment: 'production', browser_info: 'Chrome', os_info: 'Windows NT 10.0', device_type: 'desktop',
      app_version: '0.1.0', root_cause: null, resolution: null, remark: null, created_at: now, updated_at: now, last_activity_at: now, resolved_at: null, archived_at: null, ...over };
    this.issues.push(row);
    return row;
  }
  /** an attachment that is already stored for an issue (a 1x1 PNG, or any bytes) */
  seedAttachment(issueId: string, name: string, bytes = PNG_1x1, type = 'image/png'): FAtt {
    const path = `${issueId}/00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}.${type === 'application/pdf' ? 'pdf' : type.split('/')[1]}`;
    this.files.set(path, { type, bytes });
    const a: FAtt = { id: `att-${this.n}`, issue_id: issueId, comment_id: null, storage_path: path, file_name: name, mime_type: type, size_bytes: bytes.length, created_at: new Date().toISOString() };
    this.attachments.push(a);
    return a;
  }

  // ------------------------------------------------------------ the database contract
  private err(message: string): never { throw new Error(message); }
  private visible(i: FIssue) { return this.staff || i.reporter_id === USER_ID; }

  rpc(fn: string, a: Record<string, unknown>): unknown {
    this.rpcCalls.push({ fn, args: a });
    switch (fn) {
      case 'feedback_submit': {
        const key = String(a.p_idempotency_key ?? '');
        const have = this.issues.find((i) => i.idempotency_key === key && i.reporter_id === USER_ID);
        if (have) return have;
        if (!String(a.p_description ?? '').trim()) this.err('Please describe the problem or suggestion');
        const id = `FB-00${++this.seq}`; const now = new Date().toISOString();
        const row: FIssue = { id, title: String(a.p_subject || '').trim() || String(a.p_description).trim().slice(0, 80), description: String(a.p_description), category: String(a.p_category), priority: String(a.p_priority),
          status: 'submitted', source: a.p_app_id === 'backoffice' ? 'staff' : 'customer', app_id: String(a.p_app_id), reporter_id: USER_ID, submitter_label: this.shop.profile.display_name ?? 'User', assigned_to: null,
          page_name: String(a.p_page_name ?? ''), page_path: String(a.p_page_path ?? ''), module_name: (a.p_module as string) ?? null, environment: String(a.p_environment ?? ''), browser_info: String(a.p_browser ?? ''),
          os_info: (a.p_os as string) ?? null, device_type: (a.p_device_type as string) ?? null, app_version: (a.p_app_version as string) ?? null, root_cause: null, resolution: null, remark: null,
          created_at: now, updated_at: now, last_activity_at: now, resolved_at: null, archived_at: null, idempotency_key: key,
          english_context: null, english_context_status: 'pending', english_context_error: null, english_context_at: null, english_context_source: null, english_context_model: null, english_context_attempts: 0, english_context_started_at: null };
        this.issues.push(row);
        return row;
      }
      case 'feedback_add_attachment': {
        const i = this.issue(String(a.p_issue)); if (!i || !this.visible(i)) this.err('Feedback not found');
        const path = String(a.p_path);
        if (!path.startsWith(`${i.id}/`)) this.err('Invalid file');
        if (!this.files.has(path)) this.err('Upload the file before attaching it');           // the real function checks the storage object exists
        const att: FAtt = { id: `att-${++this.n}`, issue_id: i.id, comment_id: (a.p_comment as string) ?? null, storage_path: path, file_name: String(a.p_name), mime_type: String(a.p_mime), size_bytes: Number(a.p_size), created_at: new Date().toISOString() };
        this.attachments.push(att);
        return att;
      }
      case 'feedback_set_english_context': {
        if (!this.staff) this.err('Only support staff can change the English context');
        const i = this.issue(String(a.p_issue)); if (!i) this.err('Feedback not found');
        const text = String(a.p_context ?? '').trim();
        if (!text || text.length > 20000) this.err('The English context must be 1 to 20,000 characters');
        Object.assign(i, { english_context: text, english_context_status: 'completed', english_context_error: null, english_context_at: new Date().toISOString(), english_context_source: 'manual', english_context_model: null });
        return i;
      }
      case 'feedback_staff_list': return [];
      case 'feedback_mark_read': return null;
      default: this.err(`Unknown function ${fn}`);
    }
  }

  /** the Edge Function: verifies the caller, claims the generation (feedback_english_context_begin) and finishes it with the fake AI */
  async generate(issueId: string, authorised: boolean): Promise<{ status: number; body: unknown }> {
    if (this.ai === 'not_deployed') return { status: 404, body: { code: 'NOT_FOUND', message: 'Requested function was not found' } };
    if (!authorised) return { status: 401, body: { error: 'Sign in first' } };
    const i = this.issue(issueId);
    if (!i || !this.visible(i)) return { status: 404, body: { error: 'Feedback not found' } };
    const started = i.english_context_started_at ? Date.parse(i.english_context_started_at) : 0;
    if (i.english_context_status === 'processing' && Date.now() - started < 300_000) return { status: 200, body: { status: 'processing' } };
    if (i.english_context_status === 'completed' && !this.staff) return { status: 200, body: { status: 'completed', already: true } };
    if (!this.staff && (i.english_context_attempts ?? 0) >= 3) return { status: 429, body: { status: 'failed', error: 'RATE_LIMITED: too many attempts, ask the support team to regenerate it' } };
    Object.assign(i, { english_context_status: 'processing', english_context_error: null, english_context_started_at: new Date().toISOString(), english_context_attempts: (i.english_context_attempts ?? 0) + 1 });
    if (this.aiDelayMs) await new Promise((r) => setTimeout(r, this.aiDelayMs));
    if (this.ai === 'not_configured') { Object.assign(i, { english_context_status: 'failed', english_context_error: 'AI_NOT_CONFIGURED: no AI key is set for this project (the administrator must add one)' }); return { status: 200, body: { status: 'failed', error: i.english_context_error } }; }
    if (this.ai === 'fail') { Object.assign(i, { english_context_status: 'failed', english_context_error: 'AI_HTTP_500: the AI service had an internal error' }); return { status: 200, body: { status: 'failed', error: i.english_context_error } }; }
    const files = this.attachments.filter((x) => x.issue_id === i.id && !x.comment_id).map((x) => x.file_name);
    Object.assign(i, { english_context: this.fakeEnglish(i, files), english_context_status: 'completed', english_context_error: null, english_context_at: new Date().toISOString(), english_context_source: 'ai', english_context_model: 'fake-model' });
    return { status: 200, body: { status: 'completed' } };
  }
  /** what a correct answer looks like: nine sections, identifiers kept, "Not provided" where the report says nothing */
  private fakeEnglish(i: FIssue, files: string[]) {
    const ids = i.description.match(/\b[A-Z]{2,3}-\d{4,}\b/g)?.join(', ');
    return ['## Issue Title', `Report ${i.id}: ${i.title}`, '', '## Background', `- Page: ${i.page_name} (${i.page_path})`, '', '## Problem Description', `Reporter's words (translated): ${i.description.slice(0, 60)}`, '',
      '## Expected Behavior', 'Not provided', '', '## Actual Behavior', ids ? `Concerns ${ids}.` : 'Not provided', '', '## Impact', `Reported priority: ${i.priority}`, '',
      '## Technical Evidence', files.length ? `- Attached screenshots/files (not analysed): ${files.join(', ')}` : '- No files attached', '', '## Implementation Requirements', 'Not provided', '', '## Acceptance Criteria', 'Not provided'].join('\n');
  }

  rest(table: string, url: URL): unknown[] | undefined {
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, '');
    switch (table) {
      case 'bizops_feedback_issues': return this.issues.filter((i) => this.visible(i) && !i.archived_at);
      case 'feedback_attachments': return this.attachments.filter((a) => a.issue_id === eq('issue_id') && this.visible(this.issue(a.issue_id)!));
      case 'feedback_comments': case 'feedback_dev_links': case 'feedback_events': case 'feedback_notifications': return [];
      default: return undefined;
    }
  }

  // ------------------------------------------------------------ wiring
  async install(page: Page) {
    const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    await page.route(`https://${HOST}/**`, async (route) => {
      const req = route.request(); const url = new URL(req.url()); const p = url.pathname;
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      // the Edge Function
      if (p === '/functions/v1/feedback-english-context') {
        const authorised = /^Bearer \S+/.test(req.headers().authorization ?? '');
        let issueId = ''; try { issueId = (JSON.parse(req.postData() || '{}') as { issue_id?: string }).issue_id ?? ''; } catch { /* none */ }
        const out = await this.generate(issueId, authorised);
        this.functionCalls.push({ issue_id: issueId, authorised, status: out.status });
        return json(route, out.body, out.status);
      }
      // feedback RPCs
      if (p.startsWith('/rest/v1/rpc/feedback_')) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(req.postData() || '{}') as Record<string, unknown>; } catch { /* none */ }
        try { return json(route, this.rpc(p.slice('/rest/v1/rpc/'.length), args)); }
        catch (e) { return json(route, { code: 'P0001', message: (e as Error).message, details: null, hint: null }, 400); }
      }
      // feedback tables
      if (p.startsWith('/rest/v1/') && req.method() === 'GET') {
        const rows = this.rest(p.slice('/rest/v1/'.length), url);
        if (rows) return json(route, rows);
      }
      // the private bucket: upload, signed link, file
      const BUCKET = 'feedback-attachments';
      if (p.startsWith(`/storage/v1/object/${BUCKET}/`) && req.method() === 'POST') {
        const path = decodeURIComponent(p.slice(`/storage/v1/object/${BUCKET}/`.length));
        const issue = this.issue(path.split('/')[0]);
        if (!issue || !this.visible(issue)) return json(route, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }, 403);
        const buf = req.postDataBuffer() ?? Buffer.alloc(0);
        const head = buf.indexOf(Buffer.from('\r\n\r\n', 'latin1'), buf.indexOf(Buffer.from('filename=', 'latin1')));
        const partHeaders = buf.subarray(0, head).toString('latin1');
        const type = /Content-Type:\s*([^\r\n]+)\s*$/i.exec(partHeaders)?.[1]?.trim() ?? 'application/octet-stream';
        const boundary = /boundary=(.+)$/.exec(req.headers()['content-type'] ?? '')?.[1] ?? '';
        const end = buf.lastIndexOf(Buffer.from(`\r\n--${boundary}`, 'latin1'));
        const bytes = buf.subarray(head + 4, end > head ? end : buf.length);
        if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(type)) return json(route, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` }, 415);
        if (bytes.length > 10 * 1024 * 1024) return json(route, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }, 413);
        this.files.set(path, { type, bytes }); this.uploads.push({ path, type, size: bytes.length });
        return json(route, { Key: `${BUCKET}/${path}`, Id: path });
      }
      if (p.startsWith(`/storage/v1/object/sign/${BUCKET}/`) && req.method() === 'POST') {
        const path = decodeURIComponent(p.slice(`/storage/v1/object/sign/${BUCKET}/`.length));
        let expiresIn = 0; try { expiresIn = (JSON.parse(req.postData() || '{}') as { expiresIn?: number }).expiresIn ?? 0; } catch { /* none */ }
        const a = this.attachments.find((x) => x.storage_path === path);
        if (!a || !this.visible(this.issue(a.issue_id)!)) return json(route, { statusCode: '404', error: 'not_found', message: 'Object not found' }, 400);
        this.signed.push({ path, expiresIn });
        return json(route, { signedURL: `/object/sign/${BUCKET}/${encodeURI(path)}?token=t${expiresIn}` });
      }
      if (p.startsWith(`/storage/v1/object/sign/${BUCKET}/`)) {
        const f = this.files.get(decodeURIComponent(p.slice(`/storage/v1/object/sign/${BUCKET}/`.length)));
        if (!f) return json(route, { error: 'not_found' }, 404);
        const dl = url.searchParams.get('download');
        return route.fulfill({ status: 200, contentType: f.type, headers: { ...cors, ...(dl !== null ? { 'content-disposition': `attachment; filename="${dl}"` } : {}) }, body: f.bytes });
      }
      return route.fallback();
    });
  }
}

export const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

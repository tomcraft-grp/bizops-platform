// A fake of the feedback endpoints for browser tests of the screenshot paste / English version UI. It mirrors the contracts that
// supabase/tests/feedback_permissions.sql and supabase/tests/feedback_english_context.sql prove against the real database (who may read what,
// uploads must exist before they are recorded, only staff save the English text, its source is 'manual' or 'translation').
// This file proves the SCREENS; it proves nothing about the database or the storage policies.
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

export class FakeFeedback {
  issues: FIssue[] = [];
  attachments: FAtt[] = [];
  /** files in the storage bucket: path -> bytes and type, as uploaded by the browser */
  files = new Map<string, { type: string; bytes: Buffer }>();
  uploads: { path: string; type: string; size: number }[] = [];
  signed: { path: string; expiresIn: number }[] = [];
  rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  private seq = 1000;
  private n = 0;
  private shop: FakeShop;
  constructor(shop: FakeShop) { this.shop = shop; }
  get staff() { return this.shop.profile.role === 'ADMIN' || this.shop.profile.role === 'SUPER_ADMIN'; }
  issue = (id: string) => this.issues.find((i) => i.id === id);
  count = (fn: string) => this.rpcCalls.filter((c) => c.fn === fn).length;

  /** an issue that existed before the English version feature: its row has none of the new columns */
  seedLegacy(over: Partial<FIssue> = {}): FIssue {
    const id = `FB-00${++this.seq}`;
    const now = new Date(Date.now() - 86400_000).toISOString();
    const row: FIssue = { id, title: 'ข้อความเก่า', description: 'ปุ่มค้นหากดแล้วไม่มีอะไรเกิดขึ้น', category: 'bug', priority: 'medium', status: 'submitted', source: 'staff', app_id: 'backoffice', reporter_id: OTHER_USER_ID,
      submitter_label: 'Old Reporter', assigned_to: null, page_name: 'Products', page_path: '/products', module_name: null, environment: 'production', browser_info: 'Chrome', os_info: 'Windows NT 10.0', device_type: 'desktop',
      app_version: '0.1.0', root_cause: null, resolution: null, remark: null, created_at: now, updated_at: now, last_activity_at: now, resolved_at: null, archived_at: null, ...over };
    this.issues.push(row);
    return row;
  }
  /** an issue whose English version was saved earlier */
  seedEnglish(issueId: string, text: string, source: 'translation' | 'manual' | 'ai' = 'translation') {
    Object.assign(this.issue(issueId)!, { english_context: text, english_context_status: 'completed', english_context_error: null, english_context_at: new Date().toISOString(), english_context_source: source, english_context_model: null, english_context_attempts: 0 });
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
        const source = a.p_source === undefined ? 'manual' : String(a.p_source);
        if (!['manual', 'translation'].includes(source)) this.err('Unknown source');
        const i = this.issue(String(a.p_issue)); if (!i) this.err('Feedback not found');
        const text = String(a.p_context ?? '').trim();
        if (!text || text.length > 20000) this.err('The English context must be 1 to 20,000 characters');
        Object.assign(i, { english_context: text, english_context_status: 'completed', english_context_error: null, english_context_at: new Date().toISOString(), english_context_source: source, english_context_model: null });
        return i;
      }
      case 'feedback_staff_list': return [];
      case 'feedback_mark_read': return null;
      default: this.err(`Unknown function ${fn}`);
    }
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

// ------------------------------------------------------------ a fake of Chrome's built-in Translator API (the real model cannot be downloaded in the test browser)
export interface FakeTranslatorOptions {
  /** what Translator.availability() answers; null = this browser has no Translator at all */
  state: 'available' | 'downloadable' | 'unavailable' | null;
  delayMs?: number;          // time one translate() call takes
  failTimes?: number;        // the first N translate() calls throw
}
export async function installFakeTranslator(page: Page, o: FakeTranslatorOptions) {
  await page.addInitScript((opts) => {
    // the test browser (Chrome 138+) has a REAL Translator: for "no translator" it must be removed, otherwise the real one answers
    if (opts.state === null) { Object.defineProperty(window, 'Translator', { value: undefined, configurable: true, writable: true }); return; }
    const w = window as unknown as Record<string, unknown>;
    w.__tr = { state: opts.state, fail: opts.failTimes ?? 0, creates: 0, calls: [] as string[], downloads: 0 };
    const tr = w.__tr as { state: string; fail: number; creates: number; calls: string[]; downloads: number };
    const dict: [string, string][] = [
      ['ที่หน้า สินค้า กดบันทึก', 'On the Products page, pressing Save'], ['แล้วขึ้น error', 'then shows an error'], ['บรรทัดที่สอง   มีช่องว่างหลายตัว', 'Second line with several spaces'],
      ['ปุ่มบันทึกกดไม่ได้', 'The Save button cannot be pressed'], ['ปุ่มค้นหากดแล้วไม่มีอะไรเกิดขึ้น', 'Nothing happens when the search button is pressed'], ['ข้อความเก่า', 'Old message'],
      ['อยากให้ แสดงออเดอร์ทุกช่องทาง', 'Please show orders from every channel'],
    ];
    (w as { Translator: unknown }).Translator = {
      availability: async () => tr.state,
      create: async (o: { monitor?: (m: EventTarget) => void }) => {
        tr.creates++;
        if (tr.state === 'downloadable') {                         // the first use downloads the language pack, with progress
          const m = new EventTarget(); o.monitor?.(m);
          for (const f of [0.25, 0.75, 1]) { await new Promise((r) => setTimeout(r, 300)); const e = new Event('downloadprogress') as Event & { loaded: number }; e.loaded = f; m.dispatchEvent(e); }
          tr.state = 'available'; tr.downloads++;
        }
        return {
          translate: async (s: string) => {
            tr.calls.push(s);
            if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
            if (tr.fail > 0) { tr.fail--; throw new Error('the translator crashed'); }
            return dict.reduce((acc, [th, en]) => acc.split(th).join(en), s);
          },
          destroy: () => undefined,
        };
      },
    };
  }, o);
}

// DEV APP Customer data access. Everything goes through the signed-in user's Supabase session, so RLS and the
// SECURITY DEFINER workflow functions (supabase/migrations/*_customer_app_designer.sql) decide what is allowed.
import { supabase } from '../lib/supabase';
import type { Binding, BindingFilter, LayoutConfig } from './schema';
import type { ColumnDef, QueryResult, SourceDef } from './datasources';

export type AppRole = 'viewer' | 'designer' | 'approver' | 'publisher' | 'admin';
export type VersionStatus = 'draft' | 'applied' | 'approved' | 'published' | 'superseded' | 'rejected';
export interface CustomerApp { id: string; name: string; description: string | null; published_version_id: string | null }
export interface LayoutVersion {
  id: string; app_id: string; version_no: number; status: VersionStatus; name: string; note: string | null; config: LayoutConfig;
  based_on: string | null; created_by: string | null; created_by_email: string | null; created_at: string; updated_at: string;
  applied_at: string | null; reviewed_at: string | null; review_note: string | null; published_at: string | null;
}
export interface Deployment {
  id: string; app_id: string; version_id: string | null; from_version_id: string | null; action: 'deploy' | 'rollback';
  status: 'succeeded' | 'failed'; message: string | null; error: string | null; actor_email: string | null; created_at: string;
}
export interface Template { id: string; name: string; description: string | null; config: LayoutConfig; created_by_email: string | null; created_at: string }
export interface StaffRow { user_id: string; email: string; display_name: string | null; profile_role: string; app_role: AppRole | null }

const RANK: Record<AppRole, number> = { viewer: 1, designer: 2, approver: 3, publisher: 4, admin: 5 };
export type Capability = 'view' | 'edit' | 'approve' | 'deploy' | 'admin';
const NEED: Record<Capability, number> = { view: 1, edit: 2, approve: 3, deploy: 4, admin: 5 };
/** UI hint only — the database enforces the same rule (public.customer_app_can). */
export const canDo = (role: AppRole | null, cap: Capability) => !!role && RANK[role] >= NEED[cap];

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export const devapp = {
  async myRole(): Promise<AppRole | null> { return must(await supabase.rpc('customer_app_my_role'), 'Load your DEV APP role') as AppRole | null; },
  async apps(): Promise<CustomerApp[]> { return must(await supabase.from('customer_apps').select('*').order('name'), 'Load apps'); },
  async versions(appId: string): Promise<LayoutVersion[]> {
    return must(await supabase.from('customer_app_layouts').select('*').eq('app_id', appId).order('version_no', { ascending: false }), 'Load versions');
  },
  async version(id: string): Promise<LayoutVersion | null> {
    const r = await supabase.from('customer_app_layouts').select('*').eq('id', id).maybeSingle();
    return must(r, 'Load version');
  },
  async createDraft(appId: string, config: LayoutConfig, name: string, basedOn: string | null): Promise<LayoutVersion> {
    // version_no / status / author are set by the database trigger
    return must(await supabase.from('customer_app_layouts').insert({ app_id: appId, version_no: 0, config, name, based_on: basedOn }).select('*').single(), 'Save draft');
  },
  async saveDraft(id: string, config: LayoutConfig, name: string): Promise<LayoutVersion> {
    return must(await supabase.from('customer_app_layouts').update({ config, name }).eq('id', id).eq('status', 'draft').select('*').single(), 'Save draft');
  },
  async deleteDraft(id: string) { must(await supabase.from('customer_app_layouts').delete().eq('id', id).eq('status', 'draft'), 'Delete draft'); },
  async apply(id: string): Promise<LayoutVersion> { return must(await supabase.rpc('customer_app_apply', { p_version: id }), 'Apply'); },
  async review(id: string, approve: boolean, note: string): Promise<LayoutVersion> {
    return must(await supabase.rpc('customer_app_review', { p_version: id, p_approve: approve, p_note: note || null }), approve ? 'Approve' : 'Reject');
  },
  async deploy(id: string, message: string): Promise<Deployment> { return must(await supabase.rpc('customer_app_deploy', { p_version: id, p_message: message || null }), 'Deploy'); },
  async rollback(id: string, message: string): Promise<Deployment> { return must(await supabase.rpc('customer_app_rollback', { p_version: id, p_message: message || null }), 'Roll back'); },
  async deployments(appId: string): Promise<Deployment[]> {
    return must(await supabase.from('customer_app_deployments').select('*').eq('app_id', appId).order('created_at', { ascending: false }).limit(100), 'Load deployments');
  },
  async templates(): Promise<Template[]> { return must(await supabase.from('customer_app_templates').select('*').order('created_at', { ascending: false }), 'Load templates'); },
  async saveTemplate(name: string, description: string, config: LayoutConfig): Promise<Template> {
    return must(await supabase.from('customer_app_templates').insert({ name, description: description || null, config }).select('*').single(), 'Save template');
  },
  async deleteTemplate(id: string) { must(await supabase.from('customer_app_templates').delete().eq('id', id), 'Delete template'); },
  async staff(): Promise<StaffRow[]> { return must(await supabase.rpc('customer_app_staff'), 'Load staff'); },
  async setRole(userId: string, role: AppRole | null) { must(await supabase.rpc('customer_app_set_role', { p_user: userId, p_role: role }), 'Change role'); },
  async uploadImage(file: File): Promise<string> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Only PNG, JPEG or WebP images can be uploaded');
    if (file.size > 2 * 1024 * 1024) throw new Error('Image must be 2 MB or smaller');
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    must(await supabase.storage.from('customer-app-assets').upload(path, file, { contentType: file.type, upsert: false }), 'Upload image');
    return supabase.storage.from('customer-app-assets').getPublicUrl(path).data.publicUrl;
  },
};

// ---------------------------------------------------------------- database data sources (allow-listed views)
interface SourceRow { id: string; label: string; description: string | null; schema_name: string; view_name: string; columns: ColumnDef[]; audience: 'authenticated' | 'staff'; max_rows: number; enabled: boolean }
const toSource = (r: SourceRow): SourceDef => ({ id: r.id, label: r.label, description: r.description ?? '', connection: 'db', schema: r.schema_name, table: r.view_name, columns: r.columns, scope: r.audience, enabled: r.enabled });
export interface AvailableView { schema_name: string; view_name: string; columns: ColumnDef[] }

export const dataSources = {
  /** Registered database sources (DEV APP staff; RLS). */
  async list(): Promise<SourceDef[]> {
    const r = await supabase.from('customer_app_data_sources').select('*').order('label');
    return (must(r, 'Load data sources') as SourceRow[]).map(toSource);
  },
  /** Views an administrator may register, with their columns read from the database catalogue (admins only). */
  async availableViews(): Promise<AvailableView[]> { return must(await supabase.rpc('customer_app_available_views'), 'Load database views'); },
  async save(s: { id: string; label: string; description: string; view: string; columns: ColumnDef[]; audience: 'authenticated' | 'staff'; enabled: boolean }) {
    must(await supabase.rpc('customer_app_save_source', { p_id: s.id, p_label: s.label, p_description: s.description || null, p_view: s.view, p_columns: s.columns, p_audience: s.audience, p_enabled: s.enabled }), 'Save data source');
    queryCache.clear();
  },
};

// Short-lived cache + in-flight de-duplication: many components on one page often ask for the same data.
const CACHE_MS = 60_000;
const queryCache = new Map<string, { at: number; p: Promise<QueryResult> }>();
/** Query an allow-listed database view through the customer_app_query RPC (server validates source, columns, operators). */
export function queryDb(q: { source: string; fields: string[]; filters: BindingFilter[]; sort: Binding['sort']; limit: number; search: string; agg: Binding['agg'] }): Promise<QueryResult> {
  const key = JSON.stringify(q);
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const p = (async () => {
    const r = await supabase.rpc('customer_app_query', {
      p_source: q.source, p_fields: q.fields, p_filters: q.filters, p_sort: q.sort, p_limit: q.limit, p_search: q.search || null, p_agg: q.agg,
    });
    if (r.error) throw new Error(r.error.message);
    const d = r.data as { columns: ColumnDef[] | null; rows: Record<string, unknown>[] | null };
    return { columns: d.columns ?? [], rows: d.rows ?? [] };
  })();
  queryCache.set(key, { at: Date.now(), p });
  p.catch(() => queryCache.delete(key)); // never cache failures
  if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value as string);
  return p;
}

/** What the customer app loads at start-up: the live layout of an app, or null (then the built-in layout is used). */
export async function fetchPublishedLayout(appId: string): Promise<{ versionId: string; versionNo: number; config: LayoutConfig } | null> {
  const r = await supabase.rpc('get_published_customer_layout', { p_app: appId });
  if (r.error || !r.data) return null;
  const d = r.data as { version_id: string; version_no: number; config: LayoutConfig };
  return { versionId: d.version_id, versionNo: d.version_no, config: d.config };
}

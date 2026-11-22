// Back office: Product categories. The central list every SKU points at (supabase/migrations/20261122110000_product_categories.sql): groups and categories,
// one level deep. Staff create, rename, describe, group and (de)activate categories here; nothing is ever deleted. Every change goes through a server function
// that checks the role again and writes the category audit log. Deactivating keeps the category on the products that already have it.
import { useMemo, useState } from 'react';
import { FolderPlus, Plus, RefreshCw } from 'lucide-react';
import { toast, useLang } from '../domain/store';
import { t as tl } from '../lib/i18n';
import { CategoryPatch, ProductCategory, categoryApi, categoryName, describeCategoryError, loadCategories, upsertCategory, useCategories } from '../lib/categoryApi';
import { DEMO_SEED } from '../domain/demo';
import { Badge, Banner, Button, Card, DataTable, Empty, Field, Input, Modal, NumInput, PageHead, Select, Switch, Textarea, Tx, useConfirm, useHas } from '../ui/kit';

type Form = { id: string | null; code: string; name_th: string; name_en: string; description: string; parent_id: string; is_group: boolean; sort_order: number };
const blank = (isGroup = false): Form => ({ id: null, code: '', name_th: '', name_en: '', description: '', parent_id: '', is_group: isGroup, sort_order: 100 });

export default function Categories() {
  const lang = useLang();
  const l = lang === 'en' ? 'en' : 'th';
  const canEdit = useHas('catalog:edit');
  const cats = useCategories(!DEMO_SEED);
  const confirm = useConfirm();
  const [show, setShow] = useState<'active' | 'inactive' | 'all'>('active');
  const [form, setForm] = useState<Form | null>(null);
  const byId = useMemo(() => new Map(cats.items.map((c) => [c.id, c])), [cats.items]);
  const groups = cats.items.filter((c) => c.is_group);
  // groups first, each followed by its categories, then categories without a group
  const ordered = useMemo(() => {
    const out: ProductCategory[] = [];
    const sort = (a: ProductCategory, b: ProductCategory) => a.sort_order - b.sort_order || a.name_th.localeCompare(b.name_th);
    for (const g of cats.items.filter((c) => c.is_group).sort(sort)) { out.push(g); out.push(...cats.items.filter((c) => c.parent_id === g.id).sort(sort)); }
    out.push(...cats.items.filter((c) => !c.is_group && !c.parent_id).sort(sort));
    return out.filter((c) => show === 'all' || (show === 'active' ? c.is_active : !c.is_active));
  }, [cats.items, show]);

  const toggle = async (c: ProductCategory, active: boolean) => {
    let reason = '';
    if (!active) {
      const r = await confirm({
        title: tl(lang, 'Deactivate "{name}"?', { name: categoryName(c, l) }),
        body: c.product_count ? tl(lang, '{n} products use this category. They keep it, but it can no longer be chosen for a product.', { n: c.product_count }) : tl(lang, 'It can no longer be chosen for a product. It can be activated again at any time.'),
        reason: tl(lang, 'Reason (kept in the category history)'), confirmLabel: tl(lang, 'Deactivate'),
      });
      if (!r.ok) return;
      reason = r.reason;
    }
    try { upsertCategory(await categoryApi.setActive(c.id, active, reason)); toast('success', tl(lang, active ? 'Category activated' : 'Category deactivated')); }
    catch (e) { toast('error', tl(lang, describeCategoryError(e))); }
  };

  if (DEMO_SEED || cats.status === 'missing') {
    return (<><PageHead title="Product categories" /><Banner tone="warn"><Tx>The central category list is not installed in the database yet. Products keep their current category until it is.</Tx></Banner></>);
  }
  return (
    <>
      <PageHead title="Product categories" desc="The one list of categories every product is filed under. Products choose from this list; nothing here is ever deleted."
        actions={<>
          <Button onClick={() => void loadCategories(true)}><RefreshCw size={14} />{' '}<Tx>Refresh</Tx></Button>
          {canEdit && <Button onClick={() => setForm(blank(true))}><FolderPlus size={14} />{' '}<Tx>New group</Tx></Button>}
          {canEdit && <Button variant="primary" onClick={() => setForm(blank(false))}><Plus size={14} />{' '}<Tx>New category</Tx></Button>}
        </>} />
      {cats.error && <div className="mb16"><Banner tone="bad">{tl(lang, cats.error)}</Banner></div>}
      <Card flush>
        <DataTable rows={ordered} rowKey={(c) => c.id} pageSize={50} onRow={canEdit ? (c) => setForm({ id: c.id, code: c.code, name_th: c.name_th, name_en: c.name_en ?? '', description: c.description ?? '', parent_id: c.parent_id ?? '', is_group: c.is_group, sort_order: c.sort_order }) : undefined}
          search={(c) => `${c.code} ${c.name_th} ${c.name_en ?? ''} ${c.description ?? ''} ${c.parent_id ? byId.get(c.parent_id)?.name_th ?? '' : ''}`}
          toolbar={<Select sm style={{ width: 'auto' }} value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label={tl(lang, 'Status')}>
            <option value="active">{tl(lang, 'Active')}</option><option value="inactive">{tl(lang, 'Inactive')}</option><option value="all">{tl(lang, 'All statuses')}</option></Select>}
          empty={<Empty title={cats.status === 'loading' ? 'Loading…' : 'No categories match'} hint="Create a category, or change the status filter." />}
          cols={[
            { key: 'n', header: 'Name', render: (c) => <div style={{ paddingLeft: c.parent_id ? 20 : 0 }}><b>{c.is_group ? '▸ ' : ''}{categoryName(c, l)}</b>{c.description && <div className="sub">{c.description}</div>}</div> },
            { key: 'code', header: 'Code', render: (c) => <span className="mono">{c.code}</span> },
            { key: 'type', header: 'Type', hideSm: true, render: (c) => <Badge tone={c.is_group ? 'info' : undefined}>{tl(lang, c.is_group ? 'Group' : 'Category')}</Badge> },
            { key: 'g', header: 'Group', hideSm: true, render: (c) => (c.parent_id ? categoryName(byId.get(c.parent_id) ?? c, l) : <span className="muted">—</span>) },
            { key: 'p', header: 'Products', num: true, render: (c) => (c.is_group ? <span className="muted">{cats.items.filter((x) => x.parent_id === c.id).reduce((s, x) => s + x.product_count, 0)}</span> : `${c.product_count}`) },
            { key: 's', header: 'Status', render: (c) => (
              <div className="row gap-8" onClick={(e) => e.stopPropagation()}>
                <Badge tone={c.is_active ? 'good' : 'warn'} dot>{tl(lang, c.is_active ? 'Active' : 'Inactive')}</Badge>
                {canEdit && <Switch checked={c.is_active} onChange={(v) => void toggle(c, v)} label={tl(lang, c.is_active ? 'Deactivate' : 'Activate')} />}
              </div>) },
          ]} />
      </Card>
      {form && <CategoryForm form={form} groups={groups} onClose={() => setForm(null)} />}
    </>
  );
}

function CategoryForm({ form, groups, onClose }: { form: Form; groups: ProductCategory[]; onClose: () => void }) {
  const lang = useLang();
  const [f, setF] = useState<Form>(form);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isNew = !f.id;
  const save = async () => {
    if (busy) return;
    if (isNew && !f.code.trim()) return setErr(tl(lang, 'Enter a code'));
    if (!f.name_th.trim()) return setErr(tl(lang, 'Enter the Thai name'));
    setBusy(true); setErr(null);
    const patch: CategoryPatch = { name_th: f.name_th.trim(), name_en: f.name_en.trim(), description: f.description.trim(), sort_order: f.sort_order || 100, is_group: f.is_group, parent_id: f.is_group ? null : f.parent_id || null };
    if (isNew) patch.code = f.code.trim();
    try {
      upsertCategory(await categoryApi.save(f.id, patch));
      toast('success', tl(lang, isNew ? 'Category created' : 'Category saved'));
      void loadCategories(true);
      onClose();
    } catch (e) { setErr(tl(lang, describeCategoryError(e))); } finally { setBusy(false); }
  };
  return (
    <Modal title={isNew ? (f.is_group ? 'New group' : 'New category') : f.is_group ? 'Edit group' : 'Edit category'} onClose={onClose}
      footer={<><Button onClick={onClose}><Tx>Cancel</Tx></Button><Button variant="primary" loading={busy} disabled={busy} onClick={save}><Tx>Save</Tx></Button></>}>
      {err && <div className="mb16"><Banner tone="bad">{err}</Banner></div>}
      <div className="form-grid">
        <Field label="Code" hint={isNew ? 'Letters A-Z, digits, space and . _ & / -. It never changes after saving.' : 'The code never changes.'}>
          <Input className="mono" value={f.code} readOnly={!isNew} aria-readonly={!isNew} maxLength={60} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Sort order" hint="Lower shows first"><NumInput value={f.sort_order} onChange={(n) => setF({ ...f, sort_order: Number.isFinite(n) ? n : 100 })} /></Field>
        <Field label="Name (Thai)"><Input value={f.name_th} maxLength={80} onChange={(e) => setF({ ...f, name_th: e.target.value })} /></Field>
        <Field label="Name (English)"><Input value={f.name_en} maxLength={80} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
        {!f.is_group && <Field label="Group" full><Select value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}><option value="">{tl(lang, 'No group')}</option>{groups.filter((g) => g.is_active || g.id === f.parent_id).map((g) => <option key={g.id} value={g.id}>{categoryName(g, lang === 'en' ? 'en' : 'th')}</option>)}</Select></Field>}
        <Field label="Description" full><Textarea rows={2} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <div className="muted mt8" style={{ fontSize: 12 }}>{tl(lang, f.is_group ? 'A group only groups categories: products are filed under its categories, never under the group itself.' : 'Products choose this category from a list on the Products page.')}</div>
    </Modal>
  );
}

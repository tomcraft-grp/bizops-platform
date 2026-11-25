import { useState } from 'react';
import { ClipboardList, Plus } from 'lucide-react';
import { useDB } from '../domain/store';
import { bomCost } from '../domain/bom';
import { Badge, Button, Card, DataTable, Empty, Select } from '../ui/kit';
import { qtyFmt } from '../lib/util';
import type { Bom } from '../domain/types';
import { bomListState, shownVersion } from './forms';
import { Cost, nameOf, prodOf, useMay, useT, type Go } from './parts';

export const TYPE_LABEL: Record<Bom['type'], string> = { manufacturing: 'Production BOM', packaging: 'Packing BOM', assembly: 'Assembly BOM', recipe: 'Recipe of a menu item' };
export const BOM_BADGE: Record<ReturnType<typeof bomListState>, { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | '' }> = { active: { label: 'BOM in use', tone: 'good' }, scheduled: { label: 'Starts later', tone: 'info' }, draft: { label: 'Draft only', tone: 'warn' }, inactive: { label: 'Not in use', tone: 'warn' }, archived: { label: 'Archived BOM', tone: '' } };
type View = 'current' | 'active' | 'scheduled' | 'draft' | 'inactive' | 'archived' | 'all';

export function NewBomButton({ go }: { go: Go }) { const T = useT(); return <Button variant="primary" onClick={() => go({ tab: 'boms', bom: 'new' })}><Plus size={15} /> {T('New BOM')}</Button>; }
export function BomList({ go, only }: { go: Go; only?: 'active' }) {
  const db = useDB(), T = useT(), may = useMay();
  const [view, setView] = useState<View>('current');
  const v0 = only ?? view;
  const rows = db.boms.map((b) => ({ b, v: shownVersion(b), state: bomListState(b) })).filter((r) => (v0 === 'all' ? true : v0 === 'current' ? r.state !== 'archived' : r.state === v0)).reverse();
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(r) => r.b.id} pageSize={14} onRow={(r) => go({ tab: 'boms', bom: r.b.id })} search={(r) => `${nameOf(db, r.b.productId)} ${prodOf(db, r.b.productId)?.sku ?? ''} ${r.b.name}`}
        toolbar={only ? undefined : <Select sm style={{ width: 'auto' }} value={view} onChange={(e) => setView(e.target.value as View)} aria-label={T('BOM status')}><option value="current">All but archived</option><option value="active">BOM in use</option><option value="scheduled">Starts later</option><option value="draft">Draft only</option><option value="inactive">Not in use</option><option value="archived">Archived BOM</option><option value="all">All BOMs</option></Select>}
        empty={!db.boms.length
          ? <Empty icon={<ClipboardList size={22} />} title="No BOM yet" hint="A BOM (bill of materials) says what goes into a product and how much of it. Create one for the first product you make." action={may.edit ? <NewBomButton go={go} /> : undefined} />
          : <Empty title="No BOM matches" hint="Clear the search or choose another status." />}
        cols={[
          { key: 'n', header: 'Product', sort: (r) => nameOf(db, r.b.productId), render: (r) => <><button type="button" className="linkish" onClick={(e) => { e.stopPropagation(); go({ tab: 'boms', bom: r.b.id }); }}>{nameOf(db, r.b.productId)}</button><div className="sub"><span className="mono">{prodOf(db, r.b.productId)?.sku}</span>{r.b.name !== nameOf(db, r.b.productId) ? ` · ${r.b.name}` : ''}</div></> },
          { key: 's', header: 'Status', render: (r) => <><Badge tone={BOM_BADGE[r.state].tone} dot>{BOM_BADGE[r.state].label}</Badge>{r.state !== 'draft' && r.b.versions.some((x) => x.status === 'draft') && <div className="sub">{T('New draft waiting')}</div>}</> },
          { key: 't', header: 'Kind of production', hideSm: true, render: (r) => T(TYPE_LABEL[r.b.type]) },
          { key: 'v', header: 'BOM version', num: true, render: (r) => <>v{r.v?.version}<div className="sub">{T('{n} versions', { n: r.b.versions.length })}</div></> },
          { key: 'y', header: 'Batch', num: true, hideSm: true, render: (r) => `${qtyFmt(r.v?.yieldQty ?? 0)} ${prodOf(db, r.b.productId)?.unit ?? ''}` },
          { key: 'c', header: 'Components in the BOM', num: true, hideSm: true, render: (r) => r.v?.components.length ?? 0 },
          ...(may.cost ? [{ key: 'u', header: 'Cost per unit today', num: true, render: (r: (typeof rows)[number]) => (r.v ? <Cost v={bomCost(db, r.v).perUnit} bold /> : null) }] : []),
        ]} />
    </Card>
  );
}

import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useDB } from '../domain/store';
import { Button, Empty, PageHead, Tabs } from '../ui/kit';
import { RoleBanner, useMay, useT, type Go } from './parts';
import { Overview } from './Overview';
import { BomList, NewBomButton } from './BomList';
import { BomPage, NewBom } from './BomEditor';
import { NewOrderButton, OrderForm, OrderTable } from './Orders';
import { OrderDetail } from './OrderDetail';
import { DOING, type Doing } from './OrderActions';
import { Consumption, HistoryTab, Receipts } from './DocTabs';
import { CostTab } from './CostTab';
import { UnsavedProvider } from './unsaved';

const TABS = ['overview', 'boms', 'orders', 'consumption', 'receipts', 'costs', 'history'] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { overview: 'Production overview', boms: 'BOM list', orders: 'Production orders', consumption: 'Material consumption', receipts: 'Finished goods receipts', costs: 'Cost & profit', history: 'History of production' };

/** Which tab, BOM or order is open is in the address, so a reload, the back button and a link all lead to the same place. */
export function ProductionScreens() {
  return <UnsavedProvider><Screens /></UnsavedProvider>;
}
function Screens() {
  const db = useDB(), T = useT(), may = useMay(), [sp, setSp] = useSearchParams();
  const go = useCallback<Go>((q) => setSp(q), [setSp]);
  const asked = sp.get('tab') as Tab, tab: Tab = TABS.includes(asked) ? asked : 'overview', bom = sp.get('bom'), order = sp.get('order'), doing = sp.get('do');
  // a phone shows three of the seven tabs: the open one is brought into view
  useEffect(() => { window.scrollTo({ top: 0 }); document.querySelector('.mfg .tabs button.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [tab, bom, order]);
  const detail = (tab === 'boms' && bom) || (tab === 'orders' && order);
  return (
    <div className="mfg">
      <PageHead title="BOM & production" desc="Make products from other products: what goes in (BOM), how many to make (production order), materials out of stock, finished goods into stock, and what it really cost."
        actions={detail ? undefined : <>{may.edit && (tab === 'overview' || tab === 'boms') && (tab === 'boms' ? <NewBomButton go={go} /> : <Button onClick={() => go({ tab: 'boms', bom: 'new' })}><Plus size={15} /> {T('New BOM')}</Button>)}{may.create && tab !== 'boms' && tab !== 'costs' && tab !== 'history' && <NewOrderButton go={go} />}</>} />
      <RoleBanner />
      <Tabs value={tab} onChange={(t) => go({ tab: t })} tabs={TABS.filter((t) => t !== 'costs' || may.cost).map((v) => ({ v, label: LABEL[v], count: v === 'boms' ? db.boms.length || '' : v === 'orders' ? db.productionOrders.length || '' : undefined }))} />
      {tab === 'overview' && <Overview go={go} />}
      {tab === 'boms' && (bom === 'new' ? (may.edit ? <NewBom go={go} /> : <NotAllowed />) : bom ? <BomPage key={bom} id={bom} go={go} /> : <BomList go={go} />)}
      {tab === 'orders' && (order === 'new' ? (may.create ? <OrderForm key="new" bom={bom ?? undefined} go={go} /> : <NotAllowed />)
        : order ? (sp.get('edit') && may.create && db.productionOrders.find((o) => o.id === order)?.status === 'draft' ? <OrderForm key={order} id={order} go={go} /> : <OrderDetail key={order + (doing ?? '')} id={order} go={go} doing={doing && doing in DOING ? (doing as Doing) : undefined} />)
          : <OrderTable go={go} tools />)}
      {tab === 'consumption' && <Consumption go={go} />}
      {tab === 'receipts' && <Receipts go={go} />}
      {tab === 'costs' && (may.cost ? <CostTab go={go} /> : <NotAllowed />)}
      {tab === 'history' && <HistoryTab go={go} />}
    </div>
  );
}
const NotAllowed = () => <Empty title="Your role does not include this" hint="Ask the owner to change your permissions in Team & access." />;

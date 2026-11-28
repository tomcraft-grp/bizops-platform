// LINE MAN delivery at checkout: WHERE the order goes, chosen from the customer's own address book (Account -> My delivery addresses), never typed again here.
// The default address is chosen for the customer; "Change" lists the others; "+ Add a delivery address" opens the address editor over the checkout and the
// new address is saved to the account and chosen for this order. An address that is not complete (an old row, a phone that is no longer valid) is shown with
// a warning and an Edit button, and the order waits until it is fixed.
import { useState, type ReactNode } from 'react';
import { MapPin, Pencil, Plus } from 'lucide-react';
import { cx } from '../../lib/util';
import type { SavedAddress } from '../api';
import { useT } from '../i18n';
import { ErrorBox } from '../ui';
import { DistanceLine, RouteState, Shop } from './DeliveryForm';
import { addressText } from './geo';

export const MAX_ADDRESSES = 10;

function Head({ a }: { a: SavedAddress }) {
  const t = useT();
  return <span className="dp-line"><MapPin size={15} aria-hidden /> <b>{a.label || t('ab.unnamed')}</b>{a.is_default && <span className="sp-pill info">{t('dl.default')}</span>}</span>;
}

export function ShipTo({ book, error, onRetry, selected, incomplete, onSelect, onAdd, onEdit, store, route, missing, children }: {
  /** the customer's saved addresses; null while loading */
  book: SavedAddress[] | null; error: unknown; onRetry: () => void;
  selected: SavedAddress | undefined;
  /** the chosen address cannot be used as it is (shown with a warning) */
  incomplete: boolean;
  onSelect: (a: SavedAddress) => void; onAdd: () => void; onEdit: (a: SavedAddress) => void;
  store: Shop; route: RouteState;
  /** the customer tried to order without an address: say so */
  missing: boolean;
  /** a typed address instead (only when the shop does not require a pin) */
  children?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const list = open || (!!book?.length && !selected && !children);
  return (
    <section className="sp-sec" data-testid="ship-to" aria-labelledby="ship-to-h">
      <div className="sp-sec-h">
        <h3 id="ship-to-h">{t('ck.shipTo')} <span className="bad" aria-hidden>*</span></h3>
        {!!book && book.length > 1 && selected && <button type="button" className="sp-link" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="ship-change">{open ? t('ck.close') : t('ck.change')}</button>}
      </div>
      {error != null && !book ? <ErrorBox message={t('ck.loadFail')} onRetry={onRetry} />
        : !book ? <div className="sp-list-skel" aria-busy="true" aria-label={t('ck.loading')}><i /></div>
          : (
            <>
              {!list && selected && (
                <div className={cx('dp-card', incomplete ? 'todo' : 'ok')} data-testid="ship-card" aria-invalid={incomplete || undefined}>
                  <div className="row between"><Head a={selected} /><button type="button" className="btn sm" onClick={() => onEdit(selected)} data-testid="ship-edit"><Pencil size={14} /> {t('ck.edit')}</button></div>
                  <div className="dp-line" data-testid="ship-recipient"><b>{selected.recipient_name}</b><span>{selected.recipient_phone}</span></div>
                  <div className="sp-text" data-testid="ship-address">{addressText(selected)}</div>
                  {selected.driver_note && <div className="dp-note-driver">{selected.driver_note}</div>}
                  <DistanceLine shop={store} pin={{ lat: selected.lat, lng: selected.lng }} route={route} />
                  {incomplete && <small className="bad" role="alert" data-testid="ship-incomplete">{t('ck.incomplete')}</small>}
                </div>
              )}
              {list && (
                <div className="dp-opts" role="radiogroup" aria-label={t('ck.choose')} data-testid="ship-list">
                  {book.map((a) => (
                    <div key={a.id} className={cx('dp-opt', selected?.id === a.id && 'on')}>
                      <button type="button" role="radio" aria-checked={selected?.id === a.id} className="dp-opt-pick" onClick={() => { onSelect(a); setOpen(false); }} data-testid="ship-option">
                        <span className="dp-radio" aria-hidden />
                        <span className="grow col gap-4"><Head a={a} /><small>{a.recipient_name} · {a.recipient_phone}</small><small className="muted">{addressText(a)}</small></span>
                      </button>
                      <button type="button" className="sp-iconbtn" aria-label={`${t('ck.edit')} ${a.label || t('ab.unnamed')}`} onClick={() => onEdit(a)}><Pencil size={15} /></button>
                    </div>
                  ))}
                </div>
              )}
              {!book.length && !children && <div className="dp-card todo" data-testid="ship-none"><span className="sp-note">{t('ck.none')}</span></div>}
              {children}
              {book.length < MAX_ADDRESSES
                ? <button type="button" className={cx('btn block', !book.length && !children && 'primary lg')} onClick={onAdd} data-testid="ship-add"><Plus size={16} /> {t('ck.add')}</button>
                : <div className="sp-note">{t('ab.limit')}</div>}
              {missing && <small className="bad" role="alert" data-testid="ship-missing">{t('ck.pickAddress')}</small>}
              {book.length > 0 && <div className="sp-note">{t('ck.manage')}</div>}
            </>
          )}
    </section>
  );
}

// One saved delivery address being added or edited: its name (Home, Office, ...), the place on the map, the details, who receives it, and whether it is the default.
// Used by "My delivery addresses" (a page) and by the checkout (a sheet over the checkout, so nothing the customer chose there is lost).
// Saving goes to the customer's address book in the database (shop_address_save: own rows only, at most 10, one default); the caller gets the saved row.
import { useState } from 'react';
import { X } from 'lucide-react';
import { toast } from '../../domain/store';
import { cx } from '../../lib/util';
import { SavedAddress, shop } from '../api';
import { validPhone } from '../format';
import { useT } from '../i18n';
import { errText } from '../ui';
import { Contact, DeliveryDraft, deliveryProblems, draftFromSaved, toDeliveryInput } from './deliveryDraft';
import { DeliveryForm, Shop, useDrivingRoute } from './DeliveryForm';

const QUICK = ['ab.quick.home', 'ab.quick.office', 'ab.quick.other'] as const;

/** The draft a new address starts from: the account's name and phone receive it, unless the account has none to offer (then the customer types them). */
export function newAddressDraft(contact: Contact): DeliveryDraft {
  return contact.name.trim() && validPhone(contact.phone) ? {} : { other: true, rname: contact.name.trim() || undefined, rphone: contact.phone || undefined };
}

/** What is saved: a saved address always has its own recipient (the account's details unless "somebody else" was ticked). Null while something is missing. */
export function addressToSave(draft: DeliveryDraft, contact: Contact) {
  const d: DeliveryDraft = { ...draft, other: true, rname: draft.other ? draft.rname : contact.name, rphone: draft.other ? draft.rphone : contact.phone };
  if (deliveryProblems(d, contact).length) return null;
  const input = toDeliveryInput(d, contact);
  if (!input) return null;
  const { route: _r, address_id: _a, ...data } = input; void _r; void _a;
  return data;
}

export function AddressEditor({ initial, contact, store, first, sheet, onSaved, onCancel }: {
  /** the address being edited; none = a new one */
  initial?: SavedAddress; contact: Contact; store: Shop;
  /** the customer has no address yet: this one becomes the default */
  first: boolean;
  /** shown over the checkout (a full-screen sheet) instead of as a page */
  sheet?: boolean;
  onSaved: (a: SavedAddress) => void; onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<DeliveryDraft>(() => (initial ? draftFromSaved(initial, contact) : newAddressDraft(contact)));
  const [label, setLabel] = useState(initial?.label ?? '');
  const [makeDefault, setMakeDefault] = useState(initial ? initial.is_default : first);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const route = useDrivingRoute(store, null);
  const blocked = touched && !addressToSave(draft, contact);

  const save = async () => {
    setTouched(true);
    const data = addressToSave(draft, contact);
    if (!data || busy) return;
    setBusy(true);
    try {
      const a = await shop.addresses.save(initial?.id ?? null, data, label.trim() || null, makeDefault || first || undefined);
      toast('success', t('ab.saved'));
      onSaved(a);
    } catch (e) { toast('error', errText(t, e)); } finally { setBusy(false); }
  };

  const title = initial ? t('ab.editTitle') : t('ab.newTitle');
  const form = (
    <>
      <div className="sp-form">
        <label>{t('ab.label')}<input value={label} maxLength={40} placeholder={t('ab.labelHint')} onChange={(e) => setLabel(e.target.value)} data-testid="ab-label" /></label>
        <div className="dp-chips" role="group" aria-label={t('ab.label')}>
          {QUICK.map((k) => <button key={k} type="button" className={cx('dp-chip', label === t(k) && 'on')} aria-pressed={label === t(k)} onClick={() => setLabel(t(k))}>{t(k)}</button>)}
        </div>
      </div>
      <DeliveryForm bare value={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} contact={contact} shop={store} touched={touched} required route={route} />
      {!first && !initial?.is_default && <label className="dp-check"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} data-testid="ab-default" /> {t('ab.setDefault')}</label>}
      {blocked && <small className="bad" role="alert" data-testid="ab-fix">{t('ab.fix')}</small>}
    </>
  );
  const button = <button type="button" className="btn primary lg block" disabled={busy} onClick={() => void save()} data-testid="ab-save">{busy ? '…' : t('ab.save')}</button>;

  if (sheet) {
    return (
      <div className="dp-sheet dp-editor" role="dialog" aria-modal="true" aria-label={title} data-testid="address-editor">
        <div className="dp-sheet-head">
          <h2>{title}</h2>
          <button type="button" className="sp-iconbtn" aria-label={t('common.close')} onClick={onCancel} data-testid="ab-cancel"><X size={18} /></button>
        </div>
        <div className="dp-sheet-body">{form}</div>
        <div className="dp-sheet-foot">{button}</div>
      </div>
    );
  }
  return <div className="col gap-12" data-testid="address-editor">{form}{button}</div>;
}

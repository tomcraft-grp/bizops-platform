// Delivery pin: "My delivery addresses" (Account tab). The customer's saved addresses with their pin: add, edit (move the pin), choose the default, delete.
// Changing or deleting a saved address never touches an order: an order keeps its own copy of where it was sent.
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from '../../domain/store';
import { cx } from '../../lib/util';
import { SavedAddress, shop } from '../api';
import { useSettings } from '../hooks';
import { useT } from '../i18n';
import { ConfirmSheet, ErrorBox, errText } from '../ui';
import { useAuth } from '../../auth/AuthProvider';
import { DeliveryDraft, deliveryProblems, draftFromSaved, toDeliveryInput } from './deliveryDraft';
import { DeliveryForm, useDrivingRoute } from './DeliveryForm';
import { addressText } from './geo';

export function AddressBook({ onBack }: { onBack: () => void }) {
  const t = useT();
  const { profile } = useAuth();
  const settings = useSettings();
  const [list, setList] = useState<SavedAddress[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [edit, setEdit] = useState<{ id: string | null; draft: DeliveryDraft; label: string; makeDefault: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<SavedAddress | null>(null);
  const store = settings?.store;
  const contact = { name: profile?.display_name ?? '', phone: profile?.phone ?? '' };
  const load = useCallback(() => { shop.addresses.list().then((l) => { setList(l); setError(null); }).catch((e) => setError(e)); }, []);
  useEffect(load, [load]);
  const route = useDrivingRoute(store, null);

  const start = (a?: SavedAddress) => { setTouched(false); setEdit(a ? { id: a.id, draft: draftFromSaved(a, contact), label: a.label ?? '', makeDefault: a.is_default } : { id: null, draft: {}, label: '', makeDefault: !list?.length }); };
  const save = async () => {
    if (!edit) return;
    setTouched(true);
    // a saved address always has its own recipient (the order form defaults to the contact details, here there are none to follow)
    const d: DeliveryDraft = { ...edit.draft, other: true, rname: edit.draft.other ? edit.draft.rname : contact.name, rphone: edit.draft.other ? edit.draft.rphone : contact.phone };
    const input = toDeliveryInput(d, contact);
    if (!input || deliveryProblems(d, contact).length) return;
    setBusy(true);
    try {
      const { route: _r, address_id: _a, ...data } = input; void _r; void _a;
      await shop.addresses.save(edit.id, data, edit.label.trim() || null, edit.makeDefault || undefined);
      toast('success', t('ab.saved')); setEdit(null); load();
    } catch (e) { toast('error', errText(t, e)); } finally { setBusy(false); }
  };
  const remove = async (a: SavedAddress) => {
    setBusy(true);
    try { await shop.addresses.remove(a.id); toast('success', t('ab.deleted')); setAsking(null); load(); } catch (e) { toast('error', errText(t, e)); setAsking(null); } finally { setBusy(false); }
  };
  const makeDefault = async (a: SavedAddress) => { try { await shop.addresses.setDefault(a.id); load(); } catch (e) { toast('error', errText(t, e)); } };

  const back = <button type="button" className="sp-back" onClick={edit ? () => setEdit(null) : onBack}><ArrowLeft size={18} /> {t('common.back')}</button>;
  if (edit && store) {
    return (
      <div className="sp-page" data-testid="address-editor">
        {back}
        <h2 className="sp-h2">{edit.id ? t('ab.editTitle') : t('ab.newTitle')}</h2>
        <div className="sp-form"><label>{t('ab.label')}<input value={edit.label} maxLength={40} placeholder={t('ab.labelHint')} onChange={(e) => setEdit({ ...edit, label: e.target.value })} data-testid="ab-label" /></label></div>
        <DeliveryForm bare value={edit.draft} onChange={(p) => setEdit({ ...edit, draft: { ...edit.draft, ...p } })} contact={contact} shop={store} touched={touched} required route={route} />
        <label className="dp-check"><input type="checkbox" checked={edit.makeDefault} onChange={(e) => setEdit({ ...edit, makeDefault: e.target.checked })} data-testid="ab-default" /> {t('ab.setDefault')}</label>
        <button type="button" className="btn primary lg block" disabled={busy} onClick={() => void save()} data-testid="ab-save">{t('ab.save')}</button>
      </div>
    );
  }
  return (
    <div className="sp-page" data-testid="address-book">
      {back}
      <h2 className="sp-h2">{t('ab.title')}</h2>
      <div className="sp-note">{t('ab.rowHint')}</div>
      {error && !list ? <ErrorBox message={errText(t, error)} onRetry={load} /> : !list ? <div className="sp-list-skel" aria-busy="true"><i /><i /></div> : (
        <>
          {!list.length && <div className="sp-note" data-testid="ab-empty">{t('ab.empty')}</div>}
          {list.map((a) => (
            <div key={a.id} className={cx('dp-addr', a.is_default && 'def')} data-testid="ab-item">
              <div className="dp-line"><MapPin size={15} aria-hidden /> <b>{a.label || t('ab.unnamed')}</b>{a.is_default && <span className="sp-pill info">{t('dl.default')}</span>}</div>
              <div className="sp-text">{addressText(a)}</div>
              <div className="dp-line muted">{a.recipient_name} · {a.recipient_phone}</div>
              <div className="dp-addr-actions">
                <button type="button" className="btn sm" onClick={() => start(a)} data-testid="ab-edit"><Pencil size={14} /> {t('ab.edit')}</button>
                {!a.is_default && <button type="button" className="btn sm" onClick={() => void makeDefault(a)} data-testid="ab-make-default"><Star size={14} /> {t('ab.makeDefault')}</button>}
                <button type="button" className="btn sm danger-outline" onClick={() => setAsking(a)} data-testid="ab-delete"><Trash2 size={14} /> {t('ab.delete')}</button>
              </div>
            </div>))}
          {list.length < 10
            ? <button type="button" className="btn primary block" disabled={!store} onClick={() => start()} data-testid="ab-add"><Plus size={16} /> {t('ab.add')}</button>
            : <div className="sp-note">{t('ab.limit')}</div>}
        </>
      )}
      {asking && <ConfirmSheet danger title={t('ab.deleteTitle')} body={<>{addressText(asking)}<br />{t('ab.deleteBody')}</>} confirmLabel={t('ab.delete')} cancelLabel={t('common.cancel')} busy={busy} onConfirm={() => void remove(asking)} onCancel={() => setAsking(null)} />}
    </div>
  );
}

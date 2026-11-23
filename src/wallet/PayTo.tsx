// "Where to send the money", shown outside the collapsible payment picker so it can never be hidden by it: the chosen bank account, or the PromptPay QR.
// A QR is only drawn from the text the database made for exactly the amount shown beside it; while it loads or when it fails there is no QR at all.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, ExternalLink, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { toast } from '../domain/store';
import { downloadBlob, renderQrCard } from '../finance/qrImage';
import { parseThaiQr } from '../lib/promptpay';
import { CheckoutQr, Fulfilment, shop, ShopError } from '../shop/api';
import { baht } from '../shop/format';
import { useShopLang, useT } from '../shop/i18n';
import { errText } from '../shop/ui';
import type { Bank } from './api';
import { copyableAccountNo, formatAccountNo } from './bank';
import { hostedQrLink, isInApp, openOutside, qrFileName, saveQr } from './qrSave';
import { BankBadge, bankInstructions, CopyButton } from './ui';

/** The chosen bank account: everything needed to make the transfer, with the copy button. */
export function PayToBank({ bank }: { bank: Bank }) {
  const t = useT();
  const lang = useShopLang();
  const ins = bankInstructions(bank, lang);
  return (
    <div className="wl-payto" data-testid="payto-bank" data-payto={bank.code}>
      <BankBadge bank={bank} />
      <div className="wl-card-main">
        <b>{lang === 'en' ? bank.bank_name_en : bank.bank_name_th} <small>({bank.code})</small></b>
        <span className="wl-no" data-testid="payto-account">{formatAccountNo(bank.account_no)}</span>
        <span className="wl-holder"><span className="wl-k">{t('bank.holder')}</span> {bank.account_name}</span>
        {ins && <span className="wl-ins">{ins}</span>}
        <div><CopyButton text={copyableAccountNo(bank.account_no)} label={t('bank.copy')} /></div>
      </div>
    </div>
  );
}

/** The payment QR as ONE picture, always black on white with the quiet zone scanners need (also in the dark theme). A picture (not a drawing) so that press and hold saves it. */
function QrPicture({ payload, label, hidden }: { payload: string; label: string; hidden: boolean }) {
  const t = useT();
  const [st, setSt] = useState<{ payload: string; src: string | null } | null>(null);
  useEffect(() => {
    let on = true;
    QRCode.toDataURL(payload, { margin: 4, width: 1024, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((src) => { if (on) setSt({ payload, src }); }).catch(() => { if (on) setSt({ payload, src: null }); });
    return () => { on = false; };
  }, [payload]);
  const cur = st?.payload === payload ? st : null;          // never the picture of an earlier QR
  if (!cur) return <div className="pq-plate pq-wait" aria-busy="true"><span>{t('qr.loading')}</span></div>;
  if (!cur.src) return <div className="pq-plate pq-wait" role="alert"><span>{t('qr.drawError')}</span></div>;
  return <div className="pq-plate qr-box">{!hidden && <img src={cur.src} alt={label} data-testid="pay-qr" draggable={false} />}</div>;
}

/** The last four digits of the receiving account, read from the QR itself: what the customer can compare with their banking app. */
const maskTarget = (s: string) => (s.length > 4 ? `••• ${s.slice(-4)}` : s);

/**
 * The payment card: one QR, the amount, who is paid, the status, how to pay and "save the picture". Before anything is shown the QR text itself is read: a wrong checksum or an amount
 * that is not the amount on the card means there is no QR (never a picture that would pay something else).
 */
export function QrPanel({ payload, amount, merchant, account, orderNo, reference, expires, expiresAt, fileId, onRetry, onOther }: {
  payload: string; amount: number; merchant?: string | null; account?: string | null; orderNo?: string; reference?: string; expires?: string; expiresAt?: string; fileId: string; onRetry?: () => void; onOther?: () => void;
}) {
  const t = useT();
  const lang = useShopLang();
  const read = parseThaiQr(payload);
  const good = !!read && read.crcOk && read.amount !== null && Math.round(read.amount * 100) === Math.round(amount * 100);
  const acct = [account && account !== merchant ? account : '', read?.target ? maskTarget(read.target) : ''].filter(Boolean).join(' · ');
  const name = merchant || account || '';
  const acctLine = merchant ? acct : read?.target ? maskTarget(read.target) : '';
  // the picture to save is made before the tap: a phone only shares or downloads while the tap is being handled
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let on = true; setFile(null); setSaved(false);
    if (good) renderQrCard({ payload, amount, merchant: name, account: acctLine || undefined, orderNo, ref: reference, expiresAt, lang })
      .then((b) => { if (on) setFile(new File([b], qrFileName(fileId), { type: 'image/png' })); }).catch(() => undefined);
    return () => { on = false; };
  }, [payload, amount, name, acctLine, orderNo, reference, expiresAt, lang, fileId, good]);
  const closeSheet = useCallback(() => setSheet(false), []);
  if (!good) return <QrProblem message={t('qr.errorHint')} onRetry={onRetry} onOther={onOther} />;
  const save = async () => {
    if (!file) return;
    setBusy(true);
    const r = await saveQr(file, downloadBlob);
    setBusy(false);
    if (r === 'downloaded' || r === 'shared') { setSaved(true); toast('success', t(r === 'downloaded' ? 'qr.downloaded' : 'qr.shared')); }
    else if (r === 'sheet') setSheet(true);
  };
  return (
    <>
    <div className="pq-card" data-testid="qr-panel">
      <div className="pq-head"><span className="pq-brand">{t('qr.brand')}</span><span className="pq-status"><i aria-hidden /> {t('qr.waiting')}</span></div>
      <b className="pq-title">{t('qr.title')}</b>
      <QrPicture payload={payload} label={t('qr.alt', { amount: baht(amount) })} hidden={sheet} />
      <div className="pq-amount"><span>{t('qr.amount')}</span><b data-testid="qr-amount">{baht(amount)}</b></div>
      <dl className="pq-rows">
        {name && <div><dt>{t('qr.recipient')}</dt><dd data-testid="qr-recipient">{name}</dd></div>}
        {acctLine && <div><dt>{t('qr.account')}</dt><dd className="mono">{acctLine}</dd></div>}
        {reference && <div><dt>{t('qr.ref')}</dt><dd className="mono">{reference}</dd></div>}
        {expires && <div><dt>{t('qr.until')}</dt><dd>{expires}</dd></div>}
      </dl>
      <button type="button" className="pq-save" disabled={busy || !file} onClick={() => void save()}>{saved ? <Check size={17} /> : <Download size={17} />} {t(saved ? 'qr.savedAgain' : 'qr.save')}</button>
      <button type="button" className="pq-link" disabled={!file} onClick={() => setSheet(true)}>{t('qr.cannotSave')}</button>
      <ol className="pq-steps"><li>{t('qr.step1')}</li><li>{t('qr.step2')}</li><li>{t('qr.step3')}</li></ol>
    </div>
    {/* beside the card, not inside it: the card is its own stacking context */}
    {sheet && file && <QrSheet file={file} alt={t('qr.alt', { amount: baht(amount) })} onClose={closeSheet} />}
    </>
  );
}

/** The picture full screen (the QR of the card is taken away meanwhile: there is only ever one on the screen). Press and hold saves it; in an in-app browser a real link is offered too. */
function QrSheet({ file, alt, onClose }: { file: File; alt: string; onClose: () => void }) {
  const t = useT();
  const inApp = isInApp(navigator.userAgent);
  const [src, setSrc] = useState<string | null>(null);
  const [link, setLink] = useState<string | null | undefined>(undefined);
  const closer = useRef<HTMLButtonElement>(null);
  useEffect(() => {          // a data: address, not blob: (in-app browsers save the first and often not the second)
    let on = true; const r = new FileReader();
    r.onload = () => { if (on) setSrc(String(r.result)); }; r.readAsDataURL(file);
    return () => { on = false; };
  }, [file]);
  useEffect(() => { let on = true; if (inApp) void hostedQrLink(file).then((l) => { if (on) setLink(l); }); return () => { on = false; }; }, [file, inApp]);
  useEffect(() => {
    closer.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sp-sheet pq-sheet" role="dialog" aria-modal="true" aria-label={t('qr.sheetTitle')} data-testid="qr-sheet" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sp-sheet-card">
        <h3>{t('qr.sheetTitle')}</h3>
        <p className="sp-note">{t('qr.hold')}</p>
        {src && <img src={src} alt={alt} className="pq-saved" data-testid="qr-saved" />}
        {inApp && link !== null && <button type="button" className="btn primary block" disabled={!link} onClick={() => link && openOutside(link)}><ExternalLink size={15} /> {t(link ? 'qr.outside' : 'qr.outsideWait')}</button>}
        {!inApp && <button type="button" className="btn primary block" onClick={() => { downloadBlob(file, file.name); toast('success', t('qr.downloaded')); }}><Download size={15} /> {t('qr.save')}</button>}
        <button type="button" ref={closer} className="btn block" onClick={onClose}>{t('common.close')}</button>
      </div>
    </div>
  );
}

/** No QR could be made: say so and offer the two ways on (try again, another method). Never a picture. */
export function QrProblem({ message, busy, onRetry, onOther }: { message: string; busy?: boolean; onRetry?: () => void; onOther?: () => void }) {
  const t = useT();
  return (
    <div className="wl-qr-err" role="alert" data-testid="qr-error">
      <b>{t('qr.error')}</b><span>{message}</span>
      <div className="row gap-6 wrap">
        {onRetry && <button type="button" className="btn sm" disabled={busy} onClick={onRetry}><RefreshCw size={14} /> {t('common.retry')}</button>}
        {onOther && <button type="button" className="btn sm" onClick={onOther}>{t('qr.other')}</button>}
      </div>
    </div>
  );
}

export function QrWaiting() {
  const t = useT();
  return <div className="pq-card" data-testid="qr-loading"><div className="pq-plate pq-wait" aria-busy="true"><span>{t('qr.loading')}</span></div></div>;
}

/**
 * The PromptPay QR of the cart that is about to be ordered. The database prices the cart and puts that total into the shop's own QR; when its amount is not the
 * total on the screen, nothing is shown and the prices are checked again, so a customer can never pay an amount that differs from what they are about to order.
 */
export function CheckoutQrPanel({ items, fulfilment, total, onStale, onOther }: {
  items: { sku_code: string; qty: number }[]; fulfilment: Fulfilment; total: number; onStale: () => void; onOther: () => void;
}) {
  const t = useT();
  const sig = JSON.stringify([items, fulfilment, total]);
  const [st, setSt] = useState<{ sig: string; qr: CheckoutQr | null; error: unknown } | null>(null);
  const [n, setN] = useState(0);
  const stale = useRef(onStale); stale.current = onStale;
  useEffect(() => {
    let on = true;
    setSt(null);
    shop.checkoutQr(items, fulfilment)
      .then((qr) => {
        if (!on) return;
        if (!qr?.qr_payload || Number(qr.amount) !== total) { setSt({ sig, qr: null, error: new ShopError('amount changed', 'PRICE_CHANGED') }); stale.current(); return; }
        setSt({ sig, qr, error: null });
      })
      .catch((error) => { if (on) setSt({ sig, qr: null, error }); });
    return () => { on = false; };
  }, [sig, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = st?.sig === sig ? st : null;
  if (!cur) return <QrWaiting />;
  if (!cur.qr) {
    const code = cur.error instanceof ShopError ? cur.error.code : '';
    return <QrProblem message={code === 'NETWORK' ? t('qr.errorNetwork') : code === 'ERROR' || !code ? t('qr.errorHint') : errText(t, cur.error)} onRetry={() => setN((x) => x + 1)} onOther={onOther} />;
  }
  return <QrPanel payload={cur.qr.qr_payload} amount={Number(cur.qr.amount)} merchant={cur.qr.merchant_name} account={cur.qr.account_label} fileId={`checkout-${cur.qr.amount}`} onRetry={() => setN((x) => x + 1)} onOther={onOther} />;
}

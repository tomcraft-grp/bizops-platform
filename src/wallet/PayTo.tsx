// "Where to send the money", shown outside the collapsible payment picker so it can never be hidden by it: the chosen bank account, or the PromptPay QR.
// A QR is only drawn from the text the database made for exactly the amount shown beside it; while it loads or when it fails there is no QR at all.
import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { toast } from '../domain/store';
import { downloadBlob, renderQrCard } from '../finance/qrImage';
import { CheckoutQr, Fulfilment, shop, ShopError } from '../shop/api';
import { baht } from '../shop/format';
import { useShopLang, useT } from '../shop/i18n';
import { errText } from '../shop/ui';
import type { Bank } from './api';
import { copyableAccountNo, formatAccountNo } from './bank';
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

/** A payment QR drawn as a picture, always black on white with the quiet zone scanners need (also in the dark theme). */
export function QrPicture({ payload, label }: { payload: string; label: string }) {
  const t = useT();
  const [st, setSt] = useState<{ payload: string; svg: string | null } | null>(null);
  useEffect(() => {
    let on = true;
    QRCode.toString(payload, { type: 'svg', margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((svg) => { if (on) setSt({ payload, svg }); }).catch(() => { if (on) setSt({ payload, svg: null }); });
    return () => { on = false; };
  }, [payload]);
  const cur = st?.payload === payload ? st : null;          // never the picture of an earlier QR
  if (!cur) return <div className="wl-qrbox wl-qrwait" aria-busy="true"><span>{t('qr.loading')}</span></div>;
  if (!cur.svg) return <div className="sp-note bad" role="alert">{t('qr.drawError')}</div>;
  return <div className="wl-qrbox qr-box" role="img" aria-label={label} data-testid="pay-qr" dangerouslySetInnerHTML={{ __html: cur.svg }} />;
}

/** The picture, the amount, the details and "save the picture" (customers cannot scan the phone they are holding: they save it and scan it from their photos). */
export function QrPanel({ payload, amount, merchant, reference, expires, expiresAt, invoiceNo, fileName }: {
  payload: string; amount: number; merchant?: string | null; reference?: string; expires?: string; expiresAt?: string; invoiceNo?: string; fileName: string;
}) {
  const t = useT();
  const lang = useShopLang();
  const [busy, setBusy] = useState(false);
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => { setImg(null); }, [payload]);
  useEffect(() => () => { if (img) URL.revokeObjectURL(img); }, [img]);
  const save = async () => {
    setBusy(true);
    try {
      const b = await renderQrCard({ payload, amount, ref: reference, merchant: merchant ?? '', invoiceNo, expiresAt, lang });
      downloadBlob(b, fileName);
      setImg(URL.createObjectURL(b));                        // LINE's in-app browser may ignore downloads: also show the picture so it can be pressed and held
    } catch { toast('error', t('qr.drawError')); } finally { setBusy(false); }
  };
  return (
    <div className="wl-qr-panel" data-testid="qr-panel">
      {merchant && <span className="wl-qr-to">{t('qr.payTo', { name: merchant })}</span>}
      <QrPicture payload={payload} label={t('qr.alt', { amount: baht(amount) })} />
      <b className="wl-qr-amt" data-testid="qr-amount">{baht(amount)}</b>
      {reference && <span className="wl-k mono">{t('qr.ref')} {reference}</span>}
      {expires && <span className="wl-k">{t('qr.until')} {expires}</span>}
      <button type="button" className="btn block" disabled={busy} onClick={() => void save()}><Download size={15} /> {t('qr.save')}</button>
      {img && <><img src={img} alt={t('qr.alt', { amount: baht(amount) })} className="wl-qr-saved" /><span className="sp-note">{t('qr.hold')}</span></>}
      <span className="sp-note">{t('qr.how')}</span>
    </div>
  );
}

/** No QR could be made: say so and offer the two ways on (try again, another method). Never a picture. */
export function QrProblem({ message, busy, onRetry, onOther }: { message: string; busy?: boolean; onRetry: () => void; onOther?: () => void }) {
  const t = useT();
  return (
    <div className="wl-qr-err" role="alert" data-testid="qr-error">
      <b>{t('qr.error')}</b><span>{message}</span>
      <div className="row gap-6 wrap">
        <button type="button" className="btn sm" disabled={busy} onClick={onRetry}><RefreshCw size={14} /> {t('common.retry')}</button>
        {onOther && <button type="button" className="btn sm" onClick={onOther}>{t('qr.other')}</button>}
      </div>
    </div>
  );
}

export function QrWaiting() {
  const t = useT();
  return <div className="wl-qr-panel" data-testid="qr-loading"><div className="wl-qrbox wl-qrwait" aria-busy="true"><span>{t('qr.loading')}</span></div></div>;
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
  return <QrPanel payload={cur.qr.qr_payload} amount={Number(cur.qr.amount)} merchant={cur.qr.merchant_name || cur.qr.account_label} fileName={`QR-${cur.qr.amount}.png`} />;
}

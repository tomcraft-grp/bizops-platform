import { useCallback, useEffect, useRef, useState } from 'react';
import { Fulfilment, Quote, shop, ShopSettings } from './api';
import { CartLine, toQuoteItems } from './cart';

/** The shop's public settings (open / delivery / shipping fee), cached for a short time. */
export function useSettings(): ShopSettings | null {
  const [s, setS] = useState<ShopSettings | null>(null);
  useEffect(() => { let on = true; shop.settings().then((v) => { if (on) setS(v); }).catch(() => undefined); return () => { on = false; }; }, []);
  return s;
}

/** The server's price check of the cart: lines, shipping, total and any item that cannot be ordered. Debounced; a late answer never overwrites a newer one. */
export function useQuote(lines: CartLine[], fulfilment: Fulfilment) {
  const [st, setSt] = useState<{ quote: Quote | null; loading: boolean; error: unknown }>({ quote: null, loading: false, error: null });
  const [tick, setTick] = useState(0);
  const req = useRef(0);
  const sig = JSON.stringify(toQuoteItems(lines)) + '|' + fulfilment;
  useEffect(() => {
    if (!lines.length) { req.current++; setSt({ quote: null, loading: false, error: null }); return; }
    const id = ++req.current;
    setSt((s) => ({ ...s, loading: true, error: null }));
    const h = setTimeout(() => {
      shop.quote(toQuoteItems(lines), fulfilment)
        .then((quote) => { if (id === req.current) setSt({ quote, loading: false, error: null }); })
        .catch((error) => { if (id === req.current) setSt((s) => ({ quote: s.quote, loading: false, error })); });
    }, 200);
    return () => clearTimeout(h);
  }, [sig, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = useCallback(() => setTick((x) => x + 1), []);
  // Coming back to the app (e.g. from the bank app after a transfer) on a phone often leaves the last price check half-finished: ask again, so the checkout
  // button is never stuck on "checking…" (FB-001019).
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible') setTick((x) => x + 1); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);
  return { ...st, refresh };
}

/** A value that follows `v` after it has been still for `ms` (search boxes). */
export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]);
  return d;
}

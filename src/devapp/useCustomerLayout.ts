import { useEffect, useState } from 'react';
import { devapp, fetchPublishedLayout } from './api';
import { LayoutConfig, normalizeLayout, validateLayout } from './schema';

export const CUSTOMER_APP_ID = 'line-liff';

export interface LoadedLayout { config: LayoutConfig; versionNo: number; preview: boolean; status?: string }

/**
 * The layout the customer app should use: the published one, or (staff only, via ?layout=<version id>) a
 * not-yet-published version for preview. Returns null when there is none, it fails to load, or it does not
 * validate. The app then falls back to its built-in layout, so a bad or missing config can never blank the app.
 */
export function useCustomerLayout(appId: string, previewId: string | null): { layout: LoadedLayout | null; loading: boolean } {
  const [state, setState] = useState<{ layout: LoadedLayout | null; loading: boolean }>({ layout: null, loading: true });
  useEffect(() => {
    let on = true;
    (async () => {
      let out: LoadedLayout | null = null;
      try {
        if (previewId) {
          const v = await devapp.version(previewId).catch(() => null); // RLS: only DEV APP staff can read it
          if (v && v.app_id === appId) out = { config: v.config, versionNo: v.version_no, preview: true, status: v.status };
        }
        if (!out) {
          const p = await fetchPublishedLayout(appId);
          if (p) out = { config: p.config, versionNo: p.versionNo, preview: false };
        }
        if (out && validateLayout(out.config).length) out = null;
        if (out) out = { ...out, config: normalizeLayout(out.config) };
      } catch { out = null; }
      if (on) setState({ layout: out, loading: false });
    })();
    return () => { on = false; };
  }, [appId, previewId]);
  return state;
}

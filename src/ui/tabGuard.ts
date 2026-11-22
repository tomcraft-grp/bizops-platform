// Detects another open tab of the back office on this computer. The local database is written as one whole object (domain/store.ts), so two tabs
// silently overwrite each other's receipts, orders and stock: the last tab to save wins. Until those records live in Supabase, the screen warns.
import { useEffect, useState } from 'react';

const CHANNEL = 'tc-backoffice-tabs';
type Msg = { t: 'hello' | 'here' | 'bye'; id: string };

/** The number of OTHER back-office tabs open in this browser (0 when BroadcastChannel is unavailable). */
export function useOtherTabs(enabled = true): number {
  const [others, setOthers] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') return undefined;
    const me = Math.random().toString(36).slice(2);
    const ch = new BroadcastChannel(CHANNEL);
    const add = (id: string) => setOthers((x) => (x.includes(id) ? x : [...x, id]));
    ch.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (!m || m.id === me) return;
      if (m.t === 'hello') { add(m.id); ch.postMessage({ t: 'here', id: me } satisfies Msg); }
      else if (m.t === 'here') add(m.id);
      else if (m.t === 'bye') setOthers((x) => x.filter((y) => y !== m.id));
    };
    ch.postMessage({ t: 'hello', id: me } satisfies Msg);
    const bye = () => { try { ch.postMessage({ t: 'bye', id: me } satisfies Msg); } catch { /* closing */ } };
    window.addEventListener('pagehide', bye);
    return () => { bye(); window.removeEventListener('pagehide', bye); ch.close(); };
  }, [enabled]);
  return others.length;
}

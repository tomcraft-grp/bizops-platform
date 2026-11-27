import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { UNSAFE_NavigationContext as NavigationContext } from 'react-router-dom';
import { useConfirm } from '../ui/kit';

// Asks before typed input is thrown away: a tab, a Back button, a link or the side menu (every navigation inside the app), another action on the same page,
// or closing the browser tab. The app uses a plain HashRouter, which has no blocker of its own, so the router's navigator is wrapped while these screens are open.
// The browser's own back button is not covered: the router has already moved when the browser tells about it.
interface Guard { mark: (id: string, dirty: boolean) => void; ask: () => Promise<boolean> }
const Ctx = createContext<Guard>({ mark: () => undefined, ask: async () => true });

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm(), { navigator } = useContext(NavigationContext);
  const dirty = useRef(new Set<string>()), asking = useRef(false), ask = useRef<() => Promise<boolean>>(async () => true);
  ask.current = async () => {
    if (!dirty.current.size) return true;
    if (asking.current) return false;
    asking.current = true;
    try {
      const r = await confirm({ title: 'Leave without saving?', body: 'What you typed here has not been saved.', confirmLabel: 'Leave without saving', danger: true });
      if (r.ok) dirty.current.clear();
      return r.ok;
    } finally { asking.current = false; }
  };
  useEffect(() => {
    const push = navigator.push, replace = navigator.replace;
    navigator.push = (...a) => { if (!dirty.current.size) push.apply(navigator, a); else void ask.current().then((ok) => { if (ok) push.apply(navigator, a); }); };
    navigator.replace = (...a) => { if (!dirty.current.size) replace.apply(navigator, a); else void ask.current().then((ok) => { if (ok) replace.apply(navigator, a); }); };
    const unload = (e: BeforeUnloadEvent) => { if (dirty.current.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { navigator.push = push; navigator.replace = replace; window.removeEventListener('beforeunload', unload); };
  }, [navigator]);
  const value = useMemo<Guard>(() => ({ mark: (id, d) => { if (d) dirty.current.add(id); else dirty.current.delete(id); }, ask: () => ask.current() }), []);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
/** Marks this form as changed. Call the returned function when it was saved, before leaving. */
export function useUnsaved(changed: boolean): () => void {
  const g = useContext(Ctx), id = useId();
  useEffect(() => { g.mark(id, changed); }, [g, id, changed]);
  useEffect(() => () => g.mark(id, false), [g, id]);
  return useCallback(() => g.mark(id, false), [g, id]);
}
/** true = nothing to lose, or the person chose to leave. */
export const useMayLeave = () => useContext(Ctx).ask;

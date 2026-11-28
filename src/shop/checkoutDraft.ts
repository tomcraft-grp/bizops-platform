// What the customer has filled in at checkout, kept while they move between the cart, the checkout and the other tabs, and (the text, not the slip
// picture) across a page reload: on a phone the customer leaves for the bank app to pay, and an in-app browser may reload the page meanwhile.
// It belongs to ONE signed-in user, it is never used for money (the database prices the order) and it is forgotten once the order is placed.
import { create } from 'zustand';
import type { Choice } from '../wallet/ui';
import type { Fulfilment } from './api';
import { type DeliveryDraft, parseDeliveryDraft } from './geo/deliveryDraft';

/** `preorder`: the customer chose "pick up later" (a pick-up order with `pickupAt`, the start of the chosen slot); the server re-checks the slot when the order is placed. */
export interface DraftText { name?: string; phone?: string; address?: string; note?: string; fulfilment?: Fulfilment; method?: Choice; slipWhen?: string; slipRef?: string; preorder?: boolean; pickupAt?: string;
  /** LINE MAN delivery: the saved address chosen for this order (`addressId`; the rest comes from the address book). Older drafts may hold a whole address. */
  delivery?: DeliveryDraft;
  /** the shop does not require a pin and the customer typed the address instead of choosing a saved one */
  addrTyped?: boolean }
/** The slip picture stays in memory only; `total` is the amount the customer was asked to transfer when they attached it. */
export interface DraftSlip { file: File; total: number }

const keyOf = (uid: string) => `tc.shop.draft:${uid}`;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Parse what sessionStorage holds. It is untrusted (an old build, hand-edited): anything odd is dropped. */
export function parseDraft(raw: string | null): DraftText {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const m = o.method as { kind?: unknown; id?: unknown } | null | undefined;
    const method: Choice | undefined = !m || typeof m !== 'object' ? undefined : m.kind === 'wallet' || m.kind === 'qr' ? { kind: m.kind } : m.kind === 'bank' && typeof m.id === 'string' ? { kind: 'bank', id: m.id } : undefined;
    const d: DraftText = {
      name: str(o.name, 100), phone: str(o.phone, 14), address: str(o.address, 400), note: str(o.note, 300), slipWhen: str(o.slipWhen, 20), slipRef: str(o.slipRef, 80),
      fulfilment: o.fulfilment === 'delivery' || o.fulfilment === 'pickup' ? o.fulfilment : undefined, method,
      preorder: o.preorder === true ? true : undefined, pickupAt: typeof o.pickupAt === 'string' && !isNaN(new Date(o.pickupAt).getTime()) ? o.pickupAt.slice(0, 40) : undefined,
      delivery: parseDeliveryDraft(o.delivery), addrTyped: o.addrTyped === true ? true : undefined,
    };
    return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as DraftText;
  } catch { return {}; }
}
const read = (uid: string): DraftText => { try { return parseDraft(sessionStorage.getItem(keyOf(uid))); } catch { return {}; } };

interface DraftState {
  uid: string | null; text: DraftText; slip: DraftSlip | null;
  /** Load the draft of the signed-in user (another user never sees it). */
  hydrate: (uid: string | null) => void;
  patch: (p: DraftText) => void;
  /** change some fields of the delivery location (the rest stays) */
  patchDelivery: (p: Partial<DeliveryDraft>) => void;
  /** start the delivery location again (or from a saved address) */
  setDelivery: (d: DeliveryDraft | undefined) => void;
  setSlip: (s: DraftSlip | null) => void;
  clear: () => void;
}
export const useCheckoutDraft = create<DraftState>((set, get) => ({
  uid: null, text: {}, slip: null,
  hydrate: (uid) => { if (get().uid !== uid) set({ uid, text: uid ? read(uid) : {}, slip: null }); },
  patch: (p) => {
    const text = { ...get().text, ...p }; const uid = get().uid;
    if (uid) { try { sessionStorage.setItem(keyOf(uid), JSON.stringify(text)); } catch { /* storage unavailable: the draft still works for this visit */ } }
    set({ text });
  },
  patchDelivery: (p) => get().patch({ delivery: { ...(get().text.delivery ?? {}), ...p } }),
  setDelivery: (d) => get().patch({ delivery: d }),
  setSlip: (slip) => set({ slip }),
  clear: () => { const uid = get().uid; if (uid) { try { sessionStorage.removeItem(keyOf(uid)); } catch { /* ignore */ } } set({ text: {}, slip: null }); },
}));

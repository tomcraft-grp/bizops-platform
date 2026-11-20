// Client for the server-side rewards: points, promotion packs, per-bill board picks and the three event boards, plus the SKU change feed.
// Everything is a Supabase RPC (SECURITY DEFINER, see supabase/migrations/20261121*_rewards_core / event_boards / sku_registry_sync). The browser never
// sends a point total, a right or a board state: it sends a request and shows the answer the server gives. Types here ARE the contract of
// docs/superpowers/plans/2026-11-21-rewards-boards-sku-sync.md; change them only together with the SQL.
import { rpc, ShopError, WRITE_TIMEOUT_MS } from '../shop/api';

export type RewardsErrorCode =
  | 'REWARDS_OFF' | 'BOARDS_OFF' | 'NOT_FOUND' | 'BAD_RULE' | 'INACTIVE_SKU' | 'BAD_PACK' | 'EVENT_NOT_ACTIVE' | 'BOARD_LOCKED'
  | 'NUMBER_OUT_OF_RANGE' | 'NUMBER_TAKEN' | 'NO_ENTITLEMENT' | 'LIMIT_REACHED' | 'HOLD_EXPIRED' | 'REASON_REQUIRED' | 'CONFIRM_MISMATCH'
  | 'RESET_CONFLICT' | 'INVALID_KEY' | 'KEY_REUSED' | 'FORBIDDEN' | 'NETWORK';
/** True when `e` is a ShopError carrying one of the given server codes. */
export const isRewardsError = (e: unknown, ...codes: RewardsErrorCode[]): e is ShopError => e instanceof ShopError && (codes as string[]).includes(e.code);

export interface CartItem { sku_code: string; qty: number }

// ------------------------------------------------------------------------------------------------ settings, rules, packs
export interface RewardsSettings { enabled: boolean; boards_enabled: boolean }
export type RuleKind = 'points' | 'board_pick';
export type RuleBasis = 'per_bill' | 'cumulative';
export interface Rule {
  id: string; kind: RuleKind; name: string; active: boolean; starts_at: string | null; ends_at: string | null;
  spend_step: number; reward_amount: number; basis: RuleBasis; max_per_order: number | null;
  category_codes: string[]; include_skus: string[]; exclude_skus: string[]; include_packs: boolean;
  only_profile_ids: string[] | null; event_id: string | null; board_slots: number[] | null;
  stats: { bills: number; granted: number };
}
export type RulePatch = Partial<Omit<Rule, 'id' | 'stats'>>;

export interface PackItem { sku_code: string; name: string; qty: number; status: 'active' | 'inactive' }
export interface Pack {
  pack_sku_code: string; name: string; price: number; status: 'active' | 'inactive'; active: boolean;
  eligible_value: number | null; points_per_pack: number | null; items: PackItem[]; sold_packs: number;
}
export type PackPatch = Partial<{ active: boolean; eligible_value: number | null; points_per_pack: number | null; price: number; name: string; items: { sku_code: string; qty: number }[] }>;

export interface SkuHit { sku_code: string; name: string; status: 'active' | 'inactive'; price: number | null; category: string; brand: string | null; is_pack: boolean; origin: 'import' | 'app' }

export interface PreviewLine { kind: RuleKind; name: string; eligible_amount: number; reward: number; next_reward_in: number | null }
export interface CartPreview { enabled: boolean; lines: PreviewLine[] }
export interface SimLine { rule_id: string; rule_name: string; kind: RuleKind; eligible_amount: number; reward: number; next_reward_in: number | null; note: string | null }

// ------------------------------------------------------------------------------------------------ customer view
export type BillState = 'counted' | 'waiting_payment' | 'taken_back';
export interface PickBill { order_id: string; order_no: string; created_at: string; eligible_amount: number; rights: number; state: BillState }
export interface PickSummary { rule_id: string; rule_name: string; event_id: string | null; earned: number; used: number; remaining: number; bills: PickBill[] }
export interface PointsEntry { at: string; points: number; kind: 'earn' | 'reverse' | 'adjust'; note: string | null; order_no: string | null }
export interface MySelection { id: string; event_id: string; board_id: string; board_name: string; number: number; status: 'reserved' | 'confirmed'; expires_at: string | null }
export interface MyRewards {
  enabled: boolean; boards_enabled: boolean; points: number; points_history: PointsEntry[]; picks: PickSummary[]; selections: MySelection[];
}
export interface ReviewItem { entitlement_id: string; profile_id: string; profile_name: string | null; rule_name: string; selection_id: string | null; board_name: string | null; number: number | null; since: string }
export interface AdminCustomerRewards extends MyRewards { profile: { id: string; name: string | null; phone: string | null }; needs_review: ReviewItem[] }

// ------------------------------------------------------------------------------------------------ events and boards
export type EventStatus = 'draft' | 'active' | 'paused' | 'closed';
export type BoardMode = 'exclusive' | 'shared';
export type BoardLock = 'open' | 'locked';
export interface Board { id: string; event_id: string; slot: 1 | 2 | 3; name: string; color: string; mode: BoardMode; state: BoardLock; rev: number; taken: number; total: number; last_reset_id: string | null }
export interface EventDoc {
  id: string; name: string; description: string | null; status: EventStatus; starts_at: string | null; ends_at: string | null;
  number_min: number; number_max: number; hold_minutes: number; max_per_customer: number | null; boards: Board[];
}
export type EventPatch = Partial<Omit<EventDoc, 'id' | 'boards'>>;
export interface Holder { selection_id: string; profile_id: string; name: string | null; phone_tail: string | null; status: 'reserved' | 'confirmed'; exclusive: boolean; at: string }
export interface BoardLogRow { at: string; actor_name: string | null; action: string; reason: string | null; detail: Record<string, unknown> }
export interface ResetRow { id: string; at: string; by_name: string | null; reason: string; returned_picks: boolean; affected: number; undone_at: string | null }
export interface AdminBoard { board: Board; numbers: { n: number; holders: Holder[] }[]; resets: ResetRow[]; log: BoardLogRow[] }

export type CellState = 'free' | 'taken' | 'mine' | 'shared';
export interface BoardCell { n: number; s: CellState; c: number }
export interface PublicBoard { id: string; slot: number; name: string; color: string; mode: BoardMode; state: BoardLock; rev: number; taken: number; numbers: BoardCell[] }
export interface Rights { earned: number; used: number; remaining: number }
export interface BoardState {
  event: { id: string; name: string; status: EventStatus; number_min: number; number_max: number; hold_minutes: number; starts_at: string | null; ends_at: string | null } | null;
  boards: PublicBoard[]; rights: Rights;
}
export interface BoardRevs { event_status: EventStatus | null; boards: { id: string; rev: number; state: BoardLock }[] }
export interface ClaimResult {
  replay: boolean; selection: { id: string; board_id: string; number: number; status: 'reserved' | 'confirmed'; expires_at: string | null }; board: PublicBoard; rights: Rights;
}

// ------------------------------------------------------------------------------------------------ SKU change feed
export interface RegistryRow {
  sku_code: string; legacy_sku_code: string | null; sku_category: 'FG' | 'RM' | 'WIP'; origin: 'import' | 'app'; name_full: string; brand: string | null;
  product_type: string | null; domain: string; pack_qty: number | null; unit_en: string | null; unit_th: string | null; barcode: string | null;
  status: 'active' | 'inactive'; cost_price: number | null; retail_price: number | null; selling_price: number | null; friend_price: number | null;
  wholesale_price: number | null; ecommerce_price: number | null; needs_review: boolean; review_notes: string | null; updated_at: string;
}
export interface SkuChanges { cursor: number; full: boolean; rows: RegistryRow[] }
export type SkuDetailsPatch = Partial<Pick<RegistryRow, 'name_full' | 'brand' | 'unit_th' | 'barcode' | 'cost_price' | 'selling_price' | 'retail_price' | 'ecommerce_price' | 'product_type' | 'pack_qty'>>;
export interface SkuChangeRow { id: number; at: string; sku_code: string; actor_name: string | null; changes: Record<string, { old: unknown; new: unknown }> }

// ------------------------------------------------------------------------------------------------ customer calls
export const rewards = {
  settings: () => rpc<RewardsSettings>('rw_settings_public'),
  mine: () => rpc<MyRewards>('rw_my_rewards'),
  previewCart: (items: CartItem[]) => rpc<CartPreview>('rw_preview_cart', { p_items: items }),
  boardRevs: (eventId?: string | null) => rpc<BoardRevs>('rw_board_rev', { p_event: eventId ?? null }),
  boardState: (eventId?: string | null) => rpc<BoardState>('rw_board_state', { p_event: eventId ?? null }),
  claim: (eventId: string, boardId: string, number: number, key: string) =>
    rpc<ClaimResult>('rw_claim_number', { p_event: eventId, p_board: boardId, p_number: number, p_key: key }, WRITE_TIMEOUT_MS),
  confirm: (selectionId: string) => rpc<Omit<ClaimResult, 'replay'>>('rw_confirm_selection', { p_selection: selectionId }, WRITE_TIMEOUT_MS),
};

// ------------------------------------------------------------------------------------------------ staff calls (the server re-checks every role)
export const rewardsAdmin = {
  saveSettings: (patch: Partial<RewardsSettings>) => rpc<RewardsSettings>('rw_admin_save_settings', { p_patch: patch }, WRITE_TIMEOUT_MS),
  rules: () => rpc<Rule[]>('rw_admin_rules'),
  saveRule: (id: string | null, patch: RulePatch) => rpc<Rule>('rw_admin_save_rule', { p_id: id, p_patch: patch }, WRITE_TIMEOUT_MS),
  setRuleActive: (id: string, active: boolean) => rpc<Rule>('rw_admin_set_rule_active', { p_id: id, p_active: active }, WRITE_TIMEOUT_MS),
  packs: () => rpc<Pack[]>('rw_admin_packs'),
  createPack: (key: string, name: string, price: number, items: { sku_code: string; qty: number }[], patch: PackPatch = {}) =>
    rpc<Pack>('rw_admin_create_pack', { p_key: key, p_name: name, p_price: price, p_items: items, p_patch: patch }, WRITE_TIMEOUT_MS),
  savePack: (packSku: string, patch: PackPatch) => rpc<Pack>('rw_admin_save_pack', { p_pack: packSku, p_patch: patch }, WRITE_TIMEOUT_MS),
  searchSkus: (q: string, onlyActive = true, limit = 20) => rpc<SkuHit[]>('rw_admin_sku_search', { p_q: q, p_only_active: onlyActive, p_limit: limit }),
  simulate: (items: CartItem[], profileId?: string | null) => rpc<SimLine[]>('rw_admin_simulate', { p_items: items, p_profile: profileId ?? null }),
  customer: (profileId: string) => rpc<AdminCustomerRewards>('rw_admin_customer', { p_profile: profileId }),
  adjustPoints: (profileId: string, points: number, reason: string) => rpc<number>('rw_admin_adjust_points', { p_profile: profileId, p_points: points, p_reason: reason }, WRITE_TIMEOUT_MS),
  resettle: (profileId?: string | null) => rpc<{ profiles: number; changed: number }>('rw_admin_resettle', { p_profile: profileId ?? null }, WRITE_TIMEOUT_MS),
  reviewQueue: () => rpc<ReviewItem[]>('rw_admin_review_queue'),
  resolveReview: (entitlementId: string, action: 'keep' | 'release', reason: string) =>
    rpc<ReviewItem[]>('rw_admin_resolve_review', { p_entitlement: entitlementId, p_action: action, p_reason: reason }, WRITE_TIMEOUT_MS),

  events: () => rpc<EventDoc[]>('rw_admin_events'),
  saveEvent: (id: string | null, patch: EventPatch) => rpc<EventDoc>('rw_admin_save_event', { p_id: id, p_patch: patch }, WRITE_TIMEOUT_MS),
  setEventStatus: (id: string, status: EventStatus, reason: string) => rpc<EventDoc>('rw_admin_set_event_status', { p_id: id, p_status: status, p_reason: reason }, WRITE_TIMEOUT_MS),
  saveBoard: (boardId: string, patch: Partial<Pick<Board, 'name' | 'color'>>) => rpc<Board>('rw_admin_save_board', { p_board: boardId, p_patch: patch }, WRITE_TIMEOUT_MS),
  board: (boardId: string) => rpc<AdminBoard>('rw_admin_board', { p_board: boardId }),
  log: (eventId: string, limit = 50, offset = 0) => rpc<BoardLogRow[]>('rw_admin_log', { p_event: eventId, p_limit: limit, p_offset: offset }),
  // Five separate operations, deliberately not one "update board" call (see the spec table). Each needs SUPER_ADMIN and a reason.
  lockBoard: (boardId: string, reason: string) => rpc<AdminBoard>('rw_board_lock', { p_board: boardId, p_reason: reason }, WRITE_TIMEOUT_MS),
  unlockBoard: (boardId: string, reason: string) => rpc<AdminBoard>('rw_board_unlock', { p_board: boardId, p_reason: reason }, WRITE_TIMEOUT_MS),
  setBoardMode: (boardId: string, mode: BoardMode, reason: string) => rpc<AdminBoard>('rw_board_set_mode', { p_board: boardId, p_mode: mode, p_reason: reason }, WRITE_TIMEOUT_MS),
  releaseSelection: (selectionId: string, reason: string) => rpc<AdminBoard>('rw_release_selection', { p_selection: selectionId, p_reason: reason }, WRITE_TIMEOUT_MS),
  resetBoard: (boardId: string, reason: string, returnPicks: boolean, confirmName: string) =>
    rpc<AdminBoard>('rw_board_reset', { p_board: boardId, p_reason: reason, p_return_picks: returnPicks, p_confirm: confirmName }, WRITE_TIMEOUT_MS),
  undoReset: (resetId: string, reason: string) => rpc<AdminBoard>('rw_board_undo_reset', { p_reset: resetId, p_reason: reason }, WRITE_TIMEOUT_MS),
};

export const skuFeed = {
  changesSince: (cursor: number | null) => rpc<SkuChanges>('sku_changes_since', { p_cursor: cursor }, 60_000),
  setStatus: (code: string, status: 'active' | 'inactive', reason: string) => rpc<RegistryRow>('sku_set_status', { p_code: code, p_status: status, p_reason: reason }, WRITE_TIMEOUT_MS),
  setDetails: (code: string, patch: SkuDetailsPatch) => rpc<RegistryRow>('sku_set_details', { p_code: code, p_patch: patch }, WRITE_TIMEOUT_MS),
  log: (code: string | null = null, limit = 50, offset = 0) => rpc<SkuChangeRow[]>('sku_change_log', { p_code: code, p_limit: limit, p_offset: offset }),
};

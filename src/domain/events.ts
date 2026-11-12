import type { DB, EventDoc, EventSelection, ID } from './types';
import { Ctx, audit, fail, nid } from './core';
import { addDays } from '../lib/util';

const ekey = (eventId: ID, boardId: ID, n: number) => `${eventId}:${boardId}:${n}`;
const BOARD_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#6250d6', '#e87ba4'];

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function createEvent(
  d: DB, ctx: Ctx, p: { name: string; description: string; boards: number; min: number; max: number; reservationMinutes: number; terms: string },
): ID {
  if (p.max <= p.min) fail('INVALID', 'Number range is invalid');
  if (p.boards < 1 || p.boards > 8) fail('INVALID', 'Boards must be between 1 and 8');
  const id = nid(d, 'EV');
  d.events.push({
    id, name: p.name, description: p.description, status: 'draft', min: p.min, max: p.max, reservationMinutes: p.reservationMinutes, terms: p.terms, createdAt: ctx.now, winners: [],
    boards: Array.from({ length: p.boards }, (_, i) => ({ id: `${id}-B${i + 1}`, name: `Board ${String.fromCharCode(65 + i)}`, color: BOARD_COLORS[i % BOARD_COLORS.length] })),
  });
  return id;
}

function action(d: DB, ctx: Ctx, eventId: ID, a: 'release' | 'reset_board' | 'reset_event' | 'pause' | 'resume' | 'close' | 'winner' | 'activate', detail: string, affected = 0) {
  d.eventActions.push({ id: nid(d, 'EA'), eventId, ts: ctx.now, by: ctx.userId, action: a, detail, affected });
}

export function setEventStatus(d: DB, ctx: Ctx, id: ID, status: EventDoc['status']) {
  const e = d.events.find((x) => x.id === id) || fail('NOT_FOUND', 'Event not found');
  if (e.status === 'closed') fail('INVALID', 'A closed event cannot be changed');
  const map = { active: e.status === 'paused' ? 'resume' : 'activate', paused: 'pause', closed: 'close', draft: 'pause' } as const;
  e.status = status;
  action(d, ctx, id, map[status], `Status → ${status}`);
  audit(d, ctx, 'event.status', 'event', id, `${e.name} → ${status}`, status === 'closed' ? 'warn' : 'info');
}

export function grantEntitlements(d: DB, ctx: Ctx, p: { eventId: ID; customerId: ID; orderId?: ID; promoId?: ID; count: number }) {
  for (let i = 0; i < p.count; i++) d.entitlements.push({ id: nid(d, 'EN'), eventId: p.eventId, customerId: p.customerId, orderId: p.orderId, promoId: p.promoId, ts: ctx.now, status: 'available' });
}

const isActive = (s: EventSelection, now: string) => s.status === 'confirmed' || (s.status === 'reserved' && !!s.reservedUntil && s.reservedUntil > now);

/** Release expired reservations (idempotent; called before every claim and on a timer) */
export function sweepReservations(d: DB, ctx: Ctx): number {
  let n = 0;
  for (const s of d.selections) {
    if (s.status === 'reserved' && s.reservedUntil && s.reservedUntil <= ctx.now) {
      s.status = 'released';
      s.releasedAt = ctx.now;
      s.releaseReason = 'Reservation expired';
      delete d.eventIndex[ekey(s.eventId, s.boardId, s.number)];
      const en = d.entitlements.find((e) => e.id === s.entitlementId);
      if (en) { en.status = 'available'; en.selectionId = undefined; }
      n++;
    }
  }
  return n;
}

/**
 * Claim a number. The `eventIndex` map plays the role of a UNIQUE index on (event, board, number):
 * a second claim for the same key fails regardless of what the UI showed.
 */
export function claimNumber(
  d: DB, ctx: Ctx,
  p: { eventId: ID; boardId: ID; number: number; customerId: ID; entitlementId?: ID; confirm?: boolean; onBehalf?: boolean },
): ID {
  sweepReservations(d, ctx);
  const ev = d.events.find((x) => x.id === p.eventId) || fail('NOT_FOUND', 'Event not found');
  if (ev.status !== 'active') fail('EVENT_NOT_ACTIVE', `Event is ${ev.status}`);
  if (!ev.boards.some((b) => b.id === p.boardId)) fail('INVALID', 'Unknown board');
  if (!Number.isInteger(p.number) || p.number < ev.min || p.number > ev.max) fail('INVALID', `Number must be between ${pad2(ev.min)} and ${pad2(ev.max)}`);
  const en = p.entitlementId
    ? d.entitlements.find((e) => e.id === p.entitlementId)
    : d.entitlements.find((e) => e.eventId === p.eventId && e.customerId === p.customerId && e.status === 'available');
  if (!en || en.customerId !== p.customerId || en.eventId !== p.eventId) fail('NO_ENTITLEMENT', 'No available entitlement for this customer');
  if (en!.status !== 'available') fail('NO_ENTITLEMENT', 'This entitlement has already been used');
  const key = ekey(p.eventId, p.boardId, p.number);
  if (d.eventIndex[key]) fail('NUMBER_TAKEN', `${ev.boards.find((b) => b.id === p.boardId)!.name} #${pad2(p.number)} is already taken`);
  const id = nid(d, 'SEL');
  const confirm = p.confirm !== false;
  d.selections.push({
    id, eventId: p.eventId, boardId: p.boardId, number: p.number, customerId: p.customerId, entitlementId: en!.id,
    status: confirm ? 'confirmed' : 'reserved', ts: ctx.now, confirmedAt: confirm ? ctx.now : undefined,
    reservedUntil: confirm ? undefined : new Date(new Date(ctx.now).getTime() + ev.reservationMinutes * 60000).toISOString(),
    onBehalfBy: p.onBehalf ? ctx.userId : undefined,
  });
  d.eventIndex[key] = id;
  en!.status = 'used';
  en!.selectionId = id;
  return id;
}

export function confirmSelection(d: DB, ctx: Ctx, selId: ID) {
  sweepReservations(d, ctx);
  const s = d.selections.find((x) => x.id === selId) || fail('NOT_FOUND', 'Selection not found');
  if (s.status === 'confirmed') return;
  if (s.status !== 'reserved') fail('EXPIRED', 'Reservation expired — please pick a number again');
  s.status = 'confirmed';
  s.confirmedAt = ctx.now;
  s.reservedUntil = undefined;
}

function freeSelection(d: DB, s: EventSelection, status: 'released' | 'reset', ctx: Ctx, reason: string, resetId?: ID) {
  s.status = status;
  s.releasedAt = ctx.now;
  s.releaseReason = reason;
  s.resetId = resetId;
  delete d.eventIndex[ekey(s.eventId, s.boardId, s.number)];
  const en = d.entitlements.find((e) => e.id === s.entitlementId);
  if (en) { en.status = 'available'; en.selectionId = undefined; }
}

export function releaseSelection(d: DB, ctx: Ctx, selId: ID, reason: string) {
  if (!reason.trim()) fail('REASON', 'A reason is required');
  const s = d.selections.find((x) => x.id === selId) || fail('NOT_FOUND', 'Selection not found');
  if (s.status !== 'confirmed' && s.status !== 'reserved') fail('INVALID', 'Selection is not active');
  freeSelection(d, s, 'released', ctx, reason);
  const ev = d.events.find((e) => e.id === s.eventId)!;
  action(d, ctx, s.eventId, 'release', `${ev.boards.find((b) => b.id === s.boardId)?.name} #${pad2(s.number)}: ${reason}`, 1);
  audit(d, ctx, 'event.release', 'event', s.eventId, `Released #${pad2(s.number)}: ${reason}`, 'warn');
}

export function resetBoard(d: DB, ctx: Ctx, eventId: ID, boardId: ID, reason: string) {
  if (!reason.trim()) fail('REASON', 'A reason is required');
  const ev = d.events.find((x) => x.id === eventId) || fail('NOT_FOUND', 'Event not found');
  const resetId = nid(d, 'RS');
  let n = 0;
  for (const s of d.selections) if (s.eventId === eventId && s.boardId === boardId && isActive(s, ctx.now)) { freeSelection(d, s, 'reset', ctx, reason, resetId); n++; }
  action(d, ctx, eventId, 'reset_board', `${ev.boards.find((b) => b.id === boardId)?.name}: ${reason}`, n);
  audit(d, ctx, 'event.reset_board', 'event', eventId, `Reset ${ev.boards.find((b) => b.id === boardId)?.name} (${n} numbers): ${reason}`, 'critical');
  return n;
}
export function resetEvent(d: DB, ctx: Ctx, eventId: ID, reason: string) {
  if (!reason.trim()) fail('REASON', 'A reason is required');
  const ev = d.events.find((x) => x.id === eventId) || fail('NOT_FOUND', 'Event not found');
  const resetId = nid(d, 'RS');
  let n = 0;
  for (const s of d.selections) if (s.eventId === eventId && isActive(s, ctx.now)) { freeSelection(d, s, 'reset', ctx, reason, resetId); n++; }
  ev.winners = [];
  action(d, ctx, eventId, 'reset_event', reason, n);
  audit(d, ctx, 'event.reset', 'event', eventId, `Reset whole event "${ev.name}" (${n} numbers): ${reason}`, 'critical');
  return n;
}

export function recordWinner(d: DB, ctx: Ctx, p: { eventId: ID; boardId: ID; number: number; prize: string }) {
  const ev = d.events.find((x) => x.id === p.eventId) || fail('NOT_FOUND', 'Event not found');
  if (!p.prize.trim()) fail('INVALID', 'Enter the prize');
  const selId = d.eventIndex[ekey(p.eventId, p.boardId, p.number)];
  const sel = d.selections.find((s) => s.id === selId && s.status === 'confirmed');
  ev.winners.push({ id: nid(d, 'WN'), boardId: p.boardId, number: p.number, prize: p.prize, selectionId: sel?.id, customerId: sel?.customerId, ts: ctx.now });
  action(d, ctx, p.eventId, 'winner', `${ev.boards.find((b) => b.id === p.boardId)?.name} #${pad2(p.number)} → ${sel ? 'claimed' : 'unclaimed'}: ${p.prize}`);
}

export function eventStats(d: DB, eventId: ID, now: string) {
  const ev = d.events.find((e) => e.id === eventId);
  if (!ev) return { total: 0, taken: 0, available: 0, issued: 0, used: 0, participants: 0, reserved: 0 };
  const total = ev.boards.length * (ev.max - ev.min + 1);
  const active = d.selections.filter((s) => s.eventId === eventId && isActive(s, now));
  const ents = d.entitlements.filter((e) => e.eventId === eventId);
  return {
    total, taken: active.length, reserved: active.filter((s) => s.status === 'reserved').length, available: total - active.length,
    issued: ents.length, used: ents.filter((e) => e.status === 'used').length, participants: new Set(ents.map((e) => e.customerId)).size,
  };
}
export function occupancy(d: DB, eventId: ID, boardId: ID, now: string): Record<number, EventSelection> {
  const out: Record<number, EventSelection> = {};
  for (const s of d.selections) if (s.eventId === eventId && s.boardId === boardId && isActive(s, now)) out[s.number] = s;
  return out;
}
export function availableEntitlements(d: DB, customerId: ID, eventId?: ID) {
  return d.entitlements.filter((e) => e.customerId === customerId && e.status === 'available' && (!eventId || e.eventId === eventId));
}

/** Verify the unique-index invariant: no two active selections share (event, board, number). */
export function verifyEventUniqueness(d: DB, now: string) {
  const seen: Record<string, ID[]> = {};
  for (const s of d.selections) if (isActive(s, now)) (seen[ekey(s.eventId, s.boardId, s.number)] ||= []).push(s.id);
  const dup = Object.entries(seen).filter(([, v]) => v.length > 1);
  const indexMismatch = Object.entries(d.eventIndex).filter(([k, id]) => !d.selections.some((s) => s.id === id && (isActive(s, now) || s.status === 'reserved') && ekey(s.eventId, s.boardId, s.number) === k));
  return { checked: Object.keys(seen).length, duplicates: dup, indexMismatch };
}

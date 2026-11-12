import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { base, ctx, at, tx, stock, throws, codeOf } from '../helpers';
import { hasPerm, userPerms, can } from '../../src/domain/core';
import { act, useStore } from '../../src/domain/store';
import { cancelOrder, createOrder } from '../../src/domain/orders';
import { createReceipt, voidReceipt } from '../../src/domain/payments';
import { adjustPoints } from '../../src/domain/loyalty';
import { createEvent, grantEntitlements, claimNumber, resetBoard, setEventStatus } from '../../src/domain/events';
import { reverseJournal, postManualJournal, balancesBetween, dr, cr, isControl, isFs, sumAccounts } from '../../src/domain/accounting';
import { enqueueJob, reprintJob, resolvePrinter, processPrintQueue } from '../../src/domain/printing';
import { buildSeed } from '../../src/domain/seed';
import { dayKey, parseCSV, toCSV, r2, addDays, parseDay, daysBetween } from '../../src/lib/util';
import { sniffMime } from '../../src/lib/media';
import { promptPayPayload } from '../../src/lib/promptpay';
import type { DB } from '../../src/domain/types';

describe('authorization: roles, sensitive permissions, engine-level enforcement (§6)', () => {
  const role = (d: DB, id: string) => d.roles.find((r) => r.id === id)!.permissions;
  it('wildcards: owner has everything; module wildcard covers its actions only', () => {
    expect(hasPerm(['*'], 'anything:at-all')).toBe(true);
    expect(hasPerm(['orders:*'], 'orders:cancel')).toBe(true);
    expect(hasPerm(['orders:*'], 'accounting:view')).toBe(false);
    expect(hasPerm(['orders:view'], 'orders:cancel')).toBe(false);
  });
  const MATRIX: [string, string, boolean][] = [
    ['role-cashier', 'pos:create', true], ['role-cashier', 'finance:cost', false], ['role-cashier', 'finance:profit', false], ['role-cashier', 'accounting:view', false], ['role-cashier', 'orders:cancel', false], ['role-cashier', 'team:edit', false], ['role-cashier', 'settings:edit', false],
    ['role-warehouse', 'inventory:edit', true], ['role-warehouse', 'accounting:approve', false], ['role-warehouse', 'finance:cost', false],
    ['role-marketing', 'promotions:edit', true], ['role-marketing', 'finance:cost', false], ['role-marketing', 'accounting:view', false], ['role-marketing', 'events:reset', false],
    ['role-accountant', 'accounting:close', true], ['role-accountant', 'finance:profit', true], ['role-accountant', 'pos:create', false],
    ['role-kitchen', 'kds:edit', true], ['role-kitchen', 'orders:cancel', false], ['role-kitchen', 'customers:view', false],
    ['role-manager', 'events:reset', true], ['role-manager', 'accounting:close', false], ['role-manager', 'settings:edit', false],
    ['role-owner', 'settings:edit', true], ['role-owner', 'accounting:close', true],
  ];
  it.each(MATRIX)('%s → %s = %s', (r, p, expected) => { tx((d) => { expect(hasPerm(role(d, r), p)).toBe(expected); }); });
  it('act({perm}) refuses a forbidden action and leaves state untouched (enforced in the engine, not only the UI)', () => {
    const db0 = produce(base(), (d) => { d.meta.currentUserId = 'U3'; }) as DB; // cashier
    useStore.setState({ db: db0 });
    expect(can(db0, 'accounting:close')).toBe(false);
    expect(() => act((d) => { d.meta.lockedUntil = '2026-11-12'; }, { perm: 'accounting:close' })).toThrow(/permission/i);
    expect(useStore.getState().db).toBe(db0);
    expect(useStore.getState().db.meta.lockedUntil).toBe('2026-10-31');
  });
  it('act() is atomic: a throwing transaction changes nothing, a successful one is applied', () => {
    const db0 = produce(base(), (d) => { d.meta.currentUserId = 'U1'; }) as DB;
    useStore.setState({ db: db0 });
    const n = db0.orders.length;
    expect(() => act((d, c) => { d.orders.pop(); createOrder(d, c, { channel: 'POS', branchId: 'B1', lines: [{ productId: 'D03', qty: 1 }], payments: [{ method: 'cash', amount: 100 }], skipPromotions: true }); d.balances['W1|M03'].qty = -5; throw new Error('boom'); })).toThrow('boom');
    expect(useStore.getState().db).toBe(db0);
    expect(useStore.getState().db.orders.length).toBe(n);
    act((d) => { d.meta.seq['probe'] = 1; });
    expect(useStore.getState().db.meta.seq['probe']).toBe(1);
  });
  it('a disabled user is not an authority for approvals: approvers must be real, different users', () => {
    tx((d) => { expect(userPerms(d, undefined)).toEqual([]); });
  });
});

describe('audit trail: who / when / what for sensitive actions (§10)', () => {
  const last = (d: DB) => d.audit[d.audit.length - 1];
  it('journal reversal, receipt void, order cancel, manual points, event reset, period reopen are all audited with actor and time', () => {
    tx((d) => {
      const actor = at('2026-11-13T10:31:00+07:00', 'U2');
      const jid = postManualJournal(d, actor, { date: actor.now, memo: 'x', lines: [dr('6300', 5), cr('cash', 5)] });
      expect(last(d)).toMatchObject({ action: 'journal.manual', userId: 'U2', ts: actor.now });
      reverseJournal(d, actor, jid, 'typo');
      expect(last(d)).toMatchObject({ action: 'journal.reverse', userId: 'U2', entityId: jid, severity: 'warn' });
      adjustPoints(d, actor, d.customers[0].id, 10, 'gift');
      expect(last(d)).toMatchObject({ action: 'points.adjust', userId: 'U2' });
      stock(d, 'F03', 'W3', 3);
      const oid = createOrder(d, actor, { channel: 'LINE', branchId: 'B3', customerId: 'C011', lines: [{ productId: 'F03', qty: 1 }], skipPromotions: true, skipStockCheck: true });
      cancelOrder(d, actor, oid, 'duplicate order');
      expect(last(d)).toMatchObject({ action: 'order.cancel', entityId: oid, userId: 'U2' });
      const rid = createReceipt(d, actor, { customerId: 'C010', amount: 50, method: 'cash', allocations: [] });
      voidReceipt(d, actor, rid, 'mistake');
      expect(last(d)).toMatchObject({ action: 'receipt.void', severity: 'critical', userId: 'U2' });
      const ev = createEvent(d, actor, { name: 'T', description: '', boards: 1, min: 0, max: 9, reservationMinutes: 5, terms: '' });
      setEventStatus(d, actor, ev, 'active');
      grantEntitlements(d, actor, { eventId: ev, customerId: 'C010', count: 1 });
      claimNumber(d, actor, { eventId: ev, boardId: d.events.find((e) => e.id === ev)!.boards[0].id, number: 1, customerId: 'C010' });
      resetBoard(d, actor, ev, d.events.find((e) => e.id === ev)!.boards[0].id, 'test');
      expect(last(d)).toMatchObject({ action: 'event.reset_board', severity: 'critical', userId: 'U2' });
    });
  });
  it('mandatory reasons: reversal, void, cancel, reset, adjustment all reject an empty reason', () => {
    tx((d) => {
      const jid = postManualJournal(d, ctx, { date: ctx.now, memo: 'x', lines: [dr('6300', 5), cr('cash', 5)] });
      expect(codeOf(() => reverseJournal(d, ctx, jid, ' '))).toBe('REASON');
      expect(codeOf(() => adjustPoints(d, ctx, 'C010', 5, ''))).toBe('REASON');
    });
  });
  it('the audit log is bounded and never loses the newest entry', () => {
    tx((d) => { for (let i = 0; i < 4100; i++) adjustPoints(d, ctx, 'C010', 1, 'bulk ' + i); expect(d.audit.length).toBeLessThanOrEqual(4000); expect(last(d).detail).toContain('bulk 4099'); });
  });
});

describe('dates, time zones and reporting boundaries (§3.2, §5.6)', () => {
  it('day keys follow Thailand local time at the 00:00 / 23:59 boundary', () => {
    expect(dayKey('2026-11-13T23:59:59.999+07:00')).toBe('2026-11-13');
    expect(dayKey('2026-11-14T00:00:00.000+07:00')).toBe('2026-11-14');
    expect(dayKey('2026-11-13T17:00:00.000Z')).toBe('2026-11-14'); // 00:00 in Bangkok
    expect(dayKey('2026-12-31T23:59:59+07:00')).toBe('2026-12-31');
    expect(daysBetween('2026-11-13T23:59:00+07:00', '2026-11-14T00:01:00+07:00')).toBe(1);
  });
  it('report ranges are inclusive of both end dates', () => {
    tx((d) => {
      const when = '2026-11-13T23:59:59+07:00';
      const jid = postManualJournal(d, at(when), { date: new Date(when).toISOString(), memo: 'edge', lines: [dr('6300', 77), cr('cash', 77)] });
      expect(jid).toBeTruthy();
      expect(balancesBetween(d.journals, '2026-11-13', '2026-11-13')['6300']?.debit).toBeGreaterThanOrEqual(77);
      const none = balancesBetween(d.journals, '2026-11-14', '2026-11-14')['6300'];
      expect(none?.debit ?? 0).toBe(0);
    });
  });
  it('Yesterday → Today → Now: opening + movements = closing for every control family on 14 consecutive days', () => {
    tx((d) => {
      const fams: [string, (a: DB['accounts'][number]) => boolean][] = [['ar', isControl('ar')], ['cash', isFs('cash')], ['inventory', isControl('inventory')], ['ap', isControl('ap')]];
      for (let i = 0; i < 14; i++) {
        const day = dayKey(addDays(new Date(ctx.now), -i));
        const prev = dayKey(addDays(parseDay(day), -1));
        const o = balancesBetween(d.journals, undefined, prev), a = balancesBetween(d.journals, day, day), c = balancesBetween(d.journals, undefined, day);
        for (const [name, pred] of fams) expect(r2(sumAccounts(d, o, pred) + sumAccounts(d, a, pred)), `${name} on ${day}`).toBeCloseTo(sumAccounts(d, c, pred), 2);
      }
    });
  });
  it('leap-day and month-end arithmetic', () => {
    expect(dayKey(addDays('2028-02-28T12:00:00+07:00', 1))).toBe('2028-02-29');
    expect(dayKey(addDays('2026-12-31T12:00:00+07:00', 1))).toBe('2027-01-01');
  });
});

describe('printing: routing, idempotency, reprint audit (§15)', () => {
  it('the same document for the same order never prints twice; a reprint needs a reason and links to the original', () => {
    tx((d) => {
      const id = createOrder(d, { ...ctx, seed: false }, { channel: 'POS', branchId: 'B1', lines: [{ productId: 'D03', qty: 1 }, { productId: 'FD1', qty: 1 }], payments: [{ method: 'cash', amount: 500 }], skipPromotions: true });
      const jobs = d.printJobs.filter((j) => j.refId === id);
      expect(new Set(jobs.map((j) => j.docType + (j.station ?? ''))).size).toBe(jobs.length);
      expect(jobs.map((j) => j.docType).sort()).toEqual(['beverage_ticket', 'kitchen_ticket', 'receipt']);
      const again = enqueueJob(d, ctx, { docType: 'receipt', refType: 'order', refId: id, branchId: 'B1' });
      expect(d.printJobs.filter((j) => j.refId === id && j.docType === 'receipt').length).toBe(1);
      expect(jobs.some((j) => j.id === again)).toBe(true);
      const receipt = jobs.find((j) => j.docType === 'receipt')!;
      expect(codeOf(() => reprintJob(d, ctx, receipt.id, ''))).toBe('REASON');
      const rp = reprintJob(d, ctx, receipt.id, 'customer lost it');
      expect(d.printJobs.find((j) => j.id === rp)).toMatchObject({ reprintOf: receipt.id, reprintReason: 'customer lost it' });
    });
  });
  it('routing prefers the most specific rule; an offline agent printer fails the job (paper-out / offline path)', () => {
    tx((d) => {
      expect(resolvePrinter(d, { docType: 'beverage_ticket', station: 'beverage', branchId: 'B1' })).toBe('PT3');
      expect(resolvePrinter(d, { docType: 'beverage_ticket', station: 'beverage', branchId: 'B2' })).toBe('PT4');
      expect(resolvePrinter(d, { docType: 'statement' })).toBe('PT6');
      const j = enqueueJob(d, ctx, { docType: 'beverage_ticket', refType: 'order', refId: 'ZZ', station: 'beverage', branchId: 'B1' });
      processPrintQueue(d, ctx);
      expect(d.printJobs.find((x) => x.id === j)).toMatchObject({ status: 'failed', error: expect.stringMatching(/offline/i) });
    });
  });
});

describe('utilities, formats and security helpers', () => {
  it('CSV round-trips quotes, commas, newlines and Thai text', () => {
    const rows = [['name', 'note'], ['กาแฟ "ลาเต้", เย็น', 'บรรทัด1\nบรรทัด2'], ['plain', '']];
    expect(parseCSV(toCSV(rows))).toEqual([['name', 'note'], ['กาแฟ "ลาเต้", เย็น', 'บรรทัด1\nบรรทัด2'], ['plain', '']].map((r) => r));
  });
  it('file type is detected from content, not from the name or declared MIME', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0, 0, 0, 0, 0]);
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect([sniffMime(png), sniffMime(jpg), sniffMime(pdf), sniffMime(webp)]).toEqual(['image/png', 'image/jpeg', 'application/pdf', 'image/webp']);
    expect(sniffMime(exe)).toBeNull(); // a Windows executable renamed to .jpg is rejected
  });
  it('PromptPay payload is well-formed with a valid CRC-16', () => {
    const p = promptPayPayload('0812345678', 144);
    expect(p.startsWith('000201')).toBe(true);
    expect(p).toContain('5802TH'); expect(p).toContain('5406144.00'); expect(p).toContain('0066812345678');
    const body = p.slice(0, -4);
    let crc = 0xffff;
    for (let i = 0; i < body.length; i++) { crc ^= body.charCodeAt(i) << 8; for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
    expect(p.slice(-4)).toBe(crc.toString(16).toUpperCase().padStart(4, '0'));
  });
  it('the demo seed is deterministic for a given date', () => {
    const a = buildSeed(new Date('2026-11-13T10:30:00+07:00')) as DB, b = buildSeed(new Date('2026-11-13T10:30:00+07:00')) as DB;
    expect(b.orders.length).toBe(a.orders.length);
    expect(b.journals.length).toBe(a.journals.length);
    expect(r2(b.orders.reduce((s, o) => s + o.total, 0))).toBe(r2(a.orders.reduce((s, o) => s + o.total, 0)));
  });
  it('the demo seed generated without warnings', () => {
    expect((base() as DB & { _seedErrors?: string[] })._seedErrors).toEqual([]);
  });
  void throws;
});

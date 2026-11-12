import { describe, expect, it } from 'vitest';
import { base, ctx, tx, codeOf } from '../helpers';
import { hasPerm, userPerms } from '../../src/domain/core';
import { closePeriod, reopenPeriod } from '../../src/domain/accounting';
import { completeProduction, cancelProduction } from '../../src/domain/bom';
import { setEventStatus } from '../../src/domain/events';
import { closeTransferShort, startCount } from '../../src/domain/inventory';
import { cancelOrder, returnOrder } from '../../src/domain/orders';
import { applyCredit, approveSlip, createReceipt, createSettlement, receiveSettlement, rejectSlip, voidReceipt } from '../../src/domain/payments';
import { cancelPO, closePO, paySupplier } from '../../src/domain/purchasing';
import {
  approveDraft, approveOpening, approveSetup, decideMapping, deactivateAccount, importCoaRows, proposeMapping, rejectDraft, reopenSetup, reviewOpening,
  saveAccount, saveDraft, saveOpeningSet, saveTaxCode, setMappingDirect, submitDraft,
} from '../../src/domain/setup';

import * as M_accounting from '../../src/domain/accounting';
import * as M_bom from '../../src/domain/bom';
import * as M_channels from '../../src/domain/channels';
import * as M_events from '../../src/domain/events';
import * as M_inventory from '../../src/domain/inventory';
import * as M_loyalty from '../../src/domain/loyalty';
import * as M_master from '../../src/domain/master';
import * as M_orders from '../../src/domain/orders';
import * as M_payments from '../../src/domain/payments';
import * as M_printing from '../../src/domain/printing';
import * as M_purchasing from '../../src/domain/purchasing';
import * as M_setup from '../../src/domain/setup';

// QA addendum §5 (security / authorization): the rule lives in the ENGINE, not only in the UI.
// Every guarded operation is called as every seeded user; the outcome must match the role definitions exactly.
type Fn = (...a: unknown[]) => unknown;
const GUARDED: [string, Fn, string][] = [
  ['closePeriod', closePeriod as Fn, 'accounting:close'], ['reopenPeriod', reopenPeriod as Fn, 'accounting:close'],
  ['completeProduction', completeProduction as Fn, 'production:create'], ['cancelProduction', cancelProduction as Fn, 'production:approve'],
  ['setEventStatus', setEventStatus as Fn, 'events:edit'],
  ['closeTransferShort', closeTransferShort as Fn, 'inventory:approve'], ['startCount', startCount as Fn, 'inventory:edit'],
  ['cancelOrder', cancelOrder as Fn, 'orders:cancel'], ['returnOrder', returnOrder as Fn, 'orders:cancel'],
  ['createReceipt', createReceipt as Fn, 'receivables:create'], ['applyCredit', applyCredit as Fn, 'receivables:create'], ['voidReceipt', voidReceipt as Fn, 'receivables:cancel'],
  ['approveSlip', approveSlip as Fn, 'receivables:approve'], ['rejectSlip', rejectSlip as Fn, 'receivables:approve'],
  ['createSettlement', createSettlement as Fn, 'receivables:approve'], ['receiveSettlement', receiveSettlement as Fn, 'receivables:approve'],
  ['cancelPO', cancelPO as Fn, 'purchasing:edit'], ['closePO', closePO as Fn, 'purchasing:edit'], ['paySupplier', paySupplier as Fn, 'purchasing:approve'],
  ['saveAccount', saveAccount as Fn, 'accounting:create'], ['deactivateAccount', deactivateAccount as Fn, 'accounting:create'], ['importCoaRows', importCoaRows as Fn, 'accounting:create'],
  ['saveTaxCode', saveTaxCode as Fn, 'accounting:create'], ['proposeMapping', proposeMapping as Fn, 'accounting:create'], ['saveDraft', saveDraft as Fn, 'accounting:create'],
  ['submitDraft', submitDraft as Fn, 'accounting:create'], ['saveOpeningSet', saveOpeningSet as Fn, 'accounting:create'],
  ['setMappingDirect', setMappingDirect as Fn, 'accounting:approve'], ['decideMapping', decideMapping as Fn, 'accounting:approve'], ['approveDraft', approveDraft as Fn, 'accounting:approve'],
  ['rejectDraft', rejectDraft as Fn, 'accounting:approve'], ['reviewOpening', reviewOpening as Fn, 'accounting:view'], ['approveOpening', approveOpening as Fn, 'accounting:approve'],
  ['approveSetup', approveSetup as Fn, 'accounting:approve'], ['reopenSetup', reopenSetup as Fn, 'accounting:approve'],
  ['addExpense', (M_accounting as unknown as Record<string, Fn>).addExpense, 'accounting:create'],
  ['createBom', (M_bom as unknown as Record<string, Fn>).createBom, 'production:edit'],
  ['newDraftVersion', (M_bom as unknown as Record<string, Fn>).newDraftVersion, 'production:edit'],
  ['updateDraft', (M_bom as unknown as Record<string, Fn>).updateDraft, 'production:edit'],
  ['activateVersion', (M_bom as unknown as Record<string, Fn>).activateVersion, 'production:approve'],
  ['createProductionOrder', (M_bom as unknown as Record<string, Fn>).createProductionOrder, 'production:create'],
  ['recordProduction', (M_bom as unknown as Record<string, Fn>).recordProduction, 'production:create'],
  ['mapSku', (M_channels as unknown as Record<string, Fn>).mapSku, 'channels:edit'],
  ['retryExternal', (M_channels as unknown as Record<string, Fn>).retryExternal, 'channels:edit'],
  ['importCSVRows', (M_channels as unknown as Record<string, Fn>).importCSVRows, 'channels:edit'],
  ['simulateSync', (M_channels as unknown as Record<string, Fn>).simulateSync, 'channels:edit'],
  ['createEvent', (M_events as unknown as Record<string, Fn>).createEvent, 'events:create'],
  ['grantEntitlements', (M_events as unknown as Record<string, Fn>).grantEntitlements, 'events:edit'],
  ['recordWinner', (M_events as unknown as Record<string, Fn>).recordWinner, 'events:edit'],
  ['resetBoard', (M_events as unknown as Record<string, Fn>).resetBoard, 'events:reset'],
  ['resetEvent', (M_events as unknown as Record<string, Fn>).resetEvent, 'events:reset'],
  ['postCount', (M_inventory as unknown as Record<string, Fn>).postCount, 'inventory:approve'],
  ['adjustPoints', (M_loyalty as unknown as Record<string, Fn>).adjustPoints, 'loyalty:edit'],
  ['fulfillRedemption', (M_loyalty as unknown as Record<string, Fn>).fulfillRedemption, 'loyalty:edit'],
  ['cancelRedemption', (M_loyalty as unknown as Record<string, Fn>).cancelRedemption, 'loyalty:edit'],
  ['updateOrg', (M_master as unknown as Record<string, Fn>).updateOrg, 'settings:edit'],
  ['saveProduct', (M_master as unknown as Record<string, Fn>).saveProduct, 'catalog:edit'],
  ['saveSupplier', (M_master as unknown as Record<string, Fn>).saveSupplier, 'purchasing:edit'],
  ['setKds', (M_orders as unknown as Record<string, Fn>).setKds, 'kds:edit'],
  ['kdsAllDone', (M_orders as unknown as Record<string, Fn>).kdsAllDone, 'kds:edit'],
  ['refundToCredit', (M_payments as unknown as Record<string, Fn>).refundToCredit, 'receivables:approve'],
  ['refundCash', (M_payments as unknown as Record<string, Fn>).refundCash, 'receivables:approve'],
  ['retryJob', (M_printing as unknown as Record<string, Fn>).retryJob, 'printing:edit'],
  ['reprintJob', (M_printing as unknown as Record<string, Fn>).reprintJob, 'printing:edit'],
  ['createPO', (M_purchasing as unknown as Record<string, Fn>).createPO, 'purchasing:create'],
  ['receiveGoods', (M_purchasing as unknown as Record<string, Fn>).receiveGoods, 'purchasing:edit'],
  ['returnToSupplier', (M_purchasing as unknown as Record<string, Fn>).returnToSupplier, 'purchasing:approve'],
  ['postMovement', (M_setup as unknown as Record<string, Fn>).postMovement, 'accounting:create'],
  ['reactivateAccount', (M_setup as unknown as Record<string, Fn>).reactivateAccount, 'accounting:create'],
  ['assignStageOwner', (M_setup as unknown as Record<string, Fn>).assignStageOwner, 'accounting:approve'],
];

describe('engine-level authorization (§5)', () => {
  const users = base().users;
  it('covers a meaningful set of operations and every seeded user', () => {
    expect(GUARDED.length).toBeGreaterThanOrEqual(60);
    expect(users.length).toBeGreaterThanOrEqual(10);
  });

  for (const [name, fn, perm] of GUARDED) {
    it(`${name} requires ${perm}: denied for roles without it, never denied for roles with it`, () => {
      const wrong: string[] = [];
      for (const user of users) {
        const allowed = hasPerm(userPerms(base(), user), perm);
        // dummy arguments are fine: the guard is the first statement, so a denied caller never reaches validation
        const code = tx((d) => codeOf(() => fn(d, { ...ctx, userId: user.id }, 'x', 'y', 'z')));
        if (!allowed && code !== 'FORBIDDEN') wrong.push(`${user.name} (${user.roleId}) was NOT denied (got ${code})`);
        if (allowed && code === 'FORBIDDEN') wrong.push(`${user.name} (${user.roleId}) was wrongly denied`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('a denied call changes nothing (no partial writes, no audit noise)', () => {
    tx((d) => {
      const before = JSON.stringify({ j: d.journals.length, a: d.audit.length, o: d.orders.length, p: d.slips.length });
      expect(codeOf(() => approveSlip(d, { ...ctx, userId: 'U5' }, 'any'))).toBe('FORBIDDEN');
      expect(codeOf(() => closePeriod(d, { ...ctx, userId: 'U3' }, '2026-11-01'))).toBe('FORBIDDEN');
      expect(JSON.stringify({ j: d.journals.length, a: d.audit.length, o: d.orders.length, p: d.slips.length })).toBe(before);
    });
  });

  it('an unknown or deactivated acting user is denied; only seeding mode bypasses the guard', () => {
    tx((d) => {
      expect(codeOf(() => closePeriod(d, { ...ctx, userId: 'U-NOBODY' }, '2026-11-01'))).toBe('FORBIDDEN');
      expect(codeOf(() => closePeriod(d, { ...ctx, userId: 'U-NOBODY', seed: true }, '2026-11-01'))).not.toBe('FORBIDDEN');
    });
  });

  it('the separation of duties is real: the cashier cannot approve money or touch the books; the accountant can', () => {
    tx((d) => {
      const cashier = { ...ctx, userId: 'U3' };
      for (const f of [() => approveSlip(d, cashier, 'x'), () => voidReceipt(d, cashier, 'x', 'r'), () => closePeriod(d, cashier, '2026-11-01'), () => decideMapping(d, cashier, 'x', true, 'n'), () => cancelOrder(d, cashier, 'x', 'r')]) {
        expect(codeOf(f)).toBe('FORBIDDEN');
      }
      const accountant = { ...ctx, userId: 'U9' };
      expect(codeOf(() => approveSlip(d, accountant, 'x'))).not.toBe('FORBIDDEN');
      expect(codeOf(() => closePeriod(d, accountant, '2026-11-01'))).not.toBe('FORBIDDEN');
    });
  });
});

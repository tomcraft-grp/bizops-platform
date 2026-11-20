// The rewards part of the fake backend (points, per-bill board picks, the three event boards). It mirrors the CONTRACT of
// docs/superpowers/plans/2026-11-21-rewards-boards-sku-sync.md, which the SQL migrations implement and test for real. This file proves the SCREENS only.
// Foundation stub: the customer-shop task fills it in. Unknown functions fall through to the other fakes.
import type { FakeShop } from './fakeBackend';
import { NOT_HANDLED } from './fakeWallet';

export class FakeRewards {
  constructor(public shop: FakeShop) {}
  rpc(_fn: string, _a: Record<string, unknown>): unknown { return NOT_HANDLED; }
}

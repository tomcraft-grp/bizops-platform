// Where a signed-out person goes back to after signing in: the whole link, including its query (a link from LINE such as #/shop-admin?order=<id>).
import { describe, expect, it } from 'vitest';
import { returnTo } from '../../src/auth/guards';

describe('returnTo', () => {
  it('keeps the query of a deep link', () => { expect(returnTo({ pathname: '/shop-admin', search: '?order=abc' })).toBe('/shop-admin?order=abc'); });
  it('a plain page stays as it is', () => { expect(returnTo({ pathname: '/payment-review', search: '' })).toBe('/payment-review'); });
});

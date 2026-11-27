// Which button the LINE members page shows for a row (src/lib/lineMemberAccess.ts): only what the database would allow. The database itself is tested by supabase/tests/backoffice_access.sql.
import { describe, expect, it } from 'vitest';
import { accessAction, accessMissing, ROLE_LABEL } from '../../src/lib/lineMemberAccess';

const me = { id: 'me', role: 'SUPER_ADMIN' as const };
const row = (over: Partial<{ id: string; role: 'USER' | 'ADMIN' | 'SUPER_ADMIN'; status: 'active' | 'disabled' }> = {}) => ({ id: 'm1', role: 'USER' as const, status: 'active' as const, ...over });

describe('accessAction', () => {
  it('a SUPER_ADMIN may give access to an active customer', () => { expect(accessAction(row(), me)).toBe('grant'); });
  it('and take it back from an ADMIN, whatever the ADMIN\'s status (a disabled ADMIN can still be taken back)', () => {
    expect(accessAction(row({ role: 'ADMIN' }), me)).toBe('revoke');
    expect(accessAction(row({ role: 'ADMIN', status: 'disabled' }), me)).toBe('revoke');
  });
  it('a disabled customer cannot be given access', () => { expect(accessAction(row({ status: 'disabled' }), me)).toBeNull(); });
  it('nobody changes a SUPER_ADMIN, and nobody changes themselves', () => {
    expect(accessAction(row({ role: 'SUPER_ADMIN' }), me)).toBeNull();
    expect(accessAction(row({ id: 'me', role: 'USER' }), me)).toBeNull();
  });
  it('only a SUPER_ADMIN gets a button: an ADMIN, a customer or nobody signed in gets none', () => {
    expect(accessAction(row(), { id: 'a', role: 'ADMIN' })).toBeNull();
    expect(accessAction(row(), { id: 'u', role: 'USER' })).toBeNull();
    expect(accessAction(row(), null)).toBeNull();
    expect(accessAction(row(), undefined)).toBeNull();
  });
});

describe('the table labels and the missing-migration test', () => {
  it('every role has a Thai label', () => { for (const r of ['USER', 'ADMIN', 'SUPER_ADMIN'] as const) expect(ROLE_LABEL[r]).toMatch(/[ก-๿]/); });
  it('a database without the function is recognised, any other error is not', () => {
    expect(accessMissing('Could not find the function public.line_member_set_access(p_grant, p_profile, p_reason) in the schema cache')).toBe(true);
    expect(accessMissing('PGRST202')).toBe(true);
    expect(accessMissing('SELF_CHANGE')).toBe(false);
    expect(accessMissing(undefined)).toBe(false);
  });
});

// Giving a LINE member back-office access (the ADMIN role) from the LINE members page. The database decides (line_member_set_access, migration 20261128110000): only a SUPER_ADMIN may,
// never for yourself or another SUPER_ADMIN, never for a disabled member or an account without a LINE id, and every change is written to the audit log. This file only decides which
// button the page shows, so the screen never offers what the database would refuse.
import type { ProfileRole } from '../auth/AuthProvider';

export interface AccessMember { id: string; role: ProfileRole; status: 'active' | 'disabled' }
export type AccessAction = 'grant' | 'revoke' | null;

/** The button for one row: give access to an active customer, take it back from an ADMIN, nothing for a SUPER_ADMIN, yourself, a disabled customer, or when you are not a SUPER_ADMIN. */
export function accessAction(m: AccessMember, me: { id: string; role: ProfileRole } | null | undefined): AccessAction {
  if (!me || me.role !== 'SUPER_ADMIN' || m.id === me.id) return null;
  if (m.role === 'SUPER_ADMIN') return null;
  if (m.role === 'ADMIN') return 'revoke';
  return m.status === 'active' ? 'grant' : null;
}

/** The label of a role in the members table. */
export const ROLE_LABEL: Record<ProfileRole, string> = { USER: 'ลูกค้า', ADMIN: 'หลังบ้าน (ADMIN)', SUPER_ADMIN: 'เจ้าของ (SUPER_ADMIN)' };

/** True when the database does not have the function yet (the migration is not applied): the page then says so instead of showing a raw error. */
export const accessMissing = (message: string | undefined): boolean => /could not find the function|schema cache|PGRST202/i.test(message ?? '');

import type { DB, ID, AuditEntry, User, Product, Customer, Order } from './types';

export interface Ctx {
  now: string;
  userId: ID;
  seed?: boolean; // seeding mode: no print jobs, no audit noise
}

export class AppError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AppError';
  }
}
export const fail = (code: string, msg: string): never => {
  throw new AppError(code, msg);
};

/** Sequence-based ids: deterministic, unique, human-friendly */
export function nid(d: DB, prefix: string): ID {
  const n = (d.meta.seq[prefix] = (d.meta.seq[prefix] || 0) + 1);
  return `${prefix}${n}`;
}
/** Document numbers e.g. ORD-000123 */
export function docNo(d: DB, prefix: string, pad = 6): string {
  const key = 'no:' + prefix;
  const n = (d.meta.seq[key] = (d.meta.seq[key] || 0) + 1);
  return `${prefix}-${String(n).padStart(pad, '0')}`;
}

export function audit(
  d: DB, ctx: Ctx, action: string, entity: string, entityId: string | undefined, detail: string,
  severity: AuditEntry['severity'] = 'info',
) {
  if (ctx.seed && severity === 'info') return;
  d.audit.push({ id: nid(d, 'AU'), ts: ctx.now, userId: ctx.userId, action, entity, entityId, detail, severity });
  if (d.audit.length > 4000) d.audit.splice(0, d.audit.length - 4000);
}

// ---------- lookups (throwing)
export function product(d: DB, id: ID): Product {
  return d.products.find((p) => p.id === id) || fail('NOT_FOUND', `Product ${id} not found`);
}
export function customer(d: DB, id: ID): Customer {
  return d.customers.find((p) => p.id === id) || fail('NOT_FOUND', `Customer ${id} not found`);
}
export function order(d: DB, id: ID): Order {
  return d.orders.find((p) => p.id === id) || fail('NOT_FOUND', `Order ${id} not found`);
}

// ---------- permissions
export const MODULES: { key: string; label: string; actions: string[] }[] = [
  { key: 'dashboard', label: 'Dashboard', actions: ['view'] },
  { key: 'pos', label: 'POS', actions: ['view', 'create', 'discount'] },
  { key: 'orders', label: 'Orders', actions: ['view', 'create', 'edit', 'cancel', 'export'] },
  { key: 'channels', label: 'Channels', actions: ['view', 'edit'] },
  { key: 'kds', label: 'Kitchen display', actions: ['view', 'edit'] },
  { key: 'customers', label: 'Customers', actions: ['view', 'create', 'edit', 'export'] },
  { key: 'receivables', label: 'Receivables & payments', actions: ['view', 'create', 'approve', 'cancel'] },
  { key: 'loyalty', label: 'Loyalty & rewards', actions: ['view', 'create', 'edit'] },
  { key: 'promotions', label: 'Promotions', actions: ['view', 'create', 'edit'] },
  { key: 'events', label: 'Events', actions: ['view', 'create', 'edit', 'reset'] },
  { key: 'catalog', label: 'Products', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'inventory', label: 'Inventory', actions: ['view', 'create', 'edit', 'approve'] },
  { key: 'purchasing', label: 'Purchasing', actions: ['view', 'create', 'edit', 'approve'] },
  { key: 'production', label: 'BOM & production', actions: ['view', 'create', 'edit', 'approve'] },
  { key: 'accounting', label: 'Accounting', actions: ['view', 'create', 'approve', 'close'] },
  { key: 'profit', label: 'Profit engine', actions: ['view'] },
  { key: 'reports', label: 'Reports', actions: ['view', 'export'] },
  { key: 'printing', label: 'Printing', actions: ['view', 'create', 'edit'] },
  { key: 'media', label: 'Media & documents', actions: ['view', 'create', 'edit', 'download'] },
  { key: 'team', label: 'Team & access', actions: ['view', 'edit'] },
  { key: 'settings', label: 'Settings', actions: ['view', 'edit'] },
  { key: 'system', label: 'System health', actions: ['view'] },
  { key: 'finance', label: 'Financial sensitivity', actions: ['cost', 'profit'] },
];

export function hasPerm(perms: string[], perm: string): boolean {
  if (perms.includes('*')) return true;
  if (perms.includes(perm)) return true;
  const [mod] = perm.split(':');
  return perms.includes(mod + ':*');
}
export function userPerms(d: DB, user?: User): string[] {
  if (!user) return [];
  return d.roles.find((r) => r.id === user.roleId)?.permissions ?? [];
}
export function currentUser(d: DB): User {
  return d.users.find((u) => u.id === d.meta.currentUserId) || d.users[0];
}
export function can(d: DB, perm: string): boolean {
  return hasPerm(userPerms(d, currentUser(d)), perm);
}
/**
 * Engine-level authorization: the SERVER-SIDE rule that must hold no matter which screen (or script) calls the function.
 * The acting user comes from ctx (not from the UI); seeding mode is the only bypass.
 */
export function guard(d: DB, ctx: Ctx, perm: string) {
  if (ctx.seed) return;
  const u = d.users.find((x) => x.id === ctx.userId);
  if (!u || !hasPerm(userPerms(d, u), perm)) fail('FORBIDDEN', `Your role does not have permission: ${perm}`);
}
export function requirePerm(d: DB, perm: string) {
  if (!can(d, perm)) fail('FORBIDDEN', `Your role does not have permission: ${perm}`);
}
